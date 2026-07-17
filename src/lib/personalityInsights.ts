// Turns a short description of something a Creation-workspace member just
// DID (broke down a reference video, generated a product script from one,
// imported a chain's worth of stages, etc.) into a handful of short ENGLISH
// tags inferring their likely niche, target audience, personality traits,
// or content/shopping preferences — the automated, behavior-driven
// counterpart to the journal's mergeJournalKeywords (src/lib/journal.ts),
// which extracts signal from what the user directly WROTE instead.
//
// Accumulates on User.insightTags and shows up as an "insights" branch on
// the admin-only User Data keyword graph (src/components/UserKeywordGraph.tsx,
// via buildProfileBranches in src/lib/userGraph.ts).
//
// Deliberately always English, regardless of what language the source video
// or product happens to be in — unlike journal keywords (kept in the user's
// own words), these are the AI's own inference, and the site standardizes on
// English for system-generated labels (see also the Trends API's English-only
// error-string cleanup from this same project).
//
// Every call site MUST treat this as non-fatal, best-effort signal — never
// let a failure here break the actual action (breakdown / script generation)
// the member was trying to do. Same non-fatal convention as
// deriveShootingGuide in src/lib/shootingGuide.ts.

import Anthropic from "@anthropic-ai/sdk";
import { trackAiTask } from "./aiActivity";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT = `You infer a content creator's likely niche, target audience, personality traits, and content/shopping preferences purely from an action they just took on a video-creation platform — e.g. which reference video they chose to break down, or which product they built a script around. You'll receive a short description of that action's actual content: video metadata, an AI summary of the video, transcript-derived selling points, and/or product details.

Infer 0-5 short tags (2-4 words each) capturing what THIS SPECIFIC action reveals about who this person is. Be modest and specific — reasonable inference from their behavior, not wild speculation. For example, a single pet-product video doesn't necessarily mean "loves animals personally," but it IS reasonable signal for "works in the pet niche" or "targets pet owners." Prefer tags about their creative/professional profile (niche, audience, content style, working pattern) over overreaching personal-life claims. It's completely fine to return zero tags if there's not enough signal in what you were given — don't force it.

Always write every tag in English, regardless of what language the source material (title, transcript, product name, etc.) is in.

Output ONLY a single JSON object (no text outside the JSON, no markdown code fences):
{ "tags": ["tag one", "tag two"] }`;

export async function inferActionInsightTags(context: string): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const msg = await trackAiTask(() =>
    client.messages.create(
      {
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: context }],
      },
      // Short, best-effort call layered on top of a bigger action — fail
      // fast rather than let a hung request stall something the user is
      // actively waiting on (same reasoning as analyze.ts's timeout).
      { timeout: 30_000 }
    )
  );

  const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  if (!textBlock) return [];

  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed.tags)
      ? parsed.tags.filter((t: unknown): t is string => typeof t === "string" && t.trim() !== "").slice(0, 5)
      : [];
  } catch {
    // Best-effort signal — a parse hiccup here should never surface as an
    // error to the user; just contribute nothing this time.
    return [];
  }
}

// Same merge shape as mergeJournalKeywords (src/lib/journal.ts): newest tags
// first, case-insensitive de-dupe, capped so the graph doesn't get
// overcrowded over months of activity.
export function mergeInsightTags(existing: string[] | undefined, fresh: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const t of [...fresh, ...(existing || [])]) {
    const key = t.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(t.trim());
    if (merged.length >= 30) break;
  }
  return merged;
}
