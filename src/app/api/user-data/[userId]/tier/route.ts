import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";
import type { AccessTier } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_TIERS: AccessTier[] = ["starter", "pro", "business"];

// Admin-only: set a member's tier. Two things happen at once:
// 1. accessTier (nav-tab visibility, src/lib/accessTier.ts) is set.
// 2. The SAME-NAMED billing plan is granted as active (a comp / manual
//    grant) — without this, an admin-tagged "Starter" account still had
//    planStatus "none" and stayed stuck at the /pricing paywall, which is
//    exactly the confusion the tag/plan name reuse invited ("I gave them
//    Starter, why can't they get in?"). The user's browser picks the
//    grant up via /api/billing/refresh-session (polled by the pricing
//    page) or on their next login — an admin can't rewrite someone
//    else's session cookie from here.
// Clearing the tier (null) deliberately does NOT touch billing — revoking
// a possibly-PAID plan should never be a side effect of removing a tab tag.
export async function PATCH(req: NextRequest, { params }: { params: { userId: string } }) {
  const admin = getCurrentUser();
  if (!admin || admin.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const target = getUserById(params.userId);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const tier = body?.accessTier;
  if (tier !== null && !VALID_TIERS.includes(tier)) {
    return NextResponse.json({ error: "accessTier must be one of starter/pro/business, or null to clear it" }, { status: 400 });
  }

  if (tier === null) {
    updateUser(target.id, { accessTier: tier });
  } else {
    updateUser(target.id, {
      accessTier: tier,
      plan: tier,
      billingCycle: target.billingCycle ?? "monthly",
      seats: target.seats ?? 0,
      planStatus: "active",
      planSelectedAt: new Date().toISOString(),
    });
  }
  return NextResponse.json({ accessTier: tier });
}
