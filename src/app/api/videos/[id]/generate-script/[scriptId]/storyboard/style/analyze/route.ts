import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo, updateVideoRecord } from "@/lib/db";
import { analyzeReferenceStyle } from "@/lib/storyboardStyle";

export const dynamic = "force-dynamic";

// "Learn from a reference video" — takes an uploaded example clip (an edit
// whose pacing/transition feel the user wants), runs it through
// src/lib/storyboardStyle.ts (ffmpeg scene-cut timing + an optional vision
// pass), and saves the resulting style profile onto the storyboard so the
// render route can apply that rhythm to the user's own footage. One profile
// per script — a fresh upload overwrites the previous one.
const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const scriptIdx = video.generated_scripts.findIndex((s) => s.id === params.scriptId);
  if (scriptIdx === -1) return NextResponse.json({ error: "script not found" }, { status: 404 });
  const script = video.generated_scripts[scriptIdx];
  const board = script.storyboard;
  if (!board) {
    return NextResponse.json({ error: "Open and save the storyboard canvas at least once before adding a reference video." }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "A reference video file is required" }, { status: 400 });
  }
  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    return NextResponse.json({ error: `Unsupported file type: ${file.type || "unknown"}. Use mp4/mov/webm.` }, { status: 400 });
  }

  const dir = path.join(getMediaDir(), "storyboard", params.scriptId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `style-ref.${ext}`;
  const srcPath = path.join(dir, filename);
  fs.writeFileSync(srcPath, Buffer.from(await file.arrayBuffer()));

  const tmpDir = path.join(dir, `_style_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const profile = await analyzeReferenceStyle({
      srcPath,
      tmpDir,
      apiKey: process.env.OPENAI_API_KEY,
      sourceLabel: file.name || "reference video",
    });

    const newScripts = video.generated_scripts.map((s, i) =>
      i === scriptIdx ? { ...s, storyboard: { ...board, styleProfile: profile } } : s
    );
    updateVideoRecord(params.id, { generated_scripts: newScripts });

    return NextResponse.json({ profile, refUrl: `/api/media/storyboard/${params.scriptId}/${filename}` });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Style analysis failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scriptIdx = video.generated_scripts.findIndex((s) => s.id === params.scriptId);
  if (scriptIdx === -1) return NextResponse.json({ error: "script not found" }, { status: 404 });
  const script = video.generated_scripts[scriptIdx];
  const board = script.storyboard;
  if (!board) return NextResponse.json({ ok: true });

  const newScripts = video.generated_scripts.map((s, i) =>
    i === scriptIdx ? { ...s, storyboard: { ...board, styleProfile: null } } : s
  );
  updateVideoRecord(params.id, { generated_scripts: newScripts });
  return NextResponse.json({ ok: true });
}
