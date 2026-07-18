import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";
import type { AccessTier } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_TIERS: AccessTier[] = ["business", "vip", "admin"];

// Admin-only: set which nav tabs a member sees (src/lib/accessTier.ts) —
// business/vip/admin here is purely a feature-visibility tag, distinct from
// the real login-level UserRole (see the AccessTier doc comment in
// src/lib/types.ts). Mirrors the tags/route.ts POST right above this one.
export async function PATCH(req: NextRequest, { params }: { params: { userId: string } }) {
  const admin = getCurrentUser();
  if (!admin || admin.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const target = getUserById(params.userId);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const tier = body?.accessTier;
  if (tier !== null && !VALID_TIERS.includes(tier)) {
    return NextResponse.json({ error: "accessTier must be one of business/vip/admin, or null to clear it" }, { status: 400 });
  }

  updateUser(target.id, { accessTier: tier });
  return NextResponse.json({ accessTier: tier });
}
