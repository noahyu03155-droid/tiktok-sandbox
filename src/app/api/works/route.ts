import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

// "Your Works" — see the User.myWorks doc comment in src/lib/types.ts.
// Unlike /api/favorites/videos, entries here are snapshots (url/title) at
// render time, not a pointer to a re-derivable VideoRecord — there's no
// such record for a raw storyboard/manual-edit render.

// GET: this member's auto-saved renders, newest first.
export async function GET() {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const works = [...(user.myWorks || [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return NextResponse.json({ works });
}

// POST { url, title, source } — called automatically right after a
// storyboard chain render or a Manual Edit export finishes (fire-and-forget,
// no user action needed). Not deduped by url like the favorites routes are
// by videoId/productId — a chain can legitimately be re-rendered/re-exported
// multiple times and each finished cut is its own work worth keeping.
export async function POST(req: NextRequest) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const url = body?.url;
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "Untitled work";
  const source = body?.source === "manual-edit" ? "manual-edit" : "storyboard";
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const entry = { id: crypto.randomUUID(), url, title, source: source as "storyboard" | "manual-edit", createdAt: new Date().toISOString() };
  updateUser(user.id, { myWorks: [...(user.myWorks || []), entry] });
  return NextResponse.json({ id: entry.id });
}
