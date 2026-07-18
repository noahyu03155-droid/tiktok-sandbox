import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo, getUserById, updateVideoRecord } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { videoAccessError } from "@/lib/videoAuth";
import { extractAudio, transcribeAudio } from "@/lib/transcribe";
import { analyzeVideo } from "@/lib/analyze";
import { getShopifyProduct } from "@/lib/shopify";
import { generateScriptForProduct } from "@/lib/scriptgen";
import { REQUIRED_STAGE_SEQUENCE } from "@/lib/storyboard";
import { deriveShootingGuide, type ShootingGuideEntry, type ShootingLocation } from "@/lib/shootingGuide";
import type { StoryboardNode, VideoStats, FunnelStage } from "@/lib/types";

export const dynamic = "force-dynamic";

// "Generate product script" — the sibling of the breakdown route, for the
// same freshly-pasted TikTok card. Instead of handing back the reference
// video's own 6-stage breakdown, this runs the identical Whisper + Claude
// analysis pipeline, then makes ONE MORE Claude call
// (generateScriptForProduct — the same logic the standalone Video Analysis
// "Generate script" feature uses) to write a NEW 6-stage script adapted to
// a Shopify product the user picked: same structure/pacing as the
// reference, content swapped to that product's actual selling points. The
// original card is replaced by 6 stage-tagged, text-only cards — clip is
// null on every one, since this is a fresh script to be filmed, not a
// repurposed video segment. Returns just the delta
// ({newNodes, newConnections}) — same response shape as breakdown, so the
// client applies it with identical logic.

// Matches the canvas's card layout constants (NODE_W / GAP_X in
// src/components/StoryboardCanvas.tsx) so the 6 new cards land in a row
// with the same spacing addNode uses. Plain literals here — the canvas is
// a client component and this is a server route.
const NODE_W = 300;
const GAP_X = 70;

function mediaPathFromUrl(url: string): string | null {
  if (!url.startsWith("/api/media/")) return null;
  const rel = url.slice("/api/media/".length).split("/").filter(Boolean);
  const p = path.join(getMediaDir(), ...rel);
  if (!p.startsWith(getMediaDir())) return null; // path traversal guard
  return p;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });

  const sessionUser = getCurrentUser();
  const dbUser = sessionUser ? getUserById(sessionUser.userId) : null;

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
  const shopifyProductId = body?.shopifyProductId;
  const connectedProductNodeId = body?.connectedProductNodeId;
  if (
    (typeof shopifyProductId !== "string" || !shopifyProductId) &&
    (typeof connectedProductNodeId !== "string" || !connectedProductNodeId)
  ) {
    return NextResponse.json({ error: "shopifyProductId or connectedProductNodeId is required" }, { status: 400 });
  }
  const location: ShootingLocation | undefined =
    body?.location === "indoor" || body?.location === "outdoor" ? body.location : undefined;

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
    return NextResponse.json({ error: "Generate product script is only available for a clip imported from a TikTok link." }, { status: 400 });
  }

  const videoPath = mediaPathFromUrl(node.clip.url);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return NextResponse.json(
      { error: "The imported TikTok video file couldn't be found on disk — try re-importing the link." },
      { status: 400 }
    );
  }

  let product: { id: string; title: string; handle: string; description: string; tags: string[]; productType: string; imageUrl: string | null };
  if (typeof shopifyProductId === "string" && shopifyProductId) {
    const shopifyProduct = await getShopifyProduct(shopifyProductId);
    if (!shopifyProduct) return NextResponse.json({ error: "Shopify product not found" }, { status: 404 });
    product = shopifyProduct;
  } else {
    const connectedNode = board.nodes.find((n) => n.id === connectedProductNodeId);
    if (!connectedNode || !connectedNode.productRef) {
      return NextResponse.json({ error: "Connected product card not found on this board." }, { status: 400 });
    }
    const ref = connectedNode.productRef;
    product = {
      id: connectedNode.id,
      title: ref.title || "Untitled product",
      handle: "",
      description: [ref.description, ref.price ? `Price: ${ref.price}` : "", ref.rating ? `Rating: ${ref.rating}` : ""]
        .filter(Boolean)
        .join("\n"),
      tags: [],
      productType: "",
      imageUrl: ref.imageUrl,
    };
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

  const tmpDir = path.join(dir, `_product_script_${Date.now()}`);
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

    const stages = await generateScriptForProduct({
      videoTitle: meta.title || "TikTok clip",
      analysis,
      product,
      creatorProfile: dbUser?.creatorProfile || null,
    });

    // Nice-to-have on top of the new script, same as the plain Breakdown
    // routes — see the creation-project sibling route for the full
    // reasoning. Non-fatal.
    let shootingGuides: Record<string, ShootingGuideEntry> | null = null;
    try {
      const syntheticStructure: FunnelStage[] = stages.map((stage, i) => ({
        key: REQUIRED_STAGE_SEQUENCE[i],
        label: stage.label,
        start_time: 0,
        end_time: 0,
        summary: stage.script,
        quote: stage.direction || "",
      }));
      shootingGuides = await deriveShootingGuide(syntheticStructure, location);
    } catch (guideErr) {
      console.error("deriveShootingGuide failed — continuing product script without a shooting guide:", guideErr);
    }

    // generateScriptForProduct always returns the 6 stages in the fixed
    // funnel order (by construction of its prompt) but without a stage key
    // — its labels don't string-match FunnelStageKey values — so tag each
    // new card by POSITION against REQUIRED_STAGE_SEQUENCE.
    const newNodes: StoryboardNode[] = stages.map((stage, i) => {
      const guide = shootingGuides?.[REQUIRED_STAGE_SEQUENCE[i]];
      return {
        id: crypto.randomUUID(),
        label: stage.label,
        instruction: [stage.script, stage.direction ? `🎬 ${stage.direction}` : ""].filter(Boolean).join("\n\n"),
        x: node.x + i * (NODE_W + GAP_X),
        y: node.y,
        clip: null,
        stageTag: REQUIRED_STAGE_SEQUENCE[i],
        shootingGuide: guide
          ? { angle: String(guide.angle || ""), tone: String(guide.tone || ""), pace: String(guide.pace || "") }
          : null,
      };
    });

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
    return NextResponse.json({ error: e?.message || "Script generation failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
