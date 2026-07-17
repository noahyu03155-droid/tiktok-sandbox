import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

// Admin-only: persist dragged node positions and/or reassigned parent
// (reconnected) edges on a member's User Data keyword graph. Body is a
// partial merge — only send what changed — e.g. { positions: {...} } or
// { parentOverrides: {...} } or both.
export async function PATCH(req: NextRequest, { params }: { params: { userId: string } }) {
  const admin = getCurrentUser();
  if (!admin || admin.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const target = getUserById(params.userId);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const patch: { graphPositions?: Record<string, { x: number; y: number }>; graphParentOverrides?: Record<string, string> } = {};

  if (body.positions && typeof body.positions === "object") {
    patch.graphPositions = { ...(target.graphPositions || {}), ...body.positions };
  }
  if (body.parentOverrides && typeof body.parentOverrides === "object") {
    patch.graphParentOverrides = { ...(target.graphParentOverrides || {}), ...body.parentOverrides };
  }

  updateUser(target.id, patch);
  return NextResponse.json({ ok: true });
}
