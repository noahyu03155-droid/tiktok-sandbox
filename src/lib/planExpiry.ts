import { updateUser } from "./db";
import type { User } from "./types";

// Lazy trial-expiry sweep — there's no background job watching the clock,
// so expiry is enforced at the two places a session's planActive flag gets
// (re)computed from the DB: login and /api/billing/refresh-session. Once
// past planExpiresAt, the user's planStatus is flipped back to "none"
// (writing it through so every later check agrees) and the caller treats
// them as unpaid — landing them on /pricing exactly like a never-paid
// account. Admins are never expired.
export function planActiveAfterExpiryCheck(user: User): boolean {
  if (user.role === "admin") return true;
  if (user.planStatus !== "active") return false;
  if (user.planExpiresAt && Date.now() > Date.parse(user.planExpiresAt)) {
    updateUser(user.id, { planStatus: "none", planExpiresAt: null });
    return false;
  }
  return true;
}
