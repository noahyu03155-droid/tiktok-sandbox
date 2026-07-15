// Reads the current request's session info that middleware.ts already
// verified and forwarded as headers (x-user-id / x-user-role / x-username)
// — server components and API routes call this instead of re-verifying the
// session cookie themselves. Only usable in the Node/Edge server runtime
// (uses next/headers), never in "use client" components.

import { headers } from "next/headers";
import type { UserRole } from "./types";

export interface CurrentUser {
  userId: string;
  username: string;
  role: UserRole;
}

// Returns null if somehow called on a request middleware didn't gate (it
// gates everything except the public paths listed there, so in practice
// this should only be null on a public route, which shouldn't be calling
// this in the first place).
export function getCurrentUser(): CurrentUser | null {
  const h = headers();
  const userId = h.get("x-user-id");
  const username = h.get("x-username");
  const role = h.get("x-user-role");
  if (!userId || !username || (role !== "admin" && role !== "member")) return null;
  return { userId, username, role };
}
