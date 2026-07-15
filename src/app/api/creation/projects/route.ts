import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { createCreationProject, listCreationProjectsByOwner } from "@/lib/db";

export const dynamic = "force-dynamic";

// Every login account gets its own Creation space. GET lists the current
// user's own projects; an admin can pass ?ownerId=<userId> to drill into a
// specific member's folder (the grid of member thumbnails on /creation
// links here). A non-admin passing someone else's ownerId is ignored —
// they always just get their own list back.
export async function GET(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const requestedOwnerId = req.nextUrl.searchParams.get("ownerId");
  const ownerId = requestedOwnerId && user.role === "admin" ? requestedOwnerId : user.userId;

  const projects = listCreationProjectsByOwner(ownerId);
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "Untitled project";

  const project = createCreationProject(user.userId, title);
  return NextResponse.json({ project });
}
