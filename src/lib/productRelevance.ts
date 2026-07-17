// Two things this module does with a single batched Claude call per
// Top-Selling-Products fetch:
//
// 1. Filters out products that are clearly NOT related to the requested
//    category. FastMoss's own `product_category_id` filter (see
//    fetchCategoryTrendVideos in fastmoss.ts) tags the VIDEO, not the
//    product attached to it — and FastMossProductInfo carries no category
//    field at all — so a video correctly tagged "Pet Supplies" can still
//    carry an attached product like an eyelash serum or a bra. COTORX
//    filters those out itself before displaying, rather than passing
//    FastMoss's messy attachment through to the user.
//
// 2. Scores each surviving product 1-100 for how well it matches what
//    COTORX has learned about the requesting user — the same signals that
//    power the User Data keyword graph (insightTags/journalKeywords/
//    creatorProfile/preferredCategoryLabel, see personalityInsights.ts and
//    userGraph.ts).
//
// Both non-fatal, same convention as personalityInsights.ts: any failure
// (missing API key, timeout, bad JSON) falls back to "keep everything, no
// scores" rather than breaking the Top Selling Products page.

import Anthropic from "@anthropic-ai/sdk";
import { trackAiTask } from "./aiActivity";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

export interface RelevanceCandidate {
  product_id: string;
  title: string;
}

export interface UserContextForScoring {
  preferredCategoryLabel?: string | null;
  insightTags?: string[];
  journalKeywords?: string[];
  interests?: string | null; // creatorProfile.interests
}

export interface RelevanceResult {
  keep: Map<string, boolean>;
  score: Map<string, number>;
}

const SYSTEM_PROMPT = `You clean up a TikTok Shop "Top Selling Products" list for a given category. The list comes from an API that tags CATEGORY on the video that promoted a product, not on the product itself — so some attached products are clearly unrelated to the stated category (e.g. an eyelash serum or a bra showing up under "Pet Supplies"). Mark those as not relevant.

When user-preference context is provided, also score every RELEVANT product 1-100 for how well it matches that specific user's inferred interests/niche — higher means a stronger match. Use 50 when there's no useful signal either way.

Output ONLY a single JSON object (no text outside the JSON, no markdown code fences), shaped exactly like:
{ "items": [ { "product_id": "...", "relevant": true, "score": 1-100 }, ... ] }
Include every product_id you were given exactly once. Omit "score" entirely if you weren't given any user-preference context to score against.`;

export async function filterAndScoreProducts(
  categoryLabel: string,
  candidates: RelevanceCandidate[],
  userContext?: UserContextForScoring | null
): Promise<RelevanceResult> {
  const keep = new Map<string, boolean>();
  const score = new Map<string, number>();
  if (candidates.length === 0) return { keep, score };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    candidates.forEach((c) => keep.set(c.product_id, true));
    return { keep, score };
  }

  const userLines: string[] = [];
  if (userContext?.preferredCategoryLabel) userLines.push(`Registered category: ${userContext.preferredCategoryLabel}`);
  if (userContext?.interests) userLines.push(`Stated interests: ${userContext.interests}`);
  if (userContext?.insightTags?.length) userLines.push(`AI-inferred interest tags: ${userContext.insightTags.slice(0, 20).join(", ")}`);
  if (userContext?.journalKeywords?.length) userLines.push(`Journal keywords: ${userContext.journalKeywords.slice(0, 20).join(", ")}`);
  const wantScores = userLines.length > 0;

  const userMsg = `Category: ${categoryLabel}
${wantScores ? `\nUser preference context (for scoring):\n${userLines.join("\n")}\n` : "\n(No user-preference context available — skip scoring, just filter.)\n"}
Products (product_id: title), one per line:
${candidates.map((c) => `${c.product_id}: ${c.title}`).join("\n")}`;

  try {
    const client = new Anthropic({ apiKey });
    const msg = await trackAiTask(() =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMsg }],
        },
        // A batched but still best-effort call layered on top of the page
        // load — fail fast rather than let the Top Selling Products tab
        // hang waiting on this.
        { timeout: 30_000 }
      )
    );
    const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
    if (!textBlock) throw new Error("no text block");

    let jsonStr = textBlock.text.trim();
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(jsonStr);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    for (const it of items) {
      if (!it || typeof it.product_id !== "string") continue;
      keep.set(it.product_id, it.relevant !== false);
      if (wantScores && typeof it.score === "number" && Number.isFinite(it.score)) {
        score.set(it.product_id, Math.max(1, Math.min(100, Math.round(it.score))));
      }
    }
    // Anything the model didn't return (shouldn't normally happen) — keep
    // it rather than silently dropping it from the list.
    for (const c of candidates) {
      if (!keep.has(c.product_id)) keep.set(c.product_id, true);
    }
  } catch {
    // Best-effort signal — a timeout/parse hiccup here should never break
    // the page; just show everything, unscored, exactly as before this
    // module existed.
    candidates.forEach((c) => keep.set(c.product_id, true));
  }

  return { keep, score };
}
