import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult, GeneratedScriptStage } from "./types";
import type { ShopifyProductSummary } from "./shopify";
import { trackAiTask } from "./aiActivity";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT = `You are a senior TikTok e-commerce content strategist. You help brand teams adapt a proven viral video's structure into a new script for one of their own products, to brief a creator/influencer for filming.

You'll receive:
1. A full breakdown of a viral video (golden hook, 6-stage structure: Reaction / Hook / Pain Point / Product Intro / Desired Outcome / CTA, and its copywriting/selling-point techniques)
2. Our own product's info (title, description, tags, category)

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

Requirements:
- The "script" field should be conversational and ready to read aloud, roughly the same length as the corresponding stage in the original video.
- Selling points and pain points must come from our product's actual info — don't invent features the original video's product had but ours doesn't.
- The "direction" field should be one short, actionable filming tip.
- Write everything in English.
- Target a natural total spoken duration across all 6 stages of roughly 40-50 seconds when read aloud (rarely more than 60) — pace each stage's script length accordingly; don't pad any stage just to fill time.
- The "Reaction" stage's script should be a single sharp reactive beat, roughly 2-3 seconds when read aloud — a short exclamation or visible reaction, not an explanation.
- The "Hook" stage should create a genuine curiosity gap or a bold/contrarian claim that makes someone stop scrolling — not a generic "check out this product" opener.`;

interface ScriptGenInput {
  videoTitle: string;
  analysis: AnalysisResult;
  product: ShopifyProductSummary;
}

export async function generateScriptForProduct(input: ScriptGenInput): Promise<GeneratedScriptStage[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const structureText = input.analysis.structure
    .map((s) => `- [${s.label}] ${s.summary}${s.quote ? ` (quote: "${s.quote}")` : ""}`)
    .join("\n");

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
Description: ${input.product.description || "(no description)"}`;

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
