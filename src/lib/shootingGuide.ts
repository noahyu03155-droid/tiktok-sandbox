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

const BASE_SYSTEM_PROMPT = `You are a TikTok video-production coach. You'll receive the 6-stage funnel breakdown of a viral video (each stage's summary and a matching transcript quote). For each of the 6 stages, give short, concrete filming guidance a creator could act on without watching the original: the core camera angle/framing, the tone/energy, and the pace/cutting rhythm.

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

// Filming location the creator plans to actually shoot in — asked via a
// popup right before Breakdown / Breakdown chain / Generate product script
// (see StoryboardCanvas.tsx's location-prompt modal), since angle/tone/pace
// guidance that's realistic outdoors (natural light, handheld, environment
// in frame) is often impractical indoors (controlled lighting, tighter
// framing, less room to move) and vice versa. Optional — a caller that
// doesn't pass one gets the same location-agnostic guidance as before.
export type ShootingLocation = "indoor" | "outdoor";

const LOCATION_GUIDANCE: Record<ShootingLocation, string> = {
  indoor: "The creator will be filming INDOORS. Favor guidance that's realistic indoors — controlled/artificial lighting, tighter framing, stable or slow handheld movement, limited background space — rather than anything that assumes outdoor light or an open environment.",
  outdoor: "The creator will be filming OUTDOORS. Favor guidance that's realistic outdoors — natural light, more environment/background in frame, room for movement or walking shots — rather than anything that assumes controlled indoor lighting or a tight studio-like space.",
};

export interface ShootingGuideEntry {
  angle: string;
  tone: string;
  pace: string;
}

export async function deriveShootingGuide(
  structure: FunnelStage[],
  location?: ShootingLocation | null
): Promise<Record<string, ShootingGuideEntry>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const systemPrompt = location
    ? `${BASE_SYSTEM_PROMPT}\n\n${LOCATION_GUIDANCE[location]}`
    : BASE_SYSTEM_PROMPT;

  const userContent = structure
    .map((s) => `[${s.key}] ${s.label}\nSummary: ${s.summary}\nQuote: "${s.quote}"`)
    .join("\n\n");

  const msg = await trackAiTask(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
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
