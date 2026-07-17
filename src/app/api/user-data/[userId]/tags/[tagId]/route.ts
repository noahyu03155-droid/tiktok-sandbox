import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: { userId: string; tagId: string } }) {
  const admin = getCurrentUser();
  if (!admin || admin.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const target = getUserById(params.userId);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const nodeId = `custom:${params.tagId}`;
  const nextTags = (target.customTags || []).filter((t) => t.id !== params.tagId);
  const nextPositions = { ...(target.graphPositions || {}) };
  delete nextPositions[nodeId];
  const nextOverrides = { ...(target.graphParentOverrides || {}) };
  delete nextOverrides[nodeId];

  updateUser(target.id, { customTags: nextTags, graphPositions: nextPositions, graphParentOverrides: nextOverrides });
  return NextResponse.json({ ok: true });
}
