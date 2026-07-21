import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById } from "@/lib/db";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SEC } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Re-syncs the session cookie's planActive flag from the DB. Exists for the
// admin-grant flow: when an admin activates a plan for a user via the User
// Data tier selector (see /api/user-data/[userId]/tier), the DB says
// "active" but that user's own cookie still says planActive=false — and
// src/middleware.ts's paywall gate only reads the cookie (it runs on the
// edge, no DB access). The admin can't rewrite someone else's cookie, so
// the fix has to come from the stuck user's OWN browser: the /pricing page
// calls this on load, and if the DB now says active, we re-sign the cookie
// and the client redirects into the app. Lives under /api/billing/ because
// that whole prefix is PLAN_EXEMPT in middleware.ts — anywhere else and a
// planActive=false cookie would get this very request 402'd before it
// could do its job (the same trap /api/logout fell into once).
export async function POST() {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dbUser = getUserById(sessionUser.userId);
  const active = sessionUser.role === "admin" || dbUser?.planStatus === "active";

  const res = NextResponse.json({ active });
  // Only re-sign when this actually UPGRADES the cookie — never downgrade
  // here (plan-lapse handling stays wherever it's deliberately implemented,
  // not as a surprise side effect of a sync poll).
  if (active) {
    const token = await createSessionToken({
      userId: sessionUser.userId,
      username: sessionUser.username,
      role: sessionUser.role,
      planActive: true,
    });
    res.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SEC,
      path: "/",
    });
  }
  return res;
}
