import { NextRequest, NextResponse } from "next/server";
import { getVideo, updateVideoRecord } from "@/lib/db";
import { queueFetchAndTranscribe } from "@/lib/fetchQueue";

export const dynamic = "force-dynamic";

// Re-runs fetch+transcribe for a video that ended up with no transcript —
// either because it's flagged status:"error", or because an earlier attempt
// silently ended in status:"done" with an empty transcript (e.g. a
// transcribe_local.py crash that left a stale error_message from a prior
// run). Clears the old error and re-queues it through the same throttled
// queue used for bulk trend imports.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  updateVideoRecord(params.id, { status: "pending", error_message: null, analysis: null });
  queueFetchAndTranscribe(params.id, video.source_url);

  return NextResponse.json({ ok: true });
}
