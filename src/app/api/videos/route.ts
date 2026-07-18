import { NextRequest, NextResponse } from "next/server";
import { deleteVideoRecord, getVideo, listVideos } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { canAccessVideo } from "@/lib/videoAuth";

export const dynamic = "force-dynamic";

// Filtered per-member — see src/lib/videoAuth.ts. A "manual" Video Analysis
// import only comes back for its owner (or a real admin); "trend"/"creator"
// catalog videos stay visible to everyone signed in, same as before this
// field existed.
export async function GET() {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const videos = listVideos().filter((v) => canAccessVideo(v, user));
  return NextResponse.json({ videos });
}

// Bulk delete — used by the Video Analysis board's select-and-delete mode.
// Body: { ids: string[] }. Silently skips any id the caller doesn't own
// (rather than erroring the whole batch) so a stray/foreign id in the
// selection can't be used to delete someone else's video.
export async function DELETE(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "Body must include ids[]" }, { status: 400 });
  }
  let deleted = 0;
  for (const id of ids) {
    const video = getVideo(id);
    if (!video || !canAccessVideo(video, user)) continue;
    deleteVideoRecord(id);
    deleted++;
  }
  return NextResponse.json({ ok: true, deleted });
}
