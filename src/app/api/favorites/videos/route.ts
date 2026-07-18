import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser, getVideo } from "@/lib/db";
import { canAccessVideo } from "@/lib/videoAuth";
import type { VideoRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET: this member's bookmarked videos, dereferenced live against the
// current VideoRecord (see the User.favoriteVideos doc comment in
// src/lib/types.ts) rather than any snapshot — so a favorited video's card
// always shows today's thumbnail/stats/analysis state. A favorite pointing
// at a video that's been deleted, or a "manual" import this member no
// longer has access to, is silently dropped from the list rather than
// erroring — same non-fatal-skip treatment used elsewhere in this app for
// stale references.
export async function GET() {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const entries = user.favoriteVideos || [];
  const videos: { favoriteId: string; addedAt: string; video: VideoRecord }[] = [];
  for (const entry of entries) {
    const video = getVideo(entry.videoId);
    if (!video || !canAccessVideo(video, sessionUser)) continue;
    videos.push({ favoriteId: entry.id, addedAt: entry.addedAt, video });
  }
  // Newest-favorited first.
  videos.sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
  return NextResponse.json({ videos });
}

// POST { videoId } — idempotent (favoriting an already-favorited video just
// returns the existing entry rather than creating a duplicate).
export async function POST(req: NextRequest) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const videoId = body?.videoId;
  if (typeof videoId !== "string" || !videoId) {
    return NextResponse.json({ error: "videoId is required" }, { status: 400 });
  }
  const video = getVideo(videoId);
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!canAccessVideo(video, sessionUser)) {
    return NextResponse.json({ error: "You don't have access to this video" }, { status: 403 });
  }

  const existing = (user.favoriteVideos || []).find((f) => f.videoId === videoId);
  if (existing) return NextResponse.json({ favoriteId: existing.id });

  const entry = { id: crypto.randomUUID(), videoId, addedAt: new Date().toISOString() };
  updateUser(user.id, { favoriteVideos: [...(user.favoriteVideos || []), entry] });
  return NextResponse.json({ favoriteId: entry.id });
}
