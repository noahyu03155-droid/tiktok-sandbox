import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult, GeneratedScriptStage, ReactionEmotion } from "./types";
import type { ShopifyProductSummary } from "./shopify";
import { trackAiTask } from "./aiActivity";

// Builds the extra prompt fragment for a user-picked reaction emotion (see
// REACTION_EMOTIONS in types.ts and the reaction-emotion picker in
// StoryboardCanvas.tsx) — shared by both generateScriptForProduct and
// generateShoppableScriptFromChain below so the wording can't drift between
// the two entry points. Returns "" when no emotion was picked, leaving the
// existing behavior (Claude picks whatever reaction fits best) unchanged.
function reactionEmotionInstruction(emotion: ReactionEmotion | null | undefined): string {
  if (!emotion) return "";
  return `\n\n---\n\nThe user has specifically chosen "${emotion}" as the emotional reaction this script's opening "Reaction" beat should evoke in the viewer. Write that beat's script/direction to clearly land this specific emotion — don't default to a generic reaction. Let it color the tone of the rest of the script too, but the Reaction beat itself must unmistakably be "${emotion}".`;
}

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT = `You are a senior TikTok e-commerce content strategist. You help brand teams adapt a proven viral video's structure into a new script for one of their own products, to brief a creator/influencer for filming.

You'll receive:
1. A full breakdown of a viral video (golden hook, 6-stage structure: Reaction / Hook / Pain Point / Product Intro / Desired Outcome / CTA, and its copywriting/selling-point techniques)
2. Our own product's info (title, description, tags, category)
3. Optionally, a short profile of the creator who will actually film this script (age range, occupation, interests, on-camera experience, preferred content style)

Based on the viral video's structure and techniques, generate a new script for our product, still organized around the same 6 stages (Reaction, Hook, Pain Point, Product Intro, Desired Outcome, CTA), but with content swapped for our product's actual selling points and use cases. You can reference the original video's tone and pacing, but don't copy it verbatim.

Output ONLY a single JSON object (no text outside the JSON, no markdown code fences), in this format:

{
  "stages": [
    {
      "label": "Reaction",
      "script": "Suggested line(s) for the creator to say in this beat — conversational, ready to read aloud as-is",
      "direction": "A short filming/direction note for the creator, e.g. facial expression, action, camera suggestion"
    },
    { "label": "Hook", "script": "...", "direction": "..." },
    { "label": "Pain Point / Old Solution", "script": "...", "direction": "..." },
    { "label": "Product Intro", "script": "...", "direction": "..." },
    { "label": "Desired Outcome", "script": "...", "direction": "..." },
    { "label": "CTA", "script": "...", "direction": "..." }
  ]
}

Writing principles — every line you write should be doing a specific sales job, not just filling space:
- Function over detail: before writing each stage's script, decide what job it needs to do (plant a want, name a pain, offer proof, hand a reason to buy) — write to accomplish that job, don't pad with decorative scene-setting or generic adjectives that don't do anything.
- Never write filler: a line of hollow self-praise standing alone ("I'm obsessed with this", "this is my favorite ever", "so good") with no concrete claim, benefit, or result attached is filler — it does no sales work. If you want an enthusiastic beat, attach it to something real (a specific benefit, a visible result, a reason).
- The "Desired Outcome" stage is the aspiration — the state the customer wants but doesn't have yet — not a rehash of product Benefits. It often lands harder visually than verbally: for this stage specifically, use the "direction" field to suggest an actual on-camera demonstration or visible reaction (e.g. "show the product actually working — a close-up of the result" / "cut to a genuine, unscripted-looking reaction after trying it") rather than just describing more spoken lines. A shown payoff sells the outcome better than a told one.
- The "CTA" stage's script must contain an explicit call to buy (mentioning a link, "go grab it", "order now", a discount code) — not just a warm closing thought or a benefits recap with no actual purchase prompt.

Requirements:
- The "script" field should be conversational and ready to read aloud, roughly the same length as the corresponding stage in the original video.
- Selling points and pain points must come from our product's actual info — don't invent features the original video's product had but ours doesn't.
- The "direction" field should be one short, actionable filming tip — for the Desired Outcome stage in particular, favor a visual/demonstration direction over a purely verbal one (see writing principles above).
- Write everything in English.
- Target a natural total spoken duration across all 6 stages of roughly 40-50 seconds when read aloud (rarely more than 60) — pace each stage's script length accordingly; don't pad any stage just to fill time.
- The "Reaction" stage's script should be a single sharp reactive beat, roughly 2-3 seconds when read aloud — a short exclamation or visible reaction, not an explanation.
- The "Hook" stage should create a genuine curiosity gap or a bold/contrarian claim that makes someone stop scrolling — not a generic "check out this product" opener.
- If a creator profile is provided, let it shape voice/persona and how much filming guidance to spell out (e.g. more explicit, encouraging step-by-step direction for someone with little on-camera experience; terser, more autonomous direction for a veteran creator) — but never invent product facts or claims from the profile, those must still come only from the product info.`;

// A creator's short self-reported profile (see CreatorProfile in
// src/lib/types.ts, collected at /onboarding) — every field optional.
// Passed through here so the generated script's voice/persona and the
// specificity of its filming directions can be tailored to whoever's
// actually going to film it, without ever inventing product facts from it.
export interface ScriptGenCreatorProfile {
  ageRange?: string | null;
  occupation?: string | null;
  interests?: string | null;
  experienceLevel?: string | null;
  contentStyle?: string | null;
}

interface ScriptGenInput {
  videoTitle: string;
  analysis: AnalysisResult;
  product: ShopifyProductSummary;
  creatorProfile?: ScriptGenCreatorProfile | null;
  reactionEmotion?: ReactionEmotion | null;
}

export async function generateScriptForProduct(input: ScriptGenInput): Promise<GeneratedScriptStage[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const structureText = input.analysis.structure
    .map((s) => `- [${s.label}] ${s.summary}${s.quote ? ` (quote: "${s.quote}")` : ""}`)
    .join("\n");

  const profileLines: string[] = [];
  if (input.creatorProfile) {
    const p = input.creatorProfile;
    if (p.ageRange) profileLines.push(`- Age range: ${p.ageRange}`);
    if (p.occupation) profileLines.push(`- Occupation: ${p.occupation}`);
    if (p.interests) profileLines.push(`- Interests: ${p.interests}`);
    if (p.experienceLevel) profileLines.push(`- On-camera experience: ${p.experienceLevel}`);
    if (p.contentStyle) profileLines.push(`- Preferred content style: ${p.contentStyle}`);
  }
  const profileText =
    profileLines.length > 0
      ? `\n\n---\n\nCreator profile (use to shape voice/persona/filming-direction detail — don't invent product facts from it):\n${profileLines.join("\n")}`
      : "";

  const userContent = `Reference viral video: "${input.videoTitle}"

Hook: ${input.analysis.hook.hook_text}
Hook techniques: ${input.analysis.hook.techniques.join(", ")}

6-stage structure:
${structureText}

Selling-point techniques:
- Product claims: ${input.analysis.selling_points.product_claims.join(", ") || "none"}
- Emotional triggers: ${input.analysis.selling_points.emotional_triggers.join(", ") || "none"}
- Copywriting techniques: ${input.analysis.selling_points.copywriting_techniques.join(", ") || "none"}
- Key phrases: ${input.analysis.selling_points.key_phrases.join(", ") || "none"}
- CTA: ${input.analysis.selling_points.call_to_action}

---

Our product to adapt the script for:
Title: ${input.product.title}
Category: ${input.product.productType || "unknown"}
Tags: ${input.product.tags.join(", ") || "none"}
Description: ${input.product.description || "(no description)"}${profileText}${reactionEmotionInstruction(input.reactionEmotion)}`;

  const msg = await trackAiTask(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    })
  );

  const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  if (!textBlock) throw new Error("Claude returned no text content");

  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.stages as GeneratedScriptStage[];
  } catch (e) {
    throw new Error(`Failed to parse script JSON: ${jsonStr.slice(0, 500)}`);
  }
}

const SHOPPABLE_CHAIN_SYSTEM_PROMPT = `You are a senior TikTok e-commerce content strategist. A brand team has already broken an existing viral video down into an ordered sequence of shot cards (each with its current script/notes text, possibly hand-edited by the team) and wants to adapt that exact viral structure into a new shoppable script for a DIFFERENT product.

You'll receive:
1. The ordered reference shots (each with a label and its current script text) — treat this as the real reference material, not something to re-derive from scratch.
2. Our own product's info (title, description, price if known).
3. Optionally, a short profile of the creator who will film this script.

First, silently identify the reference sequence's core viral elements — its hook technique, pacing/rhythm, emotional beats, and what role each shot plays in the sequence. Then write a NEW 6-stage script (Reaction, Hook, Pain Point / Old Solution, Product Intro, Desired Outcome, CTA) for OUR product that deliberately preserves those same core elements (same hook technique, similar pacing, the same emotional arc) while swapping in our product's actual selling points and use cases. Don't copy the reference verbatim — adapt it. If the reference sequence has more or fewer than 6 shots, or doesn't cleanly map to these 6 stages, use your best judgment to still produce exactly these 6 stages, inferring what's missing from the overall reference tone/structure.

Output ONLY a single JSON object (no text outside the JSON, no markdown code fences):
{
  "stages": [
    { "label": "Reaction", "script": "...", "direction": "..." },
    { "label": "Hook", "script": "...", "direction": "..." },
    { "label": "Pain Point / Old Solution", "script": "...", "direction": "..." },
    { "label": "Product Intro", "script": "...", "direction": "..." },
    { "label": "Desired Outcome", "script": "...", "direction": "..." },
    { "label": "CTA", "script": "...", "direction": "..." }
  ]
}

Writing principles — every line should be doing a specific sales job, not just filling space:
- Function over detail: decide what job each stage's script needs to do (plant a want, name a pain, offer proof, hand a reason to buy) and write to accomplish that, not to decorate with scene-setting or generic adjectives.
- Never write filler: hollow self-praise standing alone ("I'm obsessed", "this is amazing") with no concrete claim/benefit/result attached does no sales work — skip it, or attach the enthusiasm to something real.
- "Desired Outcome" is the not-yet-achieved aspiration, not a Benefits rehash, and it usually lands better shown than told: use "direction" to suggest an actual on-camera demonstration or visible reaction for this stage specifically, rather than only more spoken lines.
- "CTA" must contain an explicit call to buy (a link, "go grab it", "order now", a code) — not just a warm closing thought with no real purchase prompt.

Requirements:
- The "script" field should be conversational and ready to read aloud.
- Selling points must come from our product's actual info — don't invent features the reference's product had but ours doesn't.
- The "direction" field should be one short, actionable filming tip — for Desired Outcome, favor a visual/demonstration direction (see writing principles above).
- Write everything in English.
- Target a natural total spoken duration across all 6 stages of roughly 40-50 seconds when read aloud (rarely more than 60).
- The "Reaction" stage's script should be a single sharp reactive beat, roughly 2-3 seconds when read aloud.
- The "Hook" stage should create a genuine curiosity gap or bold/contrarian claim, not a generic opener.
- If a creator profile is provided, let it shape voice/persona and filming-direction detail, but never invent product facts from it.`;

// One shot card from the already-broken-down chain the product card was
// wired to on the canvas — its label plus its CURRENT script text
// (node.instruction, possibly hand-edited), not a fresh re-analysis.
export interface ShoppableChainReferenceStage {
  label: string;
  script: string;
}

// The pasted-product-link card's info (see StoryboardNode.productRef) —
// deliberately NOT a ShopifyProductSummary, this product may not exist in
// Shopify at all.
export interface ShoppableChainProduct {
  title: string;
  description: string;
  price?: string | null;
}

// "Generate script" on a product card (see the generate-shoppable-script
// routes): a separate entry point from generateScriptForProduct above — the
// reference here is the user's current chain of script cards (lightweight
// {label, script} pairs), not a full AnalysisResult, and the product comes
// from a pasted TikTok product link rather than Shopify.
export async function generateShoppableScriptFromChain(input: {
  referenceStages: ShoppableChainReferenceStage[];
  product: ShoppableChainProduct;
  creatorProfile?: ScriptGenCreatorProfile | null;
  reactionEmotion?: ReactionEmotion | null;
}): Promise<GeneratedScriptStage[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const referenceText = input.referenceStages
    .map((s, i) => `${i + 1}. [${s.label}] ${s.script || "(no script text yet)"}`)
    .join("\n");

  const profileLines: string[] = [];
  if (input.creatorProfile) {
    const p = input.creatorProfile;
    if (p.ageRange) profileLines.push(`- Age range: ${p.ageRange}`);
    if (p.occupation) profileLines.push(`- Occupation: ${p.occupation}`);
    if (p.interests) profileLines.push(`- Interests: ${p.interests}`);
    if (p.experienceLevel) profileLines.push(`- On-camera experience: ${p.experienceLevel}`);
    if (p.contentStyle) profileLines.push(`- Preferred content style: ${p.contentStyle}`);
  }
  const profileText =
    profileLines.length > 0
      ? `\n\n---\n\nCreator profile (use to shape voice/persona/filming-direction detail — don't invent product facts from it):\n${profileLines.join("\n")}`
      : "";

  const userContent = `Reference shot sequence (already broken down from a viral video):
${referenceText}

---

Our product to adapt the script for:
Title: ${input.product.title}
Description: ${input.product.description || "(no description)"}
Price: ${input.product.price || "unknown"}${profileText}${reactionEmotionInstruction(input.reactionEmotion)}`;

  const msg = await trackAiTask(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system: SHOPPABLE_CHAIN_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    })
  );

  const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  if (!textBlock) throw new Error("Claude returned no text content");

  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.stages as GeneratedScriptStage[];
  } catch (e) {
    throw new Error(`Failed to parse shoppable script JSON: ${jsonStr.slice(0, 500)}`);
  }
}

const REFINE_SYSTEM_PROMPT = `You are a senior TikTok e-commerce content strategist. You previously wrote one beat of a script (part of a larger 6-stage script) for a brand's product. The brand team has reviewed it and left feedback on this one beat only. Rewrite just this beat to address their feedback — don't change what beat it is or its role in the overall script, just improve the actual line(s) and filming direction.

Output ONLY a single JSON object (no text outside the JSON, no markdown code fences), in this format:
{
  "script": "The revised line(s) for the creator to say — conversational, ready to read aloud as-is",
  "direction": "A short, revised filming/direction note for the creator"
}

Requirements:
- Directly address the feedback given — don't just lightly reword the original.
- Keep it grounded in the product's actual info; don't invent features.
- Keep roughly the same length/pacing as the original unless the feedback asks for a length change.
- Every line should do a specific sales job (plant a want, name a pain, offer proof, hand a reason to buy) — avoid hollow filler like unattached self-praise ("I love this so much") that doesn't actually claim or prove anything.
- Write in English.`;

interface RefineStageInput {
  videoTitle: string;
  stageLabel: string;
  currentScript: string;
  currentDirection: string;
  feedback: string;
  product: ShopifyProductSummary;
}

export async function refineScriptStage(
  input: RefineStageInput
): Promise<{ script: string; direction: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const userContent = `Reference viral video: "${input.videoTitle}"
Beat: ${input.stageLabel}

Current script line(s) for this beat: "${input.currentScript}"
Current filming direction: "${input.currentDirection}"

Our product:
Title: ${input.product.title}
Category: ${input.product.productType || "unknown"}
Tags: ${input.product.tags.join(", ") || "none"}
Description: ${input.product.description || "(no description)"}

Brand team's feedback on this beat: "${input.feedback}"

Rewrite this beat's script and direction to address the feedback.`;

  const msg = await trackAiTask(() =>
    client.messages.create(
      {
        model: MODEL,
        max_tokens: 1000,
        system: REFINE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      },
      { timeout: 60_000 }
    )
  );

  const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  if (!textBlock) throw new Error("Claude returned no text content");

  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    const parsed = JSON.parse(jsonStr);
    return { script: String(parsed.script || ""), direction: String(parsed.direction || "") };
  } catch (e) {
    throw new Error(`Failed to parse refine JSON: ${jsonStr.slice(0, 500)}`);
  }
}
