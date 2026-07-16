import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir, updateCreationProject } from "@/lib/db";
import { analyzeReferenceStyle } from "@/lib/storyboardStyle";
import { fetchTikTokVideo } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

// Same "learn from a reference video" flow as the Video Analysis
// storyboard's style/analyze route, keyed by projectId. One profile per
// project — a fresh upload/link overwrites the previous one. Accepts either
// a multipart file upload OR a JSON { url } TikTok link (downloaded
// server-side via the shared yt-dlp fetcher, same as the storyboard's
// "paste a TikTok link" import feature).
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

  const dir = path.join(getMediaDir(), "storyboard", params.projectId);
  fs.mkdirSync(dir, { recursive: true });

  let srcPath: string;
  let refFilename: string;
  let sourceLabel: string;

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url || !/tiktok\.com/.test(url)) {
      return NextResponse.json({ error: "Please provide a valid TikTok video link" }, { status: 400 });
    }
    try {
      const fetched = await fetchTikTokVideo(url, dir, "style-ref");
      if (!fetched.video_path) throw new Error("Download succeeded but no video file was produced.");
      srcPath = fetched.video_path;
      refFilename = path.basename(fetched.video_path);
      sourceLabel = fetched.title || "reference video";
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Failed to download the reference video" }, { status: 500 });
    }
  } else {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "A reference video file is required" }, { status: 400 });
    }
    const ext = EXT_BY_MIME[file.type];
    if (!ext) {
      return NextResponse.json({ error: `Unsupported file type: ${file.type || "unknown"}. Use mp4/mov/webm.` }, { status: 400 });
    }
    const filename = `style-ref.${ext}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));
    srcPath = filePath;
    refFilename = filename;
    sourceLabel = file.name || "reference video";
  }

  const tmpDir = path.join(dir, `_style_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const profile = await analyzeReferenceStyle({
      srcPath,
      tmpDir,
      apiKey: process.env.OPENAI_API_KEY,
      sourceLabel,
    });

    updateCreationProject(params.projectId, { storyboard: { ...board, styleProfile: profile } });

    return NextResponse.json({ profile, refUrl: `/api/media/storyboard/${params.projectId}/${refFilename}` });
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
