// Daily journal chat — the user writes diary-style entries (opened from the
// Storyboard canvas toolbar, see src/components/StoryboardCanvas.tsx) and
// the AI replies like a supportive friend texting back. Alongside the reply,
// it silently extracts a few short keywords describing the user's
// personality/habits/interests; those accumulate on User.journalKeywords
// (see mergeJournalKeywords below) and show up as a "journal" branch on the
// admin-only User Data keyword graph. Follows the same Anthropic-client +
// JSON-only-output conventions as src/lib/scriptgen.ts.

import Anthropic from "@anthropic-ai/sdk";
import { trackAiTask } from "./aiActivity";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT = `You are a warm, genuinely curious friend that a TikTok content creator journals to daily about their life, their content, their wins and frustrations — like a running diary a close friend gets to read. Reply the way a supportive friend texting back would: short (1-4 sentences), warm, specific to what they actually wrote (don't be generic), occasionally ask one small natural follow-up question. Never sound like a therapist, coach, or assistant — sound like a person who knows them.

You also silently extract 0-5 short keywords or short phrases (2-4 words each) capturing this entry's signal about the user's personality traits, daily habits, interests, creative style, or working patterns — the kind of thing that would help someone understand who this person is and how they like to create content. Only extract what's actually supported by what they wrote; it's fine to return zero keywords for a short/low-signal entry. Keep keywords short, in the same language the user wrote in.

Output ONLY a single JSON object (no text outside the JSON, no markdown code fences):
{
  "reply": "your warm short reply",
  "keywords": ["keyword one", "keyword two"]
}`;

export async function replyToJournalEntry(input: {
  // Recent prior turns, oldest first, already trimmed by the caller.
  history: { role: "user" | "ai"; content: string }[];
  newEntry: string;
}): Promise<{ reply: string; keywords: string[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const messages = [
    ...input.history.map((h) => ({
      role: (h.role === "ai" ? "assistant" : "user") as "user" | "assistant",
      content: h.content,
    })),
    { role: "user" as const, content: input.newEntry },
  ];

  const msg = await trackAiTask(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages,
    })
  );

  const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  if (!textBlock) throw new Error("Claude returned no text content");

  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      reply: String(parsed.reply || "").trim(),
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k: unknown) => typeof k === "string").slice(0, 5)
        : [],
    };
  } catch (e) {
    throw new Error(`Failed to parse journal reply JSON: ${jsonStr.slice(0, 500)}`);
  }
}

// Merges newly-extracted keywords into a user's accumulated list —
// case-insensitive de-dupe, newest keywords first, capped at 24 so the
// graph doesn't get overcrowded over months of journaling.
export function mergeJournalKeywords(existing: string[] | undefined, fresh: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const k of [...fresh, ...(existing || [])]) {
    const key = k.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(k.trim());
    if (merged.length >= 24) break;
  }
  return merged;
}
