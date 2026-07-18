import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";
import { startRenderJob, getRenderJob } from "@/lib/storyboardRender";

export const dynamic = "force-dynamic";

// Identical wrapper to the Video Analysis storyboard's render route — see
// that route's comments and src/lib/storyboardRender.ts (the actual shared
// render pipeline + background-job mechanics) for the full reasoning. POST
// starts the render as a background job and returns immediately; GET polls
// its progress.
function jobKey(projectId: string) {
  return `creation:${projectId}`;
}

export async function POST(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const board = access.project.storyboard;
  if (!board || board.nodes.length === 0) {
    return NextResponse.json({ error: "This storyboard has no shots yet." }, { status: 400 });
  }

  const outDir = path.join(getMediaDir(), "storyboard", params.projectId);
  const { job } = startRenderJob(jobKey(params.projectId), board, outDir, `/api/media/storyboard/${params.projectId}`);
  return NextResponse.json({ job });
}

export async function GET(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const job = getRenderJob(jobKey(params.projectId));
  return NextResponse.json({ job });
}
