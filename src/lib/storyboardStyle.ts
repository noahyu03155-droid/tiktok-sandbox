// "Learn from a reference video": extracts an editing-style profile from a
// video the user picked as an example (pacing, transition feel, caption
// style), so the storyboard render route can apply that *rhythm* to the
// user's own footage. Two layers, and either can work alone:
//   1. Empirical: ffmpeg scene-cut detection gives real shot-boundary
//      timestamps → real average shot length, no AI needed.
//   2. Qualitative: a vision model looks at one frame per detected shot and
//      names a transition preset / caption style / duration multiplier —
//      only used when OPENAI_API_KEY is set; falls back to a pacing-only
//      rule-based mapping otherwise.
// This does not call any video-generation model and does not copy content
// from the reference video into the output — it only reads cut rhythm.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { probeDurationSec, extractFrame } from "./storyboardTrim";
import type { StoryboardStyleProfile, StoryboardPacing, StoryboardTransitionPreset, StoryboardCaptionStyle } from "./types";

const SCENE_THRESHOLD = 0.3;
// Detections this close together are treated as one cut (ffmpeg's scene
// filter occasionally double-fires a single hard cut, seen in testing).
const DEDUPE_WINDOW_SEC = 0.2;
const MAX_SAMPLE_FRAMES = 10;

const TRANSITION_PRESETS: StoryboardTransitionPreset[] = [
  "hard_cut", "fade", "dissolve", "wipeleft", "wiperight",
  "slideleft", "slideright", "slideup", "slidedown", "circleopen", "circleclose",
];
const CAPTION_STYLES: StoryboardCaptionStyle[] = ["punchy", "descriptive", "minimal"];

function detectSceneCuts(srcPath: string): Promise<number[]> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", [
      "-i", srcPath,
      "-filter:v", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      "-f", "null", "-",
    ]);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", () => {
      const matches = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => parseFloat(m[1]));
      const sorted = matches.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      const deduped: number[] = [];
      for (const t of sorted) {
        if (deduped.length === 0 || t - deduped[deduped.length - 1] > DEDUPE_WINDOW_SEC) deduped.push(t);
      }
      resolve(deduped);
    });
    p.on("error", () => resolve([]));
  });
}

function computePacing(cuts: number[], totalDurationSec: number) {
  const boundaries = [0, ...cuts, totalDurationSec];
  const shotDurations: number[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const d = boundaries[i] - boundaries[i - 1];
    if (d > 0.05) shotDurations.push(d);
  }
  const shotCount = Math.max(1, shotDurations.length);
  const avgShotSec = shotDurations.reduce((a, b) => a + b, 0) / shotCount;
  const pacing: StoryboardPacing = avgShotSec < 1.2 ? "fast" : avgShotSec < 3 ? "medium" : "slow";
  return { shotCount, avgShotSec, pacing, boundaries };
}

// Rule-based fallback used when there's no OpenAI key, or the vision call
// fails — pacing alone is still a real, useful signal on its own.
function ruleBasedProfile(sourceLabel: string, shotCount: number, avgShotSec: number, pacing: StoryboardPacing): StoryboardStyleProfile {
  const byPacing = {
    fast: { transition: "wipeleft" as const, transitionSec: 0.15, durationMultiplier: 0.75, captionStyle: "punchy" as const },
    medium: { transition: "fade" as const, transitionSec: 0.35, durationMultiplier: 1, captionStyle: "descriptive" as const },
    slow: { transition: "fade" as const, transitionSec: 0.5, durationMultiplier: 1.25, captionStyle: "descriptive" as const },
  }[pacing];
  return {
    sourceLabel,
    shotCount,
    avgShotSec,
    pacing,
    ...byPacing,
    notes: `Estimated from cut timing only (avg shot ~${avgShotSec.toFixed(1)}s across ${shotCount} shots) — no vision analysis available.`,
  };
}

export async function analyzeReferenceStyle(opts: {
  srcPath: string;
  tmpDir: string;
  apiKey: string | undefined;
  sourceLabel: string;
}): Promise<StoryboardStyleProfile> {
  const { srcPath, tmpDir, apiKey, sourceLabel } = opts;
  const totalDurationSec = await probeDurationSec(srcPath);
  const cuts = await detectSceneCuts(srcPath);
  const { shotCount, avgShotSec, pacing, boundaries } = computePacing(cuts, totalDurationSec || 1);
  const fallback = ruleBasedProfile(sourceLabel, shotCount, avgShotSec, pacing);

  if (!apiKey) return fallback;

  try {
    // One frame at the midpoint of each shot, capped so a very fast-cut
    // reference doesn't blow up the number of vision tokens.
    const midpoints: number[] = [];
    for (let i = 1; i < boundaries.length; i++) midpoints.push((boundaries[i - 1] + boundaries[i]) / 2);
    const step = Math.max(1, Math.ceil(midpoints.length / MAX_SAMPLE_FRAMES));
    const sampled = midpoints.filter((_, i) => i % step === 0).slice(0, MAX_SAMPLE_FRAMES);

    const frameDir = path.join(tmpDir, "style_frames");
    fs.mkdirSync(frameDir, { recursive: true });
    const frameFiles: string[] = [];
    for (let i = 0; i < sampled.length; i++) {
      const framePath = path.join(frameDir, `s${i}.jpg`);
      const ok = await extractFrame(srcPath, sampled[i], framePath);
      if (ok) frameFiles.push(framePath);
    }
    if (frameFiles.length === 0) return fallback;

    const openai = new OpenAI({ apiKey });
    const content: any[] = [
      {
        type: "text",
        text:
          `These ${frameFiles.length} frames are sampled one per shot from a reference video that's ${totalDurationSec.toFixed(1)}s ` +
          `long with ${shotCount} detected shots (measured average shot length: ${avgShotSec.toFixed(1)}s — trust this number, ` +
          `it's from real cut-timing analysis, not a guess).\n\n` +
          `Look at how these shots likely cut together and describe the EDITING STYLE (not the subject matter) as a JSON object:\n` +
          `{"transition": one of ${JSON.stringify(TRANSITION_PRESETS)}, ` +
          `"transitionSec": number (0.05 to 0.6, how long the cut/transition should linger), ` +
          `"durationMultiplier": number (0.5 to 1.8, how much to scale a normal shot length to match this video's rhythm — ` +
          `under 1 for fast/punchy cutting, over 1 for slower/lingering cutting), ` +
          `"captionStyle": one of ${JSON.stringify(CAPTION_STYLES)}, ` +
          `"notes": a one-sentence plain-English description of the editing style for a human to sanity-check}\n\n` +
          `Use "hard_cut" for transition if the cuts look like straight hard cuts with no crossfade/wipe/slide effect visible between shots.`,
      },
      ...frameFiles.map((f) => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` },
      })),
    ];

    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
      max_tokens: 300,
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content || "{}");

    const transition = TRANSITION_PRESETS.includes(parsed?.transition) ? parsed.transition : fallback.transition;
    const captionStyle = CAPTION_STYLES.includes(parsed?.captionStyle) ? parsed.captionStyle : fallback.captionStyle;
    const transitionSec = Number.isFinite(parsed?.transitionSec)
      ? Math.min(0.6, Math.max(0.05, parsed.transitionSec))
      : fallback.transitionSec;
    const durationMultiplier = Number.isFinite(parsed?.durationMultiplier)
      ? Math.min(1.8, Math.max(0.5, parsed.durationMultiplier))
      : fallback.durationMultiplier;
    const notes = typeof parsed?.notes === "string" && parsed.notes.trim() ? parsed.notes.trim() : fallback.notes;

    return { sourceLabel, shotCount, avgShotSec, pacing, transition, transitionSec, durationMultiplier, captionStyle, notes };
  } catch {
    return fallback;
  } finally {
    fs.rmSync(path.join(tmpDir, "style_frames"), { recursive: true, force: true });
  }
}
