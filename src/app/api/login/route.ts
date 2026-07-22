import { NextRequest, NextResponse } from "next/server";
import { planActiveAfterExpiryCheck } from "@/lib/planExpiry";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { getUserByUsername } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = (body.username || "").trim();
  const password = (body.password || "").trim();

  // Checks the real users store now, not a raw env var comparison — the
  // original ADMIN_USERNAME/ADMIN_PASSWORD account still works because
  // db.ts seeds it into the store as an "admin" role user the first time
  // the app runs with no users yet (see seedAdminUser in db.ts).
  const user = username ? getUserByUsername(username) : null;
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Incorrect username or password" }, { status: 401 });
  }

  // planActive is read fresh off the DB record at login time (unlike
  // register, where a brand-new account can never already have a plan) —
  // admin bypasses the gate regardless (see middleware.ts), so this only
  // really matters for "member" accounts.
  const planActive = planActiveAfterExpiryCheck(user); // trial codes lapse here — see planExpiry.ts
  const token = await createSessionToken({ userId: user.id, username: user.username, role: user.role, planActive });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  });
  return res;
}
