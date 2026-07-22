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

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
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

  // HTTP Range support — without it (the previous behavior: whole file,
  // no Accept-Ranges header) browsers can't seek in <video> playback at
  // all; dragging the progress bar backwards simply did nothing, which is
  // exactly what the user reported on rendered videos. Serving 206 partial
  // responses lets the <video> element fetch whatever byte range the seek
  // target needs.
  const stat = fs.statSync(filePath);
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
    if (!m || start > end || start >= stat.size) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${stat.size}` },
      });
    }
    const length = end - start + 1;
    const chunk = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, chunk, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": String(length),
      },
    });
  }

  const data = fs.readFileSync(filePath);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes",
      "Content-Length": String(stat.size),
    },
  });
}
