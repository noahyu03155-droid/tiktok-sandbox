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

export async function createSessionToken(username: string): Promise<string> {
  const expires = Date.now() + MAX_AGE_SEC * 1000;
  const payload = `${username}.${expires}`;
  const sig = await hmac(payload);
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [username, expiresStr, sig] = parts;
  const expected = await hmac(`${username}.${expiresStr}`);
  if (expected !== sig) return null;
  const expires = Number(expiresStr);
  if (!expires || Date.now() > expires) return null;
  return username;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_MAX_AGE_SEC = MAX_AGE_SEC;
