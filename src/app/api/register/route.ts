import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { createUser, getUserByUsername, updateUser } from "@/lib/db";

// Self-service signup for the "Creation" workspace — every member gets
// their own account and their own creation projects (see the Creation
// section, built on top of this). Always creates a "member" role account;
// the one "admin" role account comes from ADMIN_USERNAME/ADMIN_PASSWORD
// (seeded automatically, see db.ts's seedAdminUser) — there's no public
// way to self-register as admin.
//
// Username is restricted to [a-zA-Z0-9_-] because the session token (see
// auth.ts) is a plain dot-joined string, not JSON — a "." in a username
// would break parsing it back out of the cookie.
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = (body.username || "").trim();
  const password = (body.password || "").trim();
  const categoryId = typeof body.categoryId === "string" && body.categoryId.trim() ? body.categoryId.trim() : null;
  const categoryLabel =
    typeof body.categoryLabel === "string" && body.categoryLabel.trim() ? body.categoryLabel.trim() : null;

  if (!USERNAME_RE.test(username)) {
    return NextResponse.json(
      { error: "Username must be 3-32 characters, letters/numbers/underscore/hyphen only." },
      { status: 400 }
    );
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }
  if (getUserByUsername(username)) {
    return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
  }

  const user = createUser(username, password, "member");
  if (categoryId) {
    updateUser(user.id, { preferredCategoryId: categoryId, preferredCategoryLabel: categoryLabel });
  }
  const token = await createSessionToken({ userId: user.id, username: user.username, role: user.role });
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
