// Which top-level nav tabs a member's AccessTier (src/lib/types.ts) unlocks.
// Set from the User Data search+tag UI (src/components/UserDataListContent.tsx
// / UserKeywordGraphPageContent.tsx) so an admin can hand out exactly the
// features a given member should have.
//
// This only controls nav visibility/feature access, NOT data ownership —
// every member's own Video Analysis + Creation content is private to them
// regardless of tier (see src/lib/videoAuth.ts / src/lib/creationAuth.ts).
// A real UserRole "admin" (the actual site owner) always bypasses this
// entirely and sees every tab including /user-data — see canSeeTab below.
import type { AccessTier } from "./types";

export const NAV_KEYS = ["video", "trends", "creators", "creation"] as const;
export type NavKey = (typeof NAV_KEYS)[number];

// "all" = every current + future nav key (used for "business" — the top
// tag, unchanged in meaning from the old "admin" tag it replaced — so it
// automatically inherits any tab added later, without needing an update
// here every time a new section ships). Tab sets themselves are the exact
// same ones the old business/vip/admin naming resolved to; only the labels
// changed to match the 3 billing plan names — see AccessTier's doc comment
// in src/lib/types.ts.
const TIER_TABS: Record<AccessTier, readonly NavKey[] | "all"> = {
  starter: ["video", "trends", "creation"],
  pro: "all",
  business: "all",
};

// Unset (undefined/null) means no tier has been assigned yet — treated as
// "business" (the broadest of the three) so members who existed before this
// field was added keep seeing what they already could.
export function tabsForTier(tier: AccessTier | null | undefined): readonly NavKey[] {
  const resolved = TIER_TABS[tier || "business"];
  return resolved === "all" ? NAV_KEYS : resolved;
}

export function canSeeTab(tab: NavKey, isSuperAdmin: boolean, tier: AccessTier | null | undefined): boolean {
  if (isSuperAdmin) return true;
  return tabsForTier(tier).includes(tab);
}
