import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir, updateCreationProject } from "@/lib/db";
import { analyzeReferenceStyle } from "@/lib/storyboardStyle";

export const dynamic = "force-dynamic";

// Same "learn from a reference video" flow as the Video Analysis
// storyboard's style/analyze route, keyed by projectId. One profile per
// project — a fresh upload overwrites the previous one.
const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const board = access.project.storyboard;
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

  const dir = path.join(getMediaDir(), "storyboard", params.projectId);
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

    updateCreationProject(params.projectId, { storyboard: { ...board, styleProfile: profile } });

    return NextResponse.json({ profile, refUrl: `/api/media/storyboard/${params.projectId}/${filename}` });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Style analysis failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const board = access.project.storyboard;
  if (!board) return NextResponse.json({ ok: true });

  updateCreationProject(params.projectId, { storyboard: { ...board, styleProfile: null } });
  return NextResponse.json({ ok: true });
}
