import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

// DELETE — un-favorite by videoId (not by favorite entry id, so the client
// doesn't need to track the entry id separately from the video it favorited).
export async function DELETE(_req: Request, { params }: { params: { videoId: string } }) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const next = (user.favoriteVideos || []).filter((f) => f.videoId !== params.videoId);
  updateUser(user.id, { favoriteVideos: next });
  return NextResponse.json({ ok: true });
}
