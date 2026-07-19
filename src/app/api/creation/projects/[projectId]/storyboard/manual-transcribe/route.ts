import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";
import { mediaPathFromUrl, transcribeShotAudio } from "@/lib/storyboardRender";
import { probeDurationSec } from "@/lib/storyboardTrim";

export const dynamic = "force-dynamic";

// The "✂️ Manual Edit" timeline's "🎙 Auto-caption (AI)" button — transcribes
// exactly the trimmed [trimStart, trimEnd) window of ONE clip the creator is
// currently working on (via Whisper, same word-level + context-padding
// machinery as the AI render pipeline's captions — see
// transcribeShotAudio's doc comment in storyboardRender.ts) and hands back
// ready-to-use caption segments, which the client turns straight into text
// overlays. Synchronous (not a background job like /render or
// /manual-render) — a single clip's transcription is short enough to just
// await directly, unlike a full multi-shot render.
export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

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

  const tmpDir = path.join(getMediaDir(), "storyboard", params.projectId, `_transcribe_${Date.now()}`);
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
