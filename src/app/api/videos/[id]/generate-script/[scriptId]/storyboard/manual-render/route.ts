import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getMediaDir, getVideo } from "@/lib/db";
import { videoAccessError } from "@/lib/videoAuth";
import { startManualRenderJob, getRenderJob, type ManualEditClipInput, type ManualEditTextOverlay, type ManualEditTransition, type ManualEditBRollInput, type ManualEditMusicInput } from "@/lib/storyboardRender";

export const dynamic = "force-dynamic";

// Video Analysis's mirror of
// src/app/api/creation/projects/[projectId]/storyboard/manual-render — see
// that route's comments and storyboardRender.ts's startManualRenderJob for
// the full design note. Same logic, keyed by videoId/scriptId instead of
// projectId (matches every other storyboard route pair in this app).
function jobKey(id: string, scriptId: string) {
  return `manual:video:${id}:${scriptId}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });

  const body = await req.json().catch(() => ({}));
  const clips: ManualEditClipInput[] = Array.isArray(body?.clips) ? body.clips : [];
  const textOverlays: ManualEditTextOverlay[] = Array.isArray(body?.textOverlays) ? body.textOverlays : [];
  const transitions: ManualEditTransition[] = Array.isArray(body?.transitions) ? body.transitions : [];
  const broll: ManualEditBRollInput[] = Array.isArray(body?.broll) ? body.broll : [];
  const music: ManualEditMusicInput | null =
    body?.music && typeof body.music.url === "string" ? { url: body.music.url, volume: Number(body.music.volume) || 0 } : null;

  const outDir = path.join(getMediaDir(), "storyboard", params.scriptId);
  const { job } = startManualRenderJob(
    jobKey(params.id, params.scriptId),
    clips,
    textOverlays,
    transitions,
    broll,
    music,
    outDir,
    `/api/media/storyboard/${params.scriptId}`
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
