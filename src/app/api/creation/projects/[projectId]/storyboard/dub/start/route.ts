import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir, updateCreationProject } from "@/lib/db";

export const dynamic = "force-dynamic";

// Same two-step "AI dub (lip-sync)" flow as the Video Analysis storyboard's
// dub/start route, keyed by projectId. Step 2 (polling + download) lives in
// storyboard/dub/status/route.ts.
export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

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

  const board = access.project.storyboard;
  const nodeIdx = board?.nodes.findIndex((n) => n.id === nodeId) ?? -1;
  if (!board || nodeIdx === -1) {
    return NextResponse.json(
      { error: "This shot hasn't been saved to the storyboard yet — wait a moment for autosave and try again." },
      { status: 400 }
    );
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

  const appUrl = (process.env.APP_URL || req.nextUrl.origin).replace(/\/$/, "");
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
    return NextResponse.json(
      { error: "Sync.so needs a publicly reachable URL for the clip and audio, but this app is only reachable at a local address. Set APP_URL to your public domain (e.g. your Railway URL)." },
      { status: 400 }
    );
  }

  try {
    const openai = new OpenAI({ apiKey: openaiKey });
    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: text,
    });
    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    const mediaDir = getMediaDir();
    const dir = path.join(mediaDir, "storyboard", params.projectId);
    fs.mkdirSync(dir, { recursive: true });
    const audioFilename = `${nodeId}-voice.mp3`;
    fs.writeFileSync(path.join(dir, audioFilename), audioBuffer);
    const audioUrl = `${appUrl}/api/media/storyboard/${params.projectId}/${audioFilename}`;
    const videoUrl = `${appUrl}${node.clip.url}`;

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

    const newNodes = board.nodes.map((n, i) =>
      i === nodeIdx ? { ...n, dub: { status: "generating" as const, jobId: genJson.id } } : n
    );
    updateCreationProject(params.projectId, { storyboard: { ...board, nodes: newNodes } });

    return NextResponse.json({ jobId: genJson.id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to start AI dub" }, { status: 500 });
  }
}
