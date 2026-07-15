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

  return new Response(data, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
