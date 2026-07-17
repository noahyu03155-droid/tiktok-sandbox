// One extra lightweight Claude call layered on top of the storyboard
// Breakdown flow (see the breakdown API routes): turns the 6-stage funnel
// analysis into short, per-stage filming guidance (camera angle / tone /
// pace) shown in the Shooting Guide panel next to each card's Script box in
// StoryboardCanvas.tsx. Deliberately separate from src/lib/analyze.ts —
// that's the shared analyzer Video Analysis also uses; this stays scoped to
// the storyboard breakdown. Callers must treat a failure here as
// non-fatal: the breakdown's main value is the 6 stage cards themselves.
import Anthropic from "@anthropic-ai/sdk";
import { trackAiTask } from "./aiActivity";
import type { FunnelStage } from "./types";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT = `You are a TikTok video-production coach. You'll receive the 6-stage funnel breakdown of a viral video (each stage's summary and a matching transcript quote). For each of the 6 stages, give short, concrete filming guidance a creator could act on without watching the original: the core camera angle/framing, the tone/energy, and the pace/cutting rhythm.

Output ONLY a single JSON object (no text outside the JSON, no markdown code fences):
{
  "reaction": { "angle": "...", "tone": "...", "pace": "..." },
  "hook": { "angle": "...", "tone": "...", "pace": "..." },
  "pain_point": { "angle": "...", "tone": "...", "pace": "..." },
  "product_intro": { "angle": "...", "tone": "...", "pace": "..." },
  "desired_outcome": { "angle": "...", "tone": "...", "pace": "..." },
  "cta": { "angle": "...", "tone": "...", "pace": "..." }
}

Requirements:
- Each field should be a short phrase (roughly 3-8 words), not a sentence.
- Base every answer on the actual stage summary/quote given — don't give generic boilerplate that could apply to any video.
- Write in English.`;

export interface ShootingGuideEntry {
  angle: string;
  tone: string;
  pace: string;
}

export async function deriveShootingGuide(structure: FunnelStage[]): Promise<Record<string, ShootingGuideEntry>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const userContent = structure
    .map((s) => `[${s.key}] ${s.label}\nSummary: ${s.summary}\nQuote: "${s.quote}"`)
    .join("\n\n");

  const msg = await trackAiTask(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    })
  );

  const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  if (!textBlock) throw new Error("Claude returned no text content");

  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse shooting guide JSON: ${jsonStr.slice(0, 500)}`);
  }
}
