// Password hashing for the multi-user account system — Node's built-in
// crypto.scrypt, no extra dependency (bcrypt/argon2 need native bindings,
// which is exactly the kind of thing this project avoids per db.ts's
// "no native SQLite module" reasoning). Only ever used inside real Node API
// routes, never in Edge middleware (scryptSync isn't available there) —
// middleware only verifies the already-issued session token (see auth.ts),
// it never re-checks a raw password.

import crypto from "crypto";

const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, "hex");
  const candidateBuffer = crypto.scryptSync(password, salt, KEY_LEN);
  // Different-length buffers would throw in timingSafeEqual rather than
  // just comparing false — guard explicitly (a corrupted/foreign hash
  // format shouldn't be able to crash a login attempt).
  if (hashBuffer.length !== candidateBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, candidateBuffer);
}
