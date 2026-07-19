import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo } from "@/lib/db";
import { videoAccessError } from "@/lib/videoAuth";

export const dynamic = "force-dynamic";

// Lets a user drop their own clip/photo onto a storyboard node's video box.
// Saved to data/media/storyboard/<scriptId>/<nodeId>.<ext> and served back
// through the existing catch-all /api/media/[...path] route — same storage
// convention as everything else under data/media, so it's already covered
// by the app's Docker volume + .gitignore.
const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  // Background-music uploads for Manual Edit's music track.
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
};

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const nodeId = form?.get("nodeId");
  if (!file || !(file instanceof File) || typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "file and nodeId are required" }, { status: 400 });
  }

  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || "unknown"}. Use mp4/mov/webm for clips or jpg/png/webp/gif for photos.` },
      { status: 400 }
    );
  }
  const kind: "video" | "image" | "audio" = file.type.startsWith("video/")
    ? "video"
    : file.type.startsWith("audio/")
    ? "audio"
    : "image";

  const dir = path.join(getMediaDir(), "storyboard", params.scriptId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${nodeId}.${ext}`;
  const filePath = path.join(dir, filename);

  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(filePath, buf);

  const url = `/api/media/storyboard/${params.scriptId}/${filename}`;
  return NextResponse.json({ url, kind });
}
