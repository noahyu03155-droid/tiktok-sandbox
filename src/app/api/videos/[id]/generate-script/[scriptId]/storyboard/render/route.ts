import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getMediaDir, getVideo } from "@/lib/db";
import { videoAccessError } from "@/lib/videoAuth";
import { startRenderJob, getRenderJob, type CaptionsMode } from "@/lib/storyboardRender";

export const dynamic = "force-dynamic";

// Stitches whatever clips/reference stills are attached to a storyboard's
// nodes into one downloadable MP4 — the actual render pipeline (captions,
// Ken Burns, crossfades, smart trim, reference-style profile) lives in
// src/lib/storyboardRender.ts, shared with the Creation project's render
// route. This route is now just a thin wrapper: POST starts the render as a
// background job and returns immediately (see storyboardRender.ts's doc
// comment for why — a render can take minutes, far longer than it's safe to
// hold one HTTP request open for), GET polls its progress.
function jobKey(id: string, scriptId: string) {
  return `video:${id}:${scriptId}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });

  const script = video.generated_scripts.find((s) => s.id === params.scriptId);
  const board = script?.storyboard;
  if (!board || board.nodes.length === 0) {
    return NextResponse.json({ error: "This storyboard has no shots yet." }, { status: 400 });
  }

  // From the "want captions?" modal the canvas shows before every render —
  // defaults to "off" (no captions) if the client somehow doesn't send it.
  const body = await req.json().catch(() => ({}));
  const captionsMode: CaptionsMode = body?.captionsMode === "auto" ? "auto" : "off";

  const outDir = path.join(getMediaDir(), "storyboard", params.scriptId);
  const { job } = startRenderJob(
    jobKey(params.id, params.scriptId),
    board,
    outDir,
    `/api/media/storyboard/${params.scriptId}`,
    captionsMode
  );
  return NextResponse.json({ job });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });

  const job = getRenderJob(jobKey(params.id, params.scriptId));
  return NextResponse.json({ job });
}
