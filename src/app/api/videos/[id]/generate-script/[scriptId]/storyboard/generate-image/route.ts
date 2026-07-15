import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { getMediaDir, getVideo } from "@/lib/db";

export const dynamic = "force-dynamic";

// Generates a placeholder/reference still for a storyboard node's video box
// when the team hasn't shot the clip yet — reuses OPENAI_API_KEY (already
// required for Whisper transcription) rather than needing a separate key.
// Purely a visual reference for planning; nothing here calls Creatomate or
// touches the actual video render pipeline (phase 1 is planning-only).
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY isn't set — required for AI placeholder images (same key used for Whisper transcription)." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const nodeId = body?.nodeId;
  const stageIndex = body?.stageIndex;
  if (typeof nodeId !== "string" || !nodeId || typeof stageIndex !== "number") {
    return NextResponse.json({ error: "nodeId and stageIndex are required" }, { status: 400 });
  }

  const script = video.generated_scripts.find((s) => s.id === params.scriptId);
  const stage = script?.stages?.[stageIndex];
  if (!stage) return NextResponse.json({ error: "stage not found" }, { status: 404 });

  const prompt =
    `A realistic reference photo for one beat of a TikTok product video. ` +
    `Beat: "${stage.label}". Shot direction: ${stage.direction || "no specific direction given"}. ` +
    `What's being said on camera: "${stage.script}". ` +
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

    const dir = path.join(getMediaDir(), "storyboard", params.scriptId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${nodeId}.png`;
    fs.writeFileSync(path.join(dir, filename), Buffer.from(b64, "base64"));

    const url = `/api/media/storyboard/${params.scriptId}/${filename}`;
    return NextResponse.json({ url, kind: "image" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Image generation failed" }, { status: 500 });
  }
}
