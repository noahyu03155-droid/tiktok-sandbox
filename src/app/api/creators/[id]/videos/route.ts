import { NextRequest, NextResponse } from "next/server";
import { getTrackedCreator, updateTrackedCreator } from "@/lib/db";

export const dynamic = "force-dynamic";

// Removes specific video stubs from a tracked creator's archive — used by
// the creator-detail video grid's select-and-delete mode. Doesn't touch any
// VideoRecord a video may have been hydrated into (see linked_video_id) —
// that stays around in Video Analysis like any other video would.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.videoIds) ? body.videoIds.filter((i: unknown) => typeof i === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "Body must include videoIds[]" }, { status: 400 });
  }

  const idSet = new Set(ids);
  const videos = creator.videos.filter((v) => !idSet.has(v.id));
  updateTrackedCreator(params.id, { videos });

  return NextResponse.json({ ok: true, deleted: creator.videos.length - videos.length });
}
