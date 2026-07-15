import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";

export const dynamic = "force-dynamic";

// Same as the Video Analysis storyboard's upload route, just keyed by
// projectId instead of scriptId — saved to
// data/media/storyboard/<projectId>/<nodeId>.<ext>, served back through the
// existing /api/media/[...path] catch-all.
const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

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
  const kind: "video" | "image" = file.type.startsWith("video/") ? "video" : "image";

  const dir = path.join(getMediaDir(), "storyboard", params.projectId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${nodeId}.${ext}`;
  const filePath = path.join(dir, filename);

  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(filePath, buf);

  const url = `/api/media/storyboard/${params.projectId}/${filename}`;
  return NextResponse.json({ url, kind });
}
