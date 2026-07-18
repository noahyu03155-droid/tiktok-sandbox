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
}): Promise<number> {
  const { srcPath, text, targetSec, clipDurationSec, tmpDir, apiKey } = opts;
  const latestStart = Math.max(0, clipDurationSec - targetSec);
  if (!apiKey || latestStart <= 0.1 || !text.trim()) return 0;

  const SAMPLE_COUNT = 8;
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
          `product video. What's happening / being said in this shot: "${text.trim()}"\n\n` +
          `Look at the frames and pick the single best start time (in seconds, between 0 and ${latestStart.toFixed(1)}) ` +
          `for a ${targetSec.toFixed(1)}s window that best matches that content — e.g. the moment the described ` +
          `action/reaction is actually happening on screen, not a dead or transitional moment. ` +
          `Respond with ONLY a JSON object: {"start_sec": <number>}`,
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
