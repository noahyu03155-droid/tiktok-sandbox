import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { getMediaDir, getVideo, updateVideoRecord } from "@/lib/db";

export const dynamic = "force-dynamic";

// "AI dub (lip-sync)" — step 1 of 2. Generates a new voiceover from a
// storyboard node's script text (OpenAI TTS, reuses OPENAI_API_KEY) and
// kicks off a Sync.so lip-sync generation job that resyncs the node's
// video clip's mouth to that new audio. Step 2 (polling + download) lives
// in storyboard/dub/status/route.ts — a lip-sync generation can take a few
// minutes, too long to hold open a single request/response behind
// Railway's reverse proxy, so this just returns a jobId for the client to
// poll.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY isn't set — required to generate the new voiceover audio." },
      { status: 400 }
    );
  }
  const syncKey = process.env.SYNC_API_KEY;
  if (!syncKey) {
    return NextResponse.json(
      { error: "SYNC_API_KEY isn't set. Sign up at sync.so, create a key from the API Keys page in your dashboard, and add it as SYNC_API_KEY." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const nodeId = body?.nodeId;
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }

  const scriptIdx = video.generated_scripts.findIndex((s) => s.id === params.scriptId);
  if (scriptIdx === -1) return NextResponse.json({ error: "script not found" }, { status: 404 });
  const script = video.generated_scripts[scriptIdx];
  const board = script.storyboard;
  const nodeIdx = board?.nodes.findIndex((n) => n.id === nodeId) ?? -1;
  if (!board || nodeIdx === -1) {
    return NextResponse.json({ error: "This shot hasn't been saved to the storyboard yet — wait a moment for autosave and try again." },
      { status: 400 });
  }
  const node = board.nodes[nodeIdx];

  if (!node.clip) {
    return NextResponse.json({ error: "Attach a video clip to this shot first." }, { status: 400 });
  }
  if (node.clip.kind !== "video") {
    return NextResponse.json({ error: "AI dub needs a video clip with a visible face — this shot only has a still image." }, { status: 400 });
  }
  const text = (node.instruction || node.label || "").trim();
  if (!text) {
    return NextResponse.json({ error: "Write the line for this shot in its text box first — that's what gets spoken." }, { status: 400 });
  }

  // Prefer an explicit APP_URL over req.nextUrl.origin — same reasoning as
  // the Shopify OAuth install route: behind Railway's reverse proxy,
  // req.nextUrl.origin can resolve to an internal localhost:PORT instead
  // of the public domain, and Sync.so needs a URL it can actually fetch.
  const appUrl = (process.env.APP_URL || req.nextUrl.origin).replace(/\/$/, "");
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
    return NextResponse.json(
      { error: "Sync.so needs a publicly reachable URL for the clip and audio, but this app is only reachable at a local address. Set APP_URL to your public domain (e.g. your Railway URL)." },
      { status: 400 }
    );
  }

  try {
    // 1. Generate the new voiceover with OpenAI TTS.
    const openai = new OpenAI({ apiKey: openaiKey });
    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: text,
    });
    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    const mediaDir = getMediaDir();
    const dir = path.join(mediaDir, "storyboard", params.scriptId);
    fs.mkdirSync(dir, { recursive: true });
    const audioFilename = `${nodeId}-voice.mp3`;
    fs.writeFileSync(path.join(dir, audioFilename), audioBuffer);
    const audioUrl = `${appUrl}/api/media/storyboard/${params.scriptId}/${audioFilename}`;
    const videoUrl = `${appUrl}${node.clip.url}`;

    // 2. Kick off the Sync.so lip-sync generation job.
    const genRes = await fetch("https://api.sync.so/v2/generate", {
      method: "POST",
      headers: { "x-api-key": syncKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: [
          { type: "video", url: videoUrl },
          { type: "audio", url: audioUrl },
        ],
        model: "lipsync-2",
        options: { sync_mode: "cut_off" },
        outputFileName: `${nodeId}-dubbed`,
      }),
    });
    const genJson = await genRes.json().catch(() => ({}));
    if (!genRes.ok || !genJson?.id) {
      const msg = genJson?.message || genJson?.error || `Sync.so request failed (${genRes.status})`;
      throw new Error(msg);
    }

    // 3. Persist the job id so status polling (and a page refresh) can pick
    // it back up.
    const newNodes = board.nodes.map((n, i) =>
      i === nodeIdx ? { ...n, dub: { status: "generating" as const, jobId: genJson.id } } : n
    );
    const newScripts = video.generated_scripts.map((s, i) =>
      i === scriptIdx ? { ...s, storyboard: { ...board, nodes: newNodes } } : s
    );
    updateVideoRecord(params.id, { generated_scripts: newScripts });

    return NextResponse.json({ jobId: genJson.id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to start AI dub" }, { status: 500 });
  }
}
