import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir, updateCreationProject, getUserById, updateUser } from "@/lib/db";
import { extractAudio, transcribeAudio } from "@/lib/transcribe";
import { analyzeVideo } from "@/lib/analyze";
import { getShopifyProduct } from "@/lib/shopify";
import { generateScriptForProduct } from "@/lib/scriptgen";
import { REQUIRED_STAGE_SEQUENCE } from "@/lib/storyboard";
import { deriveShootingGuide, type ShootingGuideEntry, type ShootingLocation } from "@/lib/shootingGuide";
import { inferActionInsightTags, mergeInsightTags } from "@/lib/personalityInsights";
import type { StoryboardNode, VideoStats, FunnelStage } from "@/lib/types";

export const dynamic = "force-dynamic";

// "Generate product script" — same flow as the Video Analysis storyboard's
// generate-product-script route, keyed by projectId: for a card whose clip
// came from pasting a TikTok link, runs the identical Whisper + Claude
// analysis pipeline the breakdown uses, then makes ONE MORE Claude call
// (generateScriptForProduct — the same logic the standalone Video Analysis
// "Generate script" feature uses) to write a NEW 6-stage script adapted to
// a Shopify product the user picked: same structure/pacing as the
// reference, content swapped to that product's actual selling points. The
// original card is replaced by 6 stage-tagged, text-only cards — clip is
// null on every one, since this is a fresh script to be filmed, not a
// repurposed video segment. Returns just the delta
// ({newNodes, newConnections}) for the client to apply onto its local
// board state.

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
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }
  // Either a Shopify catalog product id (picked ad hoc through
  // ProductPicker), or the id of an already-connected pending product card
  // (productRef) on this same board — see findConnectedProductRefNode in
  // StoryboardCanvas.tsx, which prefers whatever product the user already
  // wired into the chain over opening the catalog picker.
  const shopifyProductId = body?.shopifyProductId;
  const connectedProductNodeId = body?.connectedProductNodeId;
  if (
    (typeof shopifyProductId !== "string" || !shopifyProductId) &&
    (typeof connectedProductNodeId !== "string" || !connectedProductNodeId)
  ) {
    return NextResponse.json({ error: "shopifyProductId or connectedProductNodeId is required" }, { status: 400 });
  }
  // Optional — asked via a popup right before this action (see
  // StoryboardCanvas.tsx's location-prompt modal) so the Shooting Guide can
  // favor angle/tone/pace that's realistic for where the creator plans to
  // film.
  const location: ShootingLocation | undefined =
    body?.location === "indoor" || body?.location === "outdoor" ? body.location : undefined;

  const board = access.project.storyboard;
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

  // ShopifyProductSummary-shaped either way, so generateScriptForProduct
  // downstream doesn't need to know which source it came from.
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
      // Fold price/rating into the description text since
      // generateScriptForProduct only reads title/productType/tags/
      // description — this is the simplest way to still give it that
      // context without changing its input shape.
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
    });

    // Nice-to-have on top of the new script, same as the plain Breakdown
    // routes: one extra lightweight Claude call for per-stage filming
    // guidance (angle/tone/pace). generateScriptForProduct's output has no
    // FunnelStageKey/start_time/end_time (it's a fresh script, not a
    // trimmed clip) — deriveShootingGuide only actually reads
    // key/label/summary/quote, so build a synthetic FunnelStage per new
    // card (position-tagged against REQUIRED_STAGE_SEQUENCE, same as the
    // newNodes below) using the stage's script as the "summary" and its
    // camera direction as the "quote". Non-fatal — the 6 new script cards
    // are the main value; if this call errors, they just ship without a
    // pre-filled guide.
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

    // Best-effort personality/preference signal for the admin User Data
    // graph (src/lib/personalityInsights.ts) — richer than the plain
    // breakdown routes since we know the actual PRODUCT this member is
    // building a script around, not just the reference video. Same
    // non-fatal treatment — see breakdown/route.ts for the sibling call.
    try {
      const insightTags = await inferActionInsightTags(
        `A creator generated a shoppable video script adapting a reference video's structure to one of their own products.\n` +
          `Reference video summary: ${analysis.summary}\n` +
          `Product: ${product.title}\nProduct type: ${product.productType || "(none)"}\nProduct tags: ${product.tags.join(", ") || "(none)"}\n` +
          `Product description: ${product.description.slice(0, 500)}`
      );
      if (insightTags.length > 0) {
        const owner = getUserById(access.project.ownerId);
        updateUser(access.project.ownerId, { insightTags: mergeInsightTags(owner?.insightTags, insightTags) });
      }
    } catch (insightErr) {
      console.error("inferActionInsightTags failed — continuing script generation without updating insight tags:", insightErr);
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
        // Coerced defensively — see breakdown/route.ts's identical pattern.
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
    updateCreationProject(params.projectId, { storyboard: newBoard });

    return NextResponse.json({ newNodes, newConnections });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Script generation failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
