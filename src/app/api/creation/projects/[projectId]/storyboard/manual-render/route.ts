import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";
import { startManualRenderJob, getRenderJob, type ManualEditClipInput, type ManualEditTextOverlay, type ManualEditTransition, type ManualEditBRollInput, type ManualEditMusicInput } from "@/lib/storyboardRender";

export const dynamic = "force-dynamic";

// The "✂️ Manual Edit" timeline editor's own render route — separate from
// ./storyboard/render (the AI pipeline). Same async-background-job shape
// (POST starts it, GET polls it) but a totally different, much simpler
// engine underneath: the creator has already picked every clip's exact
// in/out points and text overlays themselves in ManualEditModal.tsx, so
// there's no smart-trim / caption transcription / editing-feedback
// interpretation here — see startManualRenderJob's doc comment.
function jobKey(projectId: string) {
  return `manual:creation:${projectId}`;
}

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = await req.json().catch(() => ({}));
  const clips: ManualEditClipInput[] = Array.isArray(body?.clips) ? body.clips : [];
  const textOverlays: ManualEditTextOverlay[] = Array.isArray(body?.textOverlays) ? body.textOverlays : [];
  const transitions: ManualEditTransition[] = Array.isArray(body?.transitions) ? body.transitions : [];
  const broll: ManualEditBRollInput[] = Array.isArray(body?.broll) ? body.broll : [];
  const music: ManualEditMusicInput | null =
    body?.music && typeof body.music.url === "string" ? { url: body.music.url, volume: Number(body.music.volume) || 0 } : null;

  const outDir = path.join(getMediaDir(), "storyboard", params.projectId);
  const { job } = startManualRenderJob(jobKey(params.projectId), clips, textOverlays, transitions, broll, music, outDir, `/api/media/storyboard/${params.projectId}`);
  return NextResponse.json({ job });
}

export async function GET(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const job = getRenderJob(jobKey(params.projectId));
  return NextResponse.json({ job });
}
