import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { requireProjectAccess } from "@/lib/creationAuth";
import { updateCreationProject } from "@/lib/db";
import { REQUIRED_STAGE_SEQUENCE } from "@/lib/storyboard";
import type { StoryboardNode, StoryboardState, GeneratedScriptStage } from "@/lib/types";

export const dynamic = "force-dynamic";

// Matches the canvas's card layout constants (NODE_W / GAP_X in
// src/components/StoryboardCanvas.tsx) — kept in sync by hand since that
// file's constants aren't exported.
const NODE_W = 300;
const GAP_X = 70;

// "Generate video — plan the storyboard" on the Video Analysis page's
// Script tab (see AnalysisTabs.tsx) used to open a standalone canvas
// scoped to just that one generated script — it lived nowhere in the
// user's actual Creation project list, so there was no way to find it
// again except re-opening that exact script. This route instead drops the
// already-generated script's stages as new cards into a Creation project
// the user explicitly picked (ProjectPickerModal), so it shows up
// alongside everything else they're building. Similar tail to
// generate-product-script's newNodes construction, but skips the
// (re)generation step entirely since the script text already exists —
// this just imports it as-is.
export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = await req.json().catch(() => ({}));
  const stages: GeneratedScriptStage[] = Array.isArray(body?.stages) ? body.stages : [];
  if (stages.length === 0) {
    return NextResponse.json({ error: "stages is required" }, { status: 400 });
  }

  const board: StoryboardState = access.project.storyboard || {
    nodes: [],
    connections: [],
    direction: "",
    zoom: 1,
    pan: { x: 40, y: 40 },
  };

  const rightmost = board.nodes.reduce((max, n) => Math.max(max, n.x), 0);
  const startX = board.nodes.length === 0 ? 60 : rightmost + NODE_W + GAP_X;

  // Stages come back from generate-script in the fixed funnel order (same
  // as generate-product-script's output) but without a stage key of their
  // own, so tag each new card by POSITION against REQUIRED_STAGE_SEQUENCE —
  // same convention used everywhere else a script's stages become cards.
  const newNodes: StoryboardNode[] = stages.map((stage, i) => ({
    id: crypto.randomUUID(),
    label: stage.label,
    instruction: [stage.script, stage.direction ? `🎬 ${stage.direction}` : ""].filter(Boolean).join("\n\n"),
    x: startX + i * (NODE_W + GAP_X),
    y: 120,
    clip: null,
    stageTag: REQUIRED_STAGE_SEQUENCE[i] || undefined,
  }));

  const newConnections = newNodes.slice(0, -1).map((n, i) => ({
    id: crypto.randomUUID(),
    fromId: n.id,
    toId: newNodes[i + 1].id,
  }));

  const newBoard: StoryboardState = {
    ...board,
    nodes: [...board.nodes, ...newNodes],
    connections: [...board.connections, ...newConnections],
  };
  updateCreationProject(params.projectId, { storyboard: newBoard });

  return NextResponse.json({ projectId: params.projectId, newNodes, newConnections });
}
