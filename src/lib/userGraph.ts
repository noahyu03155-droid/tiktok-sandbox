import type { User } from "./types";

export type ProfileBranchKind = "category" | "age" | "occupation" | "interests" | "experience" | "style" | "journal" | "insights";

export interface ProfileBranch {
  kind: ProfileBranchKind;
  values: string[];
}

// Splits a free-text interests field (e.g. "宠物、健身, travel / cooking")
// into individual keyword leaves, covering the common separators someone
// might naturally type in either language. Capped at 8 keywords so one
// long run-on sentence can't overcrowd the graph.
function splitInterests(raw: string): string[] {
  return raw
    .split(/[、，,\/\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

// Builds the list of non-empty "keyword branches" for a user's profile map
// (rendered by UserKeywordGraph) — purely derived from what they've
// actually filled in: the category picked at registration
// (preferredCategoryLabel) and the 5-question onboarding form
// (creatorProfile). Any field left blank/skipped simply produces no
// branch — the graph always reflects only what's actually known, never a
// placeholder for missing data.
export function buildProfileBranches(user: User): ProfileBranch[] {
  const branches: ProfileBranch[] = [];

  if (user.preferredCategoryLabel) {
    const values = user.preferredCategoryLabel
      .split("›")
      .map((s) => s.trim())
      .filter(Boolean);
    if (values.length > 0) branches.push({ kind: "category", values });
  }

  const p = user.creatorProfile;
  if (p?.ageRange) branches.push({ kind: "age", values: [p.ageRange] });
  if (p?.occupation) branches.push({ kind: "occupation", values: [p.occupation] });
  if (p?.interests) {
    const values = splitInterests(p.interests);
    if (values.length > 0) branches.push({ kind: "interests", values });
  }
  if (p?.experienceLevel) branches.push({ kind: "experience", values: [p.experienceLevel] });
  if (p?.contentStyle) branches.push({ kind: "style", values: [p.contentStyle] });
  if (user.journalKeywords && user.journalKeywords.length > 0) {
    branches.push({ kind: "journal", values: user.journalKeywords.slice(0, 12) });
  }
  // AI-inferred, always-English tags from on-platform ACTIONS (breaking
  // down a reference video, generating a product script, etc.) — see
  // src/lib/personalityInsights.ts. Distinct from the "journal" branch
  // above, which comes from what the user explicitly wrote.
  if (user.insightTags && user.insightTags.length > 0) {
    branches.push({ kind: "insights", values: user.insightTags.slice(0, 12) });
  }

  return branches;
}
