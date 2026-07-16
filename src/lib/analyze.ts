import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult, TranscriptSegment, VideoStats } from "./types";
import { trackAiTask } from "./aiActivity";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

function formatTranscript(segments: TranscriptSegment[]): string {
  if (!segments.length) return "(no transcript available)";
  return segments
    .map((s) => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.text}`)
    .join("\n");
}

interface AnalyzeInput {
  title: string;
  description: string;
  author: string;
  hashtags: string[];
  stats: VideoStats;
  duration_sec: number | null;
  transcript_segments: TranscriptSegment[];
}

const SYSTEM_PROMPT = `You are a senior TikTok short-video content strategist and copywriting analyst. You specialize in breaking down viral videos' script structure for e-commerce/brand teams, so they can reuse the same techniques in their own content.
You'll receive a TikTok video's metadata (title, description, author, performance stats, hashtags) and a full timestamped transcript.
Analyze it carefully, then output ONLY a single JSON object (no text outside the JSON, no markdown code fences), with these fields:

{
  "summary": "One to two sentences on what this video is about and why it likely works",
  "hook": {
    "hook_text": "The actual opening line(s), roughly the golden first 3 seconds",
    "duration_sec": 3,
    "techniques": ["Short phrases naming the hook techniques used, e.g. contrarian claim / suspense / calling out the pain point directly / showing a surprising result up front"],
    "why_it_works": "Explain why this opening holds attention — what psychological trigger it hits"
  },
  "structure": [
    {
      "key": "reaction",
      "label": "Reaction",
      "start_time": 0,
      "end_time": 1.5,
      "summary": "Is there a reaction-style/emotional beat at the very start to grab attention (e.g. a surprised expression, an exclamatory reaction line)? If the video has no distinct reaction beat, merge it with the hook stage — set start_time=end_time=0 and note in summary that 'no standalone reaction beat was used'",
      "quote": "The matching transcript line, or empty string if none"
    },
    {
      "key": "hook",
      "label": "Hook",
      "start_time": 0,
      "end_time": 3,
      "summary": "What the golden-opening hook says and how it grabs attention",
      "quote": "The matching transcript line"
    },
    {
      "key": "pain_point",
      "label": "Pain Point / Old Solution",
      "start_time": 3,
      "end_time": 10,
      "summary": "How the video surfaces the viewer's pain point/frustration, and why the old approach/competitor it mentions falls short",
      "quote": "The matching transcript line"
    },
    {
      "key": "product_intro",
      "label": "Product Intro",
      "start_time": 10,
      "end_time": 18,
      "summary": "How the product is introduced, and which features/usage are shown",
      "quote": "The matching transcript line"
    },
    {
      "key": "desired_outcome",
      "label": "Desired Outcome",
      "start_time": 18,
      "end_time": 25,
      "summary": "The ideal result/transformation after using the product, and how the video paints that picture",
      "quote": "The matching transcript line"
    },
    {
      "key": "cta",
      "label": "CTA",
      "start_time": 25,
      "end_time": 30,
      "summary": "How the closing call-to-action is phrased, and what urgency/persuasion technique it uses",
      "quote": "The matching transcript line"
    }
  ],
  "selling_points": {
    "product_claims": ["Product selling points / feature claims mentioned in the video"],
    "emotional_triggers": ["Emotional triggers used, e.g. anxiety, social proof/FOMO, scarcity, identity/status"],
    "copywriting_techniques": ["Specific copywriting techniques, e.g. numeric specificity, before/after contrast, rhetorical questions, conversational repetition, authority/expert endorsement"],
    "key_phrases": ["High-converting quotable lines, verbatim, that could be reused directly"],
    "call_to_action": "The closing call-to-action, verbatim or summarized"
  }
}

Requirements:
- The "structure" array must contain exactly these 6 stages in this order (keys: reaction, hook, pain_point, product_intro, desired_outcome, cta). Don't add, remove, or reorder them — even if a stage isn't clearly present in the video, give your best-effort judgment and note in the summary that "this stage isn't distinct / overlaps with another stage."
- The 6 stages' timestamps should follow the video's actual chronological order start to finish, ideally with each stage's end_time roughly matching the next stage's start_time.
- Be specific and actionable, never generic — back up claims with a direct transcript quote in the "quote" field wherever possible. If a stage has no clean matching line, leave quote as an empty string.
- Write all analysis text (summary, hook.why_it_works, structure summaries, selling_points) in English, regardless of what language the transcript itself is in. Quotes should stay in the transcript's original language/wording, unchanged.
- If the transcript is missing or very short, do your best based on the title/description, and note the limited information in the summary.
- "Reaction" stage specifically: this should be the single moment of peak emotional/reactive expression in the video (a genuine surprised look, an exclamation, a visible reaction) — real reaction beats are almost always 3 seconds or less. Don't stretch a neutral moment to fill more time than that; if nothing in the video is genuinely reactive, the existing "merge with hook" fallback above still applies.
- "Hook" stage specifically: pick out whichever specific line or moment is most likely to make a scrolling viewer stop and keep watching — a curiosity gap, a bold/contrarian claim, an unexpected visual — not simply "whatever comes first chronologically."
- General pacing awareness: well-performing short-form e-commerce videos are usually about 40-50 seconds total, rarely more than 60 — keep that norm in mind as a sanity check when judging how much of the video's actual runtime each stage should occupy (this doesn't change the video's real length, which you can't alter — it's a prior for how to interpret pacing/tightness when writing each stage's summary).`;

export async function analyzeVideo(input: AnalyzeInput): Promise<AnalysisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const userContent = `Video metadata:
Title: ${input.title}
Description: ${input.description}
Author: ${input.author}
Hashtags: ${input.hashtags.join(", ") || "(none)"}
Duration: ${input.duration_sec ?? "unknown"} sec
Plays: ${input.stats.play_count ?? "unknown"} | Likes: ${input.stats.digg_count ?? "unknown"} | Comments: ${input.stats.comment_count ?? "unknown"} | Shares: ${input.stats.share_count ?? "unknown"}

Full timestamped transcript:
${formatTranscript(input.transcript_segments)}`;

  const msg = await trackAiTask(() =>
    client.messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      },
      // Without an explicit timeout, a hung/stalled network request can leave
      // a video stuck in status:"analyzing" indefinitely — nothing else ever
      // updates the record, and the "Run breakdown" button won't re-trigger
      // because that route only accepts status "done"/"error". Fail fast so
      // the record actually reaches "error" and becomes retryable.
      { timeout: 120_000 }
    )
  );

  const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  if (!textBlock) throw new Error("Claude returned no text content");

  let jsonStr = textBlock.text.trim();
  // Strip accidental markdown code fences if the model adds them anyway.
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    return JSON.parse(jsonStr) as AnalysisResult;
  } catch (e) {
    throw new Error(`Failed to parse Claude analysis JSON: ${jsonStr.slice(0, 500)}`);
  }
}
