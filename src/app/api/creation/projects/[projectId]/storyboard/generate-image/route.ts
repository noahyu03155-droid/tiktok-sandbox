import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";

export const dynamic = "force-dynamic";

// Same as the Video Analysis storyboard's generate-image route, keyed by
// projectId. Nodes are freeform, so the prompt is built straight from
// whatever the client currently has typed in the node's label/instruction —
// not looked up server-side, since the node may not be saved yet.
export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY isn't set — required for AI placeholder images (same key used for Whisper transcription)." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const nodeId = body?.nodeId;
  const label = typeof body?.label === "string" ? body.label : "";
  const instruction = typeof body?.instruction === "string" ? body.instruction : "";
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }
  if (!label && !instruction) {
    return NextResponse.json({ error: "Write something in the shot's text box first — that's what the AI reference image is generated from." }, { status: 400 });
  }

  const prompt =
    `A realistic reference photo for one shot of a TikTok product video. ` +
    `Shot: "${label || "untitled"}". ` +
    `What's happening / being said: "${instruction || "no direction given"}". ` +
    `Style: natural iPhone-shot UGC photo, not overly polished, no on-image text or captions.`;

  try {
    const client = new OpenAI({ apiKey });
    const result = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1536",
      n: 1,
    } as any);

    const b64 = (result as any)?.data?.[0]?.b64_json;
    if (!b64) throw new Error("No image returned");

    const dir = path.join(getMediaDir(), "storyboard", params.projectId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${nodeId}.png`;
    fs.writeFileSync(path.join(dir, filename), Buffer.from(b64, "base64"));

    const url = `/api/media/storyboard/${params.projectId}/${filename}`;
    return NextResponse.json({ url, kind: "image" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Image generation failed" }, { status: 500 });
  }
}
