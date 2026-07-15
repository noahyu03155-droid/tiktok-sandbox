// Turns a free-text note like "make it punchier, faster cuts, less text on
// screen" into concrete adjustments to the render pipeline's actual knobs
// (caption density, per-shot duration scaling, transition style/length).
// This is NOT a generative re-edit — the underlying clips/order are
// unchanged — it only retunes the same pacing/caption/transition dials the
// reference-style analyzer (storyboardStyle.ts) also writes to, so a
// "Regenerate" after typing a note can act on it the same way a render
// already acts on an uploaded reference video's style profile.

import OpenAI from "openai";
import type { StoryboardCaptionStyle, StoryboardTransitionPreset } from "./types";

const TRANSITION_PRESETS: StoryboardTransitionPreset[] = [
  "hard_cut", "fade", "dissolve", "wipeleft", "wiperight",
  "slideleft", "slideright", "slideup", "slidedown", "circleopen", "circleclose",
];
const CAPTION_STYLES: StoryboardCaptionStyle[] = ["punchy", "descriptive", "minimal"];

export interface EditingFeedbackAdjustment {
  transition: StoryboardTransitionPreset;
  transitionSec: number;
  durationMultiplier: number;
  captionStyle: StoryboardCaptionStyle;
  notes: string;
}

export async function interpretEditingFeedback(opts: {
  feedbackText: string;
  current: {
    captionStyle: StoryboardCaptionStyle;
    durationMultiplier: number;
    transition: StoryboardTransitionPreset;
    transitionSec: number;
  };
  apiKey: string | undefined;
}): Promise<EditingFeedbackAdjustment | null> {
  const { feedbackText, current, apiKey } = opts;
  if (!apiKey || !feedbackText.trim()) return null;
  try {
    const openai = new OpenAI({ apiKey });
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            `A short-form product video is about to be re-rendered from the same shots, in the same order — no re-shoot, no re-ordering, no clip changes possible. The creator left this note about what to change about the EDIT:\n"${feedbackText.trim()}"\n\n` +
            `Current render settings: transition=${current.transition}, transitionSec=${current.transitionSec}, durationMultiplier=${current.durationMultiplier} (>1 = slower/longer shots, <1 = faster/shorter shots), captionStyle=${current.captionStyle}.\n\n` +
            `Only these four settings can actually change. Read the note and decide which of them should change to honor it, leaving anything the note doesn't address at its current value (don't change a setting just because you can — only change what the note implies). ` +
            `Output ONLY a single JSON object (no markdown fences): {"transition": one of ${JSON.stringify(TRANSITION_PRESETS)}, "transitionSec": number (0.05 to 0.6), "durationMultiplier": number (0.5 to 1.8), "captionStyle": one of ${JSON.stringify(CAPTION_STYLES)}, "notes": "one short plain-English sentence describing what you changed and why, to show the creator"}`,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 200,
    });
    const raw = res.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const transition: StoryboardTransitionPreset = TRANSITION_PRESETS.includes(parsed?.transition) ? parsed.transition : current.transition;
    const captionStyle: StoryboardCaptionStyle = CAPTION_STYLES.includes(parsed?.captionStyle) ? parsed.captionStyle : current.captionStyle;
    const transitionSec = Number.isFinite(parsed?.transitionSec) ? Math.min(0.6, Math.max(0.05, parsed.transitionSec)) : current.transitionSec;
    const durationMultiplier = Number.isFinite(parsed?.durationMultiplier) ? Math.min(1.8, Math.max(0.5, parsed.durationMultiplier)) : current.durationMultiplier;
    const notes = typeof parsed?.notes === "string" && parsed.notes.trim() ? parsed.notes.trim() : "Applied your note.";
    return { transition, transitionSec, durationMultiplier, captionStyle, notes };
  } catch {
    // Feedback interpretation is a nice-to-have, not worth failing the
    // whole render over — the render just proceeds with unchanged settings.
    return null;
  }
}
