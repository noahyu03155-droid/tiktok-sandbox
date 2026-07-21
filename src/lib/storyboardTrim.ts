// Helpers for the storyboard render pipeline's "smart trim" step: each shot's
// uploaded clip is typically much longer (~20s) than what that beat actually
// needs on screen. Rather than always hard-cutting from 0:00, this picks a
// target duration from how long the shot's script text takes to read aloud,
// then (when OPENAI_API_KEY is available) asks a vision model to look at a
// handful of sampled frames and choose which part of the clip best matches
// that text, instead of blindly assuming the start of the clip is the right
// moment.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

// Average conversational/ad-read pace. ~155 wpm is a common voiceover
// benchmark — fast enough to not feel padded, slow enough to stay legible.
const WORDS_PER_SECOND = 155 / 60;
const MIN_DURATION_SEC = 1.5;
const MAX_DURATION_SEC = 15;

export function estimateSpeechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return MIN_DURATION_SEC;
  const seconds = words / WORDS_PER_SECOND;
  return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, seconds));
}

// Every spawned ffmpeg/ffprobe call below is wrapped with a hard kill
// timeout — a stuck child process (a corrupt/huge source file, a filesystem
// hiccup, whatever) used to just hang the whole render job forever with no
// way for the client to ever know, since there's nothing to time the
// request out at HTTP level anymore (it's a background job — see
// storyboardRender.ts's doc comment). SIGKILL after PROBE_TIMEOUT_MS is a
// blunt but reliable way to guarantee this step always eventually resolves
// one way or another.
const PROBE_TIMEOUT_MS = 15_000;

export function probeDurationSec(srcPath: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      srcPath,
    ]);
    const timer = setTimeout(() => p.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      clearTimeout(timer);
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}

export function extractFrame(srcPath: string, atSec: number, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", [
      "-y", "-ss", String(atSec), "-i", srcPath,
      "-frames:v", "1", "-vf", "scale=320:-1",
      "-q:v", "5",
      outPath,
    ]);
    const timer = setTimeout(() => p.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outPath));
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// Samples ~8 evenly spaced frames across the clip, shows them to a vision
// model alongside the shot's script text, and asks for the best start time
// for a `targetSec`-long window. Falls back to 0 (start of clip) on any
// failure — a missing key, a vision-model hiccup, or a too-short source clip
// should never block the render, just skip the "smart" part of smart trim.
export async function pickBestSegment(opts: {
  srcPath: string;
  text: string;
  targetSec: number;
  clipDurationSec: number;
  tmpDir: string;
  apiKey: string | undefined;
  // Optional timed transcript of the WHOLE source take (absolute seconds,
  // same clock as the frame timestamps) — lets the model "hear" the clip,
  // not just see it. Raw UGC takes routinely have an off-camera person
  // giving directions between/behind deliveries ("okay now hold it up",
  // "look at the camera", counting in) — those show up as transcript lines
  // that clearly aren't the creator delivering the shot's script, and the
  // model is told to treat their time ranges as off-limits when choosing
  // the window.
  timedTranscript?: { start: number; end: number; text: string }[] | null;
}): Promise<number> {
  const { srcPath, text, targetSec, clipDurationSec, tmpDir, apiKey, timedTranscript } = opts;
  const latestStart = Math.max(0, clipDurationSec - targetSec);
  if (!apiKey || latestStart <= 0.1 || !text.trim()) return 0;

  // Raised from 8 — the user reported the payoff moment (a pet owner's
  // laugh/reaction near the END of a take) kept getting missed in favor of
  // an earlier, calmer-but-on-topic moment. Denser sampling means less of
  // the clip goes unseen by the model between sample points, so a late,
  // brief reaction is less likely to fall in a gap.
  const SAMPLE_COUNT = 14;
  const sampleTimes = Array.from({ length: SAMPLE_COUNT }, (_, i) => (i / (SAMPLE_COUNT - 1)) * clipDurationSec);

  try {
    const frameDir = path.join(tmpDir, "frames");
    fs.mkdirSync(frameDir, { recursive: true });
    // Extracted in parallel rather than one-at-a-time — each is a cheap
    // single-frame ffmpeg grab (still protected by extractFrame's own kill
    // timeout), and doing all 8 concurrently instead of sequentially was a
    // real chunk of the "render takes too long" complaint across a board
    // with many video shots, since this runs once per video clip that
    // needs smart-trim.
    const extracted = await Promise.all(
      sampleTimes.map(async (t, i) => {
        const framePath = path.join(frameDir, `f${i}.jpg`);
        const ok = await extractFrame(srcPath, t, framePath);
        return ok ? { t, file: framePath } : null;
      })
    );
    const frames = extracted.filter((f): f is { t: number; file: string } => f !== null);
    if (frames.length < 2) return 0;

    const openai = new OpenAI({ apiKey });
    const content: any[] = [
      {
        type: "text",
        text:
          `These ${frames.length} frames are sampled evenly across a ${clipDurationSec.toFixed(1)}s video clip, ` +
          `at these timestamps (seconds): ${frames.map((f) => f.t.toFixed(1)).join(", ")}.\n\n` +
          `This clip needs to be trimmed down to a ${targetSec.toFixed(1)}s segment for one shot of a short-form ` +
          `UGC product video. What's happening / being said in this shot: "${text.trim()}"\n\n` +
          `Before picking anything: look at EVERY frame provided, in order, start to finish — build a mental ` +
          `timeline of how this take actually plays out (calm → building → peak, or whatever shape it has) ` +
          `rather than judging frames one at a time in isolation. Only after you've scanned all of them, decide ` +
          `where the best ${targetSec.toFixed(1)}s window is.\n\n` +
          `Pick the single best start time (in seconds, between 0 and ${latestStart.toFixed(1)}) for a ` +
          `${targetSec.toFixed(1)}s window that best matches that content — the moment the described ` +
          `action/reaction is actually happening on screen, not a dead or transitional moment. ` +
          `UGC lives or dies on genuine emotional payoff: if this shot is about a reaction, result, or outcome ` +
          `(the person or pet's response AFTER using/trying the product — excitement, delight, relief, surprise), ` +
          `favor whichever sampled moment shows that reaction most visibly — a real smile, laugh, or animated ` +
          `expression — over an earlier, calmer moment in the clip that's technically on-topic but emotionally flat. ` +
          `Real UGC reactions typically build gradually and peak toward the END of a take (someone sees/tastes/ ` +
          `tries the product, there's a beat, THEN the genuine reaction hits) — so if two candidate moments seem ` +
          `similarly on-topic, or you're unsure, default to the LATER one rather than the earlier one. Don't just ` +
          `pick the first frame where the right action starts; the payoff is very often several seconds after ` +
          `that, sometimes near the very end of the clip. ` +
          `A genuine reaction is emotion attached to something actually being shown or achieved (a visible result, ` +
          `the product working, a before/after) — that's the strongest signal to look for, not just an animated ` +
          `expression in isolation. If the shot's text above includes an explicit filming/camera direction (often ` +
          `marked with 🎬, e.g. "show a close-up reaction after trying it" or "demonstrate the product working") ` +
          `treat that as a literal, high-priority instruction for which visual moment to find — it's telling you ` +
          `exactly what should be on screen. ` +
          (timedTranscript && timedTranscript.length
            ? `\n\nHere is a timed transcript of EVERYTHING audible in the clip (same seconds clock as the frames):\n` +
              timedTranscript.map((s) => `[${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${s.text}`).join("\n") +
              `\n\nCRITICAL audio rule: this is a raw take, so some lines may be an OFF-CAMERA person giving ` +
              `filming directions ("okay now hold it up", "look at the camera", counting in, crew chatter) or the ` +
              `creator breaking character to ask/respond — anything that is clearly NOT the creator delivering the ` +
              `shot content described above. The final video keeps the clip's real audio, so a window that overlaps ` +
              `those moments ships with a stranger's voice in the background. Treat every such line's time range as ` +
              `OFF-LIMITS: pick a window that avoids them entirely, even if that means choosing a visually ` +
              `second-best moment. If every possible window overlaps direction-chatter, pick the one where it ` +
              `overlaps the least. ` +
              `\n\nRespond with ONLY a JSON object: {"start_sec": <number>}`
            : `Respond with ONLY a JSON object: {"start_sec": <number>}`),
      },
      ...frames.map((f) => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f.file).toString("base64")}` },
      })),
    ];

    // Explicit timeout + single retry — the SDK's own default (10 min,
    // 2 retries) is exactly what let one slow/hanging call stall an entire
    // shot for way longer than this "nice to have" step is worth. 25s is
    // generous for an 8-image vision call; if it's not back by then, bail
    // to the try/catch's start=0 fallback below instead of blocking the rest
    // of the render.
    const res = await openai.chat.completions.create(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content }],
        response_format: { type: "json_object" },
        max_tokens: 50,
      },
      { timeout: 25_000, maxRetries: 1 }
    );
    const raw = res.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const startSec = Number(parsed?.start_sec);
    if (!Number.isFinite(startSec)) return 0;
    return Math.min(latestStart, Math.max(0, startSec));
  } catch {
    // Vision call failed for any reason — smart trim is a nice-to-have, not
    // worth failing the whole render over.
    return 0;
  } finally {
    fs.rmSync(path.join(tmpDir, "frames"), { recursive: true, force: true });
  }
}
