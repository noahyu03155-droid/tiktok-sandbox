import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getPromoCodeByCode } from "@/lib/db";

export const dynamic = "force-dynamic";

// Buyer-facing code check for the /pricing page — MUST stay in
// middleware.ts's PLAN_EXEMPT_PATHS (the whole point is that the caller is
// a signed-in-but-unpaid user sitting at the paywall; without the
// exemption this request gets 402'd before it runs — the /api/logout
// lesson). Returns only what the buyer needs to see; commission details
// stay admin-side.
export async function POST(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const codeRaw = typeof body?.code === "string" ? body.code.trim() : "";
  if (!codeRaw) return NextResponse.json({ valid: false, error: "Enter a code." }, { status: 400 });

  const promo = getPromoCodeByCode(codeRaw);
  if (!promo || !promo.active) {
    return NextResponse.json({ valid: false, error: "This code isn't valid." }, { status: 404 });
  }
  return NextResponse.json({
    valid: true,
    code: promo.code,
    kind: promo.kind,
    percentOff: promo.percentOff,
    trialDays: promo.kind === "trial" ? promo.trialDays ?? 7 : undefined,
  });
}
