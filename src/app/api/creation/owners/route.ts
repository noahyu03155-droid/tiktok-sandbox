import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listUsers, listCreationOwnersSummary } from "@/lib/db";

export const dynamic = "force-dynamic";

// Admin-only: powers the /creation grid of every member's folder as a
// thumbnail. Includes every member account even if they haven't created a
// single project yet (an empty folder is still a folder) — that's why this
// starts from listUsers() rather than just listCreationOwnersSummary(),
// which only knows about owners who already have at least one project.
export async function GET() {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const summaryByOwner = new Map(listCreationOwnersSummary().map((s) => [s.ownerId, s]));
  const owners = listUsers()
    .filter((u) => u.role === "member")
    .map((u) => {
      const summary = summaryByOwner.get(u.id);
      return {
        ownerId: u.id,
        username: u.username,
        projectCount: summary?.projectCount ?? 0,
        lastUpdatedAt: summary?.lastUpdatedAt ?? u.createdAt,
      };
    })
    .sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());

  return NextResponse.json({ owners });
}
