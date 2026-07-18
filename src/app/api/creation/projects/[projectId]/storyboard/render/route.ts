import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";
import { startRenderJob, getRenderJob, type CaptionsMode } from "@/lib/storyboardRender";

export const dynamic = "force-dynamic";

// Identical wrapper to the Video Analysis storyboard's render route — see
// that route's comments and src/lib/storyboardRender.ts (the actual shared
// render pipeline + background-job mechanics) for the full reasoning. POST
// starts the render as a background job and returns immediately; GET polls
// its progress.
function jobKey(projectId: string) {
  return `creation:${projectId}`;
}

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const board = access.project.storyboard;
  if (!board || board.nodes.length === 0) {
    return NextResponse.json({ error: "This storyboard has no shots yet." }, { status: 400 });
  }

  // From the "want captions?" modal the canvas shows before every render —
  // defaults to "off" (no captions) if the client somehow doesn't send it,
  // since captions are opt-in now, not the old always-on behavior.
  const body = await req.json().catch(() => ({}));
  const captionsMode: CaptionsMode = body?.captionsMode === "auto" ? "auto" : "off";

  const outDir = path.join(getMediaDir(), "storyboard", params.projectId);
  const { job } = startRenderJob(jobKey(params.projectId), board, outDir, `/api/media/storyboard/${params.projectId}`, captionsMode);
  return NextResponse.json({ job });
}

export async function GET(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const job = getRenderJob(jobKey(params.projectId));
  return NextResponse.json({ job });
}
