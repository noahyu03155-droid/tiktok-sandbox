import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo, updateVideoRecord } from "@/lib/db";
import { extractAudio, transcribeAudio } from "@/lib/transcribe";
import { analyzeVideo } from "@/lib/analyze";
import { deriveShootingGuide, type ShootingGuideEntry } from "@/lib/shootingGuide";
import type { StoryboardNode, VideoStats } from "@/lib/types";

export const dynamic = "force-dynamic";

// "Breakdown into 6 stages" — for a card whose clip came from pasting a
// TikTok link (import-tiktok), runs the same Whisper transcription + Claude
// 6-stage funnel analysis the standalone Video Analysis feature uses, then
// splits the single clip into 6 new stage-tagged cards: one per funnel
// stage (Reaction / Hook / Pain Point / Product Intro / Desired Outcome /
// CTA), each trimmed to that stage's time range and pre-filled with the
// AI's summary + quote as a starting instruction to rewrite. The original
// big card is removed (replaced by the 6). Returns just the delta
// ({newNodes, newConnections}) — the client applies it onto its own local
// board state rather than replacing the whole board.

// Matches the canvas's card layout constants (NODE_W / GAP_X in
// src/components/StoryboardCanvas.tsx) so the 6 new cards land in a row
// with the same spacing addNode uses. Plain literals here — the canvas is
// a client component and this is a server route.
const NODE_W = 300;
const GAP_X = 70;

// A stage the AI marked as effectively absent (e.g. "no standalone
// reaction beat" comes back as start=end=0) still gets its card — just
// with no clip, since there's nothing meaningful to trim.
const MIN_STAGE_SEC = 0.3;

function mediaPathFromUrl(url: string): string | null {
  if (!url.startsWith("/api/media/")) return null;
  const rel = url.slice("/api/media/".length).split("/").filter(Boolean);
  const p = path.join(getMediaDir(), ...rel);
  if (!p.startsWith(getMediaDir())) return null; // path traversal guard
  return p;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (code === null && signal) {
        reject(new Error(`ffmpeg was killed mid-encode (signal ${signal}) — likely the server running out of memory.`));
        return;
      }
      reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-500)}`));
    });
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY isn't set — required for the Whisper transcription step of the breakdown (same key used elsewhere in the app)." },
      { status: 400 }
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY isn't set — required for the Claude 6-stage analysis step of the breakdown (same key used for video analysis)." },
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
    return NextResponse.json(
      { error: "This shot hasn't been saved to the storyboard yet — wait a moment for autosave and try again." },
      { status: 400 }
    );
  }
  const node = board.nodes[nodeIdx];

  if (node.clip?.source !== "tiktok") {
    return NextResponse.json({ error: "Breakdown is only available for a clip imported from a TikTok link." }, { status: 400 });
  }

  const videoPath = mediaPathFromUrl(node.clip.url);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return NextResponse.json(
      { error: "The imported TikTok video file couldn't be found on disk — try re-importing the link." },
      { status: 400 }
    );
  }

  const dir = path.dirname(videoPath);

  // Sidecar metadata written by import-tiktok at download time. Older
  // imports (from before the sidecar existed) won't have one — fall back
  // to empty metadata; the transcript alone still carries the analysis.
  let meta: {
    title: string;
    description: string;
    author: string;
    hashtags: string[];
    stats: VideoStats;
    duration_sec: number | null;
  } = {
    title: "",
    description: "",
    author: "",
    hashtags: [],
    stats: { play_count: null, digg_count: null, comment_count: null, share_count: null },
    duration_sec: null,
  };
  const metaPath = path.join(dir, `${nodeId}-tiktok.meta.json`);
  try {
    if (fs.existsSync(metaPath)) {
      meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, "utf-8")) };
    }
  } catch {
    // unreadable/corrupt sidecar — proceed with the empty fallback
  }

  const tmpDir = path.join(dir, `_breakdown_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const audioPath = path.join(tmpDir, `${nodeId}.mp3`);
    await extractAudio(videoPath, audioPath);
    const transcript = await transcribeAudio(audioPath);

    const analysis = await analyzeVideo({
      title: meta.title,
      description: meta.description,
      author: meta.author,
      hashtags: meta.hashtags,
      stats: meta.stats,
      duration_sec: meta.duration_sec,
      transcript_segments: transcript.segments,
    });

    // Nice-to-have on top of the breakdown: one extra lightweight Claude
    // call for per-stage filming guidance (angle/tone/pace), shown in each
    // card's Shooting Guide panel. Deliberately never fails the whole
    // breakdown — the 6 stage cards are the main value; if this call
    // errors, the new cards just ship without a pre-filled guide.
    let shootingGuides: Record<string, ShootingGuideEntry> | null = null;
    try {
      shootingGuides = await deriveShootingGuide(analysis.structure);
    } catch (guideErr) {
      console.error("deriveShootingGuide failed — continuing breakdown without a shooting guide:", guideErr);
    }

    const newNodes: StoryboardNode[] = [];
    for (let i = 0; i < analysis.structure.length; i++) {
      const stage = analysis.structure[i];
      const stageSec = stage.end_time - stage.start_time;
      let clip: StoryboardNode["clip"] = null;
      if (stageSec >= MIN_STAGE_SEC) {
        const filename = `${nodeId}-${stage.key}.mp4`;
        // -ss/-t as OUTPUT options (after -i) + re-encode instead of
        // stream-copy = accurate cut points, same convention as the render
        // route's trims.
        await runFfmpeg([
          "-y", "-i", videoPath,
          "-ss", String(stage.start_time), "-t", String(stageSec),
          "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
          path.join(dir, filename),
        ]);
        clip = { source: "tiktok", url: `/api/media/storyboard/${params.scriptId}/${filename}`, kind: "video" };
      }
      // Don't attach filming guidance for a stage the model left blank
      // (genuinely not present in this video, per analyze.ts's blank-stage
      // rule) — deriveShootingGuide still returns SOME text for every key
      // regardless, so this guards against a guide that isn't actually
      // grounded in anything real.
      const stagePresent = stage.summary.trim() !== "" || stage.quote.trim() !== "";
      const guide = stagePresent ? shootingGuides?.[stage.key] : undefined;
      newNodes.push({
        id: crypto.randomUUID(),
        label: stage.label,
        instruction: [stage.summary, stage.quote ? `"${stage.quote}"` : ""].filter(Boolean).join("\n\n"),
        x: node.x + i * (NODE_W + GAP_X),
        y: node.y,
        clip,
        stageTag: stage.key,
        // Coerced defensively — the guide comes straight from a JSON.parse
        // of model output, so a missing/odd-shaped entry becomes null/""
        // rather than poisoning the saved node.
        shootingGuide: guide
          ? { angle: String(guide.angle || ""), tone: String(guide.tone || ""), pace: String(guide.pace || "") }
          : null,
      });
    }

    const newConnections = newNodes.slice(0, -1).map((n, i) => ({
      id: crypto.randomUUID(),
      fromId: n.id,
      toId: newNodes[i + 1].id,
    }));

    const newBoard = {
      ...board,
      nodes: board.nodes.filter((n) => n.id !== nodeId).concat(newNodes),
      connections: board.connections.filter((c) => c.fromId !== nodeId && c.toId !== nodeId).concat(newConnections),
    };
    updateVideoRecord(params.id, {
      generated_scripts: video.generated_scripts.map((s, i) => (i === scriptIdx ? { ...s, storyboard: newBoard } : s)),
    });

    return NextResponse.json({ newNodes, newConnections });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Breakdown failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
