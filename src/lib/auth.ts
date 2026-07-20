// Lightweight signed-cookie session, using Web Crypto (works in both the
// Next.js Edge middleware runtime and normal Node runtime — no extra deps).

const COOKIE_NAME = "session";
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set in .env");
  return secret;
}

async function hmac(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Buffer.from(sig).toString("base64url");
}

// Multi-user login: the session now carries the account's id and role, not
// just its username (needed so the Creation workspace can tell an admin
// apart from a member, and load the right account's data). Usernames are
// restricted to [a-zA-Z0-9_-] at registration (see /api/register) — this
// format is a plain dot-joined string, not JSON, so a "." inside a
// username would break the split() below.
export interface SessionUser {
  userId: string;
  username: string;
  role: "admin" | "member";
  // Whether this account currently has an active billing plan (see
  // src/lib/types.ts's User.planStatus) — embedded directly in the signed
  // token, NOT re-read from the DB on every request, because middleware.ts
  // runs on the Edge runtime and this project's db.ts is a plain `fs`-backed
  // JSON store (Node-only, not Edge-compatible). That means the flag can go
  // stale until the session is re-issued — /api/billing/select-plan does
  // exactly that (re-signs the cookie with planActive=true) right after a
  // "purchase" so the gate lifts immediately without a fresh login.
  planActive: boolean;
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  const expires = Date.now() + MAX_AGE_SEC * 1000;
  const payload = `${user.userId}.${user.username}.${user.role}.${user.planActive ? "1" : "0"}.${expires}`;
  const sig = await hmac(payload);
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 6) return null;
  const [userId, username, role, planActiveStr, expiresStr, sig] = parts;
  const payload = `${userId}.${username}.${role}.${planActiveStr}.${expiresStr}`;
  const expected = await hmac(payload);
  if (expected !== sig) return null;
  const expires = Number(expiresStr);
  if (!expires || Date.now() > expires) return null;
  if (role !== "admin" && role !== "member") return null;
  return { userId, username, role, planActive: planActiveStr === "1" };
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_MAX_AGE_SEC = MAX_AGE_SEC;
