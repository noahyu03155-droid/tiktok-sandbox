import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { requireProjectAccess } from "@/lib/creationAuth";
import { updateCreationProject, getUserById } from "@/lib/db";
import { generateShoppableScriptFromChain } from "@/lib/scriptgen";
import { resolveConnectedChain, REQUIRED_STAGE_SEQUENCE } from "@/lib/storyboard";
import type { StoryboardNode } from "@/lib/types";

export const dynamic = "force-dynamic";

// "Generate script" on a pasted-product-link card — different from the
// generate-product-script sibling route: no video file, no Whisper, no
// re-analysis. The reference material is whatever chain of ALREADY-BROKEN-
// DOWN script cards the user wired the product card to (their current,
// possibly hand-edited, script text), gathered via resolveConnectedChain
// (undirected, so it works whichever way the connection was drawn). One
// Claude call (generateShoppableScriptFromChain) preserves that chain's
// core viral structure while swapping in the product's info. 6 new
// stage-tagged, text-only cards are added; the product card itself SURVIVES
// (kept as a freely-repositionable/reusable card) but is disconnected —
// its connections are stripped so it doesn't participate in the
// render-chain / Generate-video topology downstream. The reference chain
// itself is left untouched. Returns just the delta
// ({newNodes, newConnections}) for the client to apply onto its local
// board state, same as breakdown/generate-product-script.

// Matches the canvas's card layout constants (NODE_W / GAP_X in
// src/components/StoryboardCanvas.tsx) so the 6 new cards land in a row
// with the same spacing addNode uses. Plain literals here — the canvas is
// a client component and this is a server route.
const NODE_W = 300;
const GAP_X = 70;

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY isn't set — required for the Claude script-synthesis step (same key used for video analysis)." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const nodeId = body?.nodeId;
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }

  const board = access.project.storyboard;
  const node = board?.nodes.find((n) => n.id === nodeId);
  if (!board || !node) {
    return NextResponse.json(
      { error: "This card hasn't been saved to the storyboard yet — wait a moment for autosave and try again." },
      { status: 400 }
    );
  }
  if (!node.productRef) {
    return NextResponse.json({ error: "Generate script is only available for a product card." }, { status: 400 });
  }

  const isConnected = board.connections.some((c) => c.fromId === nodeId || c.toId === nodeId);
  if (!isConnected) {
    return NextResponse.json({ error: "Connect this product card to at least one other card first." }, { status: 400 });
  }

  const referenceNodes = resolveConnectedChain(nodeId, board.nodes, board.connections);
  if (referenceNodes.length === 0) {
    return NextResponse.json({ error: "No connected reference cards found." }, { status: 400 });
  }

  // Best-effort creator profile, same mechanism the Video Analysis side's
  // generate-product-script route uses (session user -> db user ->
  // creatorProfile) — requireProjectAccess already resolved the session
  // user, so reuse it instead of calling getCurrentUser() again.
  const creatorProfile = getUserById(access.user.userId)?.creatorProfile || null;

  try {
    const stages = await generateShoppableScriptFromChain({
      referenceStages: referenceNodes.map((n) => ({ label: n.label, script: n.instruction })),
      product: {
        title: node.productRef.title || node.label || "Product",
        description: node.productRef.description,
        price: node.productRef.price,
      },
      creatorProfile,
    });

    // Same position-based stage tagging as generate-product-script: the
    // prompt fixes the 6-stage order, but the labels don't string-match
    // FunnelStageKey values, so tag by index.
    const newNodes: StoryboardNode[] = stages.map((stage, i) => ({
      id: crypto.randomUUID(),
      label: stage.label,
      instruction: [stage.script, stage.direction ? `🎬 ${stage.direction}` : ""].filter(Boolean).join("\n\n"),
      x: node.x + i * (NODE_W + GAP_X),
      y: node.y,
      clip: null,
      stageTag: REQUIRED_STAGE_SEQUENCE[i],
    }));

    const newConnections = newNodes.slice(0, -1).map((n, i) => ({
      id: crypto.randomUUID(),
      fromId: n.id,
      toId: newNodes[i + 1].id,
    }));

    // Keep the product node (it stays on the board as a reusable card) but
    // still strip any connections involving it — after generating it ends
    // up unconnected, so it can't accidentally count toward the
    // render-chain / Generate-video-button logic, which assumes connected
    // nodes are real script/video content.
    const newBoard = {
      ...board,
      nodes: board.nodes.concat(newNodes),
      connections: board.connections.filter((c) => c.fromId !== nodeId && c.toId !== nodeId).concat(newConnections),
    };
    updateCreationProject(params.projectId, { storyboard: newBoard });

    return NextResponse.json({ newNodes, newConnections });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Script generation failed" }, { status: 500 });
  }
}
