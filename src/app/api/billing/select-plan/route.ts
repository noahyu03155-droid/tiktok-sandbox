import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getPromoCodeByCode, recordPromoCodeUse, updateUser } from "@/lib/db";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { planById, cycleById, planCyclePrice, seatCyclePrice } from "@/lib/billing";

export const dynamic = "force-dynamic";

// "Purchase" a plan — see src/lib/types.ts's PlanId/BillingCycle doc
// comment: there is NO real payment processor wired in here yet. This just
// validates the selection against the shared billing.ts plan definitions
// (never trusting whatever price the client thinks it's paying), writes it
// onto the User record, and re-signs the session cookie with
// planActive=true so src/middleware.ts's billing gate lifts immediately —
// no separate login step needed. Swapping in real Stripe Checkout later
// means: this route becomes "create a Checkout session and redirect there"
// instead of writing planStatus directly, and a new webhook route does the
// actual updateUser(...) + doesn't need to touch the cookie at all (Stripe
// redirects back to the app, which just re-fetches its own session — or,
// simplest, the webhook can't set cookies at all since it's not a browser
// request, so re-signing would need to happen from the success-redirect
// page's own API call instead, same shape as this route already has).
export async function POST(req: NextRequest) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const plan = planById(typeof body.plan === "string" ? body.plan : undefined);
  const cycle = cycleById(typeof body.billingCycle === "string" ? body.billingCycle : undefined);
  if (!plan || !cycle) {
    return NextResponse.json({ error: "Invalid plan or billing cycle." }, { status: 400 });
  }

  const rawSeats = Number(body.seats);
  const seats = Number.isFinite(rawSeats) ? Math.max(0, Math.min(plan.maxExtraSeats, Math.round(rawSeats))) : 0;
  if (seats > 0 && !plan.extraSeatAllowed) {
    return NextResponse.json({ error: `${plan.nameZh} does not support extra seats.` }, { status: 400 });
  }

  // Promo code (optional) — validated server-side against the stored codes,
  // never trusting a client-claimed discount. Order value is computed from
  // the same shared billing helpers the UI uses, then the code's percentOff
  // comes off the top; affiliate codes additionally log a commission for
  // that creator (tallied on the admin /codes page).
  const promoCodeRaw = typeof body.promoCode === "string" ? body.promoCode.trim() : "";
  const promo = promoCodeRaw ? getPromoCodeByCode(promoCodeRaw) : null;
  if (promoCodeRaw && (!promo || !promo.active)) {
    return NextResponse.json({ error: "That promo code isn't valid." }, { status: 400 });
  }

  const planPrice = planCyclePrice(plan, cycle);
  const seatPrice = seatCyclePrice(plan, cycle);
  const orderTotal = planPrice.total + seatPrice.total * seats;
  const discountUsd = promo ? Math.round(orderTotal * (promo.percentOff / 100) * 100) / 100 : 0;
  const paidTotal = Math.round((orderTotal - discountUsd) * 100) / 100;
  const commissionUsd =
    promo && promo.kind === "affiliate" ? Math.round(paidTotal * (promo.commissionPercent / 100) * 100) / 100 : 0;

  updateUser(sessionUser.userId, {
    plan: plan.id,
    billingCycle: cycle.id,
    seats,
    planStatus: "active",
    planSelectedAt: new Date().toISOString(),
  });

  if (promo) {
    recordPromoCodeUse(promo.id, {
      userId: sessionUser.userId,
      username: sessionUser.username,
      plan: plan.id,
      billingCycle: cycle.id,
      seats,
      totalUsd: paidTotal,
      discountUsd,
      commissionUsd,
      at: new Date().toISOString(),
    });
  }

  const token = await createSessionToken({
    userId: sessionUser.userId,
    username: sessionUser.username,
    role: sessionUser.role,
    planActive: true,
  });
  const res = NextResponse.json({ ok: true, plan: plan.id, billingCycle: cycle.id, seats });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  });
  return res;
}
