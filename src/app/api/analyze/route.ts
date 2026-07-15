import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { createVideoRecord } from "@/lib/db";
import { runAnalysisPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const url = (body.url || "").trim();
  const referenceOf = typeof body.referenceOf === "string" ? body.referenceOf : null;

  if (!url || !/tiktok\.com/.test(url)) {
    return NextResponse.json({ error: "Please provide a valid TikTok video link" }, { status: 400 });
  }

  const id = uuidv4();
  createVideoRecord(id, url, { isReference: !!referenceOf, referenceOf });

  // Fire and forget: pipeline runs in the background, client polls for status.
  runAnalysisPipeline(id, url);

  return NextResponse.json({ id, status: "pending" });
}
