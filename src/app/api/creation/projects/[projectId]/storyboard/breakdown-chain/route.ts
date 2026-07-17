import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir, updateCreationProject, getUserById, updateUser } from "@/lib/db";
import { extractAudio, transcribeAudio } from "@/lib/transcribe";
import { analyzeVideo } from "@/lib/analyze";
import { deriveShootingGuide, type ShootingGuideEntry } from "@/lib/shootingGuide";
import { inferActionInsightTags, mergeInsightTags } from "@/lib/personalityInsights";
import { resolveStoryboardOrder, resolveConnectedChain } from "@/lib/storyboard";
import type { StoryboardNode, FunnelStageKey } from "@/lib/types";

export const dynamic = "force-dynamic";

// "Breakdown into chain" — the sibling of the single-card `breakdown` route,
// for a chain whose cards ALREADY EXIST (e.g. the 6 blank funnel-stage cards
// "Insert template" drops in, or any hand-wired sequence) rather than one
// raw TikTok-imported card waiting to be split. The user uploads a full
// reference video onto the chain's head card (via the normal /upload route,
// under a `${nodeId}__ref` filename so it doesn't collide with that card's
// own clip slot), then this route transcribes + runs the same 6-stage
// funnel analysis, and DISTRIBUTES the results onto the existing chain
// nodes instead of creating/deleting any node:
//   - a chain node whose stageTag matches a structure stage's key gets that
//     stage directly, regardless of position;
//   - any stage left over (no node claims that tag) is handed to the
//     leftover untagged chain nodes in resolved shot order, positionally.
// A node's own clip is only filled in if it doesn't already have one — this
// never overwrites footage the user already recorded/attached. Returns just
// the changed nodes ({updatedNodes}) for the client to merge into its local
// board state, same delta-shaped response convention as the other
// breakdown-ish routes.

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

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

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
  const referenceVideoUrl = body?.referenceVideoUrl;
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }
  if (typeof referenceVideoUrl !== "string" || !referenceVideoUrl) {
    return NextResponse.json({ error: "referenceVideoUrl is required" }, { status: 400 });
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

  const videoPath = mediaPathFromUrl(referenceVideoUrl);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return NextResponse.json(
      { error: "The uploaded reference video couldn't be found on disk — try uploading it again." },
      { status: 400 }
    );
  }

  const chainIds = new Set([nodeId, ...resolveConnectedChain(nodeId, board.nodes, board.connections).map((n) => n.id)]);
  if (chainIds.size < 2) {
    return NextResponse.json({ error: "Connect this card to at least one other card before running a chain breakdown." }, { status: 400 });
  }
  const orderedChain = resolveStoryboardOrder(board.nodes, board.connections).filter((n) => chainIds.has(n.id));

  const dir = path.dirname(videoPath);
  const tmpDir = path.join(dir, `_breakdownchain_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const audioPath = path.join(tmpDir, `${nodeId}-ref.mp3`);
    await extractAudio(videoPath, audioPath);
    const transcript = await transcribeAudio(audioPath);

    const analysis = await analyzeVideo({
      title: "",
      description: "",
      author: "",
      hashtags: [],
      stats: { play_count: null, digg_count: null, comment_count: null, share_count: null },
      duration_sec: null,
      transcript_segments: transcript.segments,
    });

    let shootingGuides: Record<string, ShootingGuideEntry> | null = null;
    try {
      shootingGuides = await deriveShootingGuide(analysis.structure);
    } catch (guideErr) {
      console.error("deriveShootingGuide failed — continuing chain breakdown without a shooting guide:", guideErr);
    }

    // Best-effort personality/preference signal for the admin User Data
    // graph (src/lib/personalityInsights.ts) — same non-fatal treatment as
    // the shooting guide above, see breakdown/route.ts for the sibling call.
    try {
      const insightTags = await inferActionInsightTags(
        `A creator imported a full reference video and broke it down to fill in an existing storyboard chain.\n` +
          `AI summary of the video: ${analysis.summary}\n` +
          `Product claims mentioned in it: ${analysis.selling_points.product_claims.join("; ") || "(none)"}`
      );
      if (insightTags.length > 0) {
        const owner = getUserById(access.project.ownerId);
        updateUser(access.project.ownerId, { insightTags: mergeInsightTags(owner?.insightTags, insightTags) });
      }
    } catch (insightErr) {
      console.error("inferActionInsightTags failed — continuing chain breakdown without updating insight tags:", insightErr);
    }

    // A stage the model genuinely couldn't find in this video comes back
    // blank (empty summary AND quote, per analyze.ts's blank-stage rule) —
    // those are dropped here entirely rather than assigned to any card, so
    // that card is simply left untouched (keeps whatever it already had,
    // including any text the user typed in themselves) instead of being
    // overwritten with an empty/forced instruction.
    const presentStages = analysis.structure.filter((s) => s.summary.trim() !== "" || s.quote.trim() !== "");

    // Pass 1: direct stageTag matches, regardless of position in the chain.
    const byStageTag = new Map<FunnelStageKey, StoryboardNode>();
    for (const n of orderedChain) {
      if (n.stageTag && !byStageTag.has(n.stageTag)) byStageTag.set(n.stageTag, n);
    }
    const assignments: { node: StoryboardNode; stage: (typeof analysis.structure)[number] }[] = [];
    const usedNodeIds = new Set<string>();
    for (const stage of presentStages) {
      const tagged = byStageTag.get(stage.key);
      if (tagged) {
        assignments.push({ node: tagged, stage });
        usedNodeIds.add(tagged.id);
      }
    }
    // Pass 2: leftover stages (no node claimed that tag) go to leftover
    // untagged chain nodes, positionally, in resolved shot order.
    const assignedStageKeys = new Set(assignments.map((a) => a.stage.key));
    const remainingStages = presentStages.filter((s) => !assignedStageKeys.has(s.key));
    const remainingNodes = orderedChain.filter((n) => !usedNodeIds.has(n.id));
    for (let i = 0; i < Math.min(remainingNodes.length, remainingStages.length); i++) {
      assignments.push({ node: remainingNodes[i], stage: remainingStages[i] });
    }

    const updatedNodesMap = new Map<string, StoryboardNode>();
    for (const { node: n, stage } of assignments) {
      const stageSec = stage.end_time - stage.start_time;
      let clip = n.clip;
      // Never overwrite a clip the user already attached — only fill an
      // empty slot with a trim of the reference video.
      if (!clip && stageSec >= MIN_STAGE_SEC) {
        const filename = `${n.id}-${stage.key}-ref.mp4`;
        await runFfmpeg([
          "-y", "-i", videoPath,
          "-ss", String(stage.start_time), "-t", String(stageSec),
          "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
          path.join(dir, filename),
        ]);
        clip = { source: "upload", url: `/api/media/storyboard/${params.projectId}/${filename}`, kind: "video" };
      }
      const guide = shootingGuides?.[stage.key];
      updatedNodesMap.set(n.id, {
        ...n,
        instruction: [stage.summary, stage.quote ? `"${stage.quote}"` : ""].filter(Boolean).join("\n\n"),
        clip,
        stageTag: n.stageTag || stage.key,
        shootingGuide: guide
          ? { angle: String(guide.angle || ""), tone: String(guide.tone || ""), pace: String(guide.pace || "") }
          : n.shootingGuide ?? null,
      });
    }

    const updatedNodes = [...updatedNodesMap.values()];
    if (updatedNodes.length === 0) {
      return NextResponse.json({ error: "Couldn't match the analysis onto any card in this chain." }, { status: 400 });
    }

    const newBoard = {
      ...board,
      nodes: board.nodes.map((n) => updatedNodesMap.get(n.id) || n),
    };
    updateCreationProject(params.projectId, { storyboard: newBoard });

    return NextResponse.json({ updatedNodes });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Chain breakdown failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
