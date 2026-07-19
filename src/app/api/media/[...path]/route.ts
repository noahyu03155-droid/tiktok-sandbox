import { NextRequest } from "next/server";
import path from "path";
import fs from "fs";
import { getMediaDir } from "@/lib/db";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  // yt-dlp sometimes can't tell the image type from the CDN response and
  // just writes a generic ".image" file — it's a JPEG/WebP-ish still frame
  // in practice, and browsers render it fine once the content-type says
  // it's an image at all (as opposed to octet-stream, which most browsers
  // won't inline as an <img>).
  ".image": "image/jpeg",
};

export async function GET(_req: NextRequest, { params }: { params: { path: string[] } }) {
  const mediaDir = getMediaDir();
  const filePath = path.join(mediaDir, ...params.path);

  // Prevent path traversal outside the media directory.
  if (!filePath.startsWith(mediaDir)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!fs.existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);

  // Almost every file under mediaDir gets a unique, never-reused filename
  // (timestamped uploads, generated stills, etc.) — genuinely safe to tell
  // browsers/CDNs to cache forever. render.mp4 is the one exception: every
  // "Generate video" click overwrites this SAME path with fresh bytes, so
  // an immutable/1-year cache told the browser it could keep serving
  // whatever it fetched the FIRST time a project's render.mp4 was ever
  // requested, even after a brand new render finished — the reported "the
  // inline preview and the downloaded file are completely different videos"
  // bug. Skip the long-lived cache specifically for this filename so it's
  // always revalidated instead.
  // manual-render.mp4 is the "✂️ Manual Edit" exporter's own output file —
  // same overwritten-in-place-on-every-export situation as render.mp4, so it
  // needs the same no-cache treatment for the same reason.
  const isRenderOutput = ["render.mp4", "manual-render.mp4"].includes(path.basename(filePath));
  const cacheControl = isRenderOutput ? "no-cache" : "public, max-age=31536000, immutable";

  return new Response(data, {
    headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
  });
}
