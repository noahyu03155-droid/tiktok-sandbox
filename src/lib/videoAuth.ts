// Ownership guard for Video Analysis, mirroring src/lib/creationAuth.ts's
// requireProjectAccess — but shaped to slot in AFTER each
// /api/videos/[id]/... route's own `getVideo(params.id)` + not-found check,
// rather than replacing it (every one of those ~18 routes already reads
// `video.*` fields right after that check, so a single extra guard line is
// a much smaller diff than restructuring each one around a wrapper).
//
// Only a "manual" Video-Analysis import (pasted directly on the Home board,
// via /api/analyze) is private per member. A "trend"/"creator" sourced video
// is the shared FastMoss/Creator-Tracker catalog entry every member browses
// on Trend Analysis / Creator Tracker — the same underlying TikTok video,
// not any one member's own content — so it stays visible to any signed-in
// member regardless of who first hydrated it into a VideoRecord. A "manual"
// video with no ownerId at all is a pre-existing record from before this
// field existed; treated as visible only to a real admin so it doesn't
// silently leak to whichever member happens to guess/hit its id.
import { getCurrentUser, type CurrentUser } from "./session";
import type { VideoRecord } from "./types";

export function canAccessVideo(video: VideoRecord, user: CurrentUser): boolean {
  if (video.source !== "manual") return true;
  if (user.role === "admin") return true;
  return !!video.ownerId && video.ownerId === user.userId;
}

// Returns null when access is fine, or the {error, status} to respond with
// otherwise. Called right after each route's existing not-found check:
//
//   const video = getVideo(params.id);
//   if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
//   const accessErr = videoAccessError(video);
//   if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });
export function videoAccessError(video: VideoRecord): { error: string; status: number } | null {
  const user = getCurrentUser();
  if (!user) return { error: "Not signed in", status: 401 };
  if (canAccessVideo(video, user)) return null;
  return { error: "You don't have access to this video", status: 403 };
}
