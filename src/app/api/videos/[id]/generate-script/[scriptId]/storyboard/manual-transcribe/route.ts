import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo } from "@/lib/db";
import { videoAccessError } from "@/lib/videoAuth";
import { mediaPathFromUrl, transcribeShotAudio } from "@/lib/storyboardRender";
import { probeDurationSec } from "@/lib/storyboardTrim";

export const dynamic = "force-dynamic";

// Video Analysis's mirror of
// src/app/api/creation/projects/[projectId]/storyboard/manual-transcribe —
// see that route's comments for the full design note.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY isn't set — required for auto-captioning." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url : "";
  const trimStart = Number(body?.trimStart);
  const trimEnd = Number(body?.trimEnd);
  if (!url || !Number.isFinite(trimStart) || !Number.isFinite(trimEnd) || trimEnd <= trimStart) {
    return NextResponse.json({ error: "url, trimStart, and trimEnd are required." }, { status: 400 });
  }

  const srcPath = mediaPathFromUrl(url);
  if (!srcPath || !fs.existsSync(srcPath)) {
    return NextResponse.json({ error: "That clip couldn't be found on disk." }, { status: 400 });
  }

  const tmpDir = path.join(getMediaDir(), "storyboard", params.scriptId, `_transcribe_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const clipDurationSec = await probeDurationSec(srcPath);
    const segments = await transcribeShotAudio(srcPath, trimStart, trimEnd - trimStart, clipDurationSec, tmpDir, 0);
    return NextResponse.json({ segments: segments || [] });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Auto-caption failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
