import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { createVideoRecord, findVideoByUrl, getTrackedCreator, updateTrackedCreator, updateVideoRecord } from "@/lib/db";
import { queueFetchAndTranscribe } from "@/lib/fetchQueue";
import type { VideoRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

// Click-through from a Creator Tracker video card to the full AI breakdown
// page. Lazily hydrates a real VideoRecord from the lightweight stub the
// first time this specific video is opened (same lazy pattern Trend
// Analysis uses) — fetches + transcribes it via the normal pipeline, then
// the video detail page's existing "Run breakdown" button takes it the rest
// of the way, exactly like any other video in the app.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return NextResponse.json({ error: "creator not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const stubId = String(body.videoStubId || "");
  const stub = creator.videos.find((v) => v.id === stubId);
  if (!stub) return NextResponse.json({ error: "video not found on this creator" }, { status: 404 });

  let videoId: string;
  const existing = findVideoByUrl(stub.url);
  if (existing) {
    videoId = existing.id;
    const patch: Partial<VideoRecord> = {};
    if (existing.source !== "creator") patch.source = "creator";
    if (!existing.tracked_creator_id) patch.tracked_creator_id = params.id;
    if (Object.keys(patch).length > 0) updateVideoRecord(videoId, patch);
    if (existing.status === "error" || existing.status === "pending") {
      queueFetchAndTranscribe(videoId, stub.url);
    }
  } else {
    videoId = uuidv4();
    createVideoRecord(videoId, stub.url, { source: "creator", trackedCreatorId: params.id });
    queueFetchAndTranscribe(videoId, stub.url);
  }

  if (stub.linked_video_id !== videoId) {
    const newVideos = creator.videos.map((v) => (v.id === stubId ? { ...v, linked_video_id: videoId } : v));
    updateTrackedCreator(params.id, { videos: newVideos });
  }

  return NextResponse.json({ videoId });
}
