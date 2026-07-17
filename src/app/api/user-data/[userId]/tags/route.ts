import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

// Admin-only: add a manual "custom tag" to a member's User Data keyword
// graph (see src/components/UserKeywordGraph.tsx and the doc comments on
// User.customTags in src/lib/types.ts). New tags start unattached (render
// under "root" until the admin drags them onto a branch — see the graph
// PATCH route below).
export async function POST(req: NextRequest, { params }: { params: { userId: string } }) {
  const admin = getCurrentUser();
  if (!admin || admin.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const target = getUserById(params.userId);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  if (!label) return NextResponse.json({ error: "Label is required" }, { status: 400 });

  const tag = { id: crypto.randomUUID(), label, createdAt: new Date().toISOString() };
  const nextTags = [...(target.customTags || []), tag];
  updateUser(target.id, { customTags: nextTags });

  return NextResponse.json({ tag });
}
