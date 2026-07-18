// Shared storyboard render engine — used by both the Video Analysis
// storyboard's render route and the standalone Creation project's render
// route (previously two copy-pasted implementations of the exact same
// pipeline; pulled into one place specifically so the async-job rework
// below only has to happen once).
//
// WHY THIS IS A BACKGROUND JOB, NOT A PLAIN AWAITED REQUEST:
// stitching several shots (each its own ffmpeg trim/encode, optionally a
// vision-model call to pick the best segment of a clip, then a final
// multi-input crossfade encode) routinely takes minutes for anything past a
// couple of shots. That used to all happen inside one HTTP request/response
// — which works fine locally, but in production Railway's edge proxy has
// its own timeout well under that, and kills the connection with a plain
// "upstream error" response once it's exceeded (see safeJson's handling of
// that in StoryboardCanvas.tsx, and the render getting stuck at "Almost
// done..." forever because the fetch never actually resolves or rejects in
// a way the UI can react to). Running the real work as a fire-and-forget
// background job — the HTTP request just starts it and returns
// immediately, and the client polls a separate lightweight status endpoint
// — means no single request is ever open longer than the poll interval, so
// there's nothing left for a proxy timeout to kill.
//
// Progress is also now real: each completed shot updates completedShots,
// so the client can show "Encoding shot 3 of 6" and compute a live ETA from
// the ACTUAL average time-per-shot observed so far, instead of a fixed
// guessed estimate.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getMediaDir } from "@/lib/db";
import { resolveStoryboardOrder } from "@/lib/storyboard";
import { estimateSpeechSeconds, probeDurationSec, pickBestSegment } from "@/lib/storyboardTrim";
import { wrapCaption, CAPTION_FONT_FILE, type CaptionStylePreset } from "@/lib/storyboardCaptions";
import { interpretEditingFeedback } from "@/lib/storyboardFeedback";
import type { StoryboardState, StoryboardTransitionPreset } from "@/lib/types";

const W = 720;
const H = 1280;
const TRANSITION_SEC = 0.4;
const FPS = 30;

// A stuck ffmpeg process (bad input file, weird codec, a hung filter graph)
// used to hang the entire render job forever — there's no HTTP request left
// to time it out (this all runs in the fire-and-forget background job), and
// job.step just sits on whatever it last was, which is exactly the "stuck at
// Encoding shot 1 of 19 for 20 minutes" symptom this timeout was added to
// fix. SIGKILL after timeoutMs guarantees every ffmpeg call resolves one way
// or another. Per-shot encodes get a shorter budget; the final multi-input
// crossfade assembly (proportional to shot count) gets a longer one — see
// call sites below.
const SINGLE_SHOT_TIMEOUT_MS = 120_000;

function runFfmpeg(args: string[], timeoutMs: number = SINGLE_SHOT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ff.kill("SIGKILL");
    }, timeoutMs);
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `The video encode for this shot got stuck and was stopped after ${Math.round(timeoutMs / 1000)}s with no progress — usually a corrupted or unusually large source clip. Try a different clip for this shot, or re-upload it.`
          )
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      if (code === null && signal) {
        reject(
          new Error(
            `The video render was killed mid-encode (signal ${signal}) — almost always the server running out of memory while encoding. Try again now that the plan has more RAM, or render fewer/shorter shots at once.`
          )
        );
        return;
      }
      reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-500)}`));
    });
  });
}

function probeHasAudio(srcPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      srcPath,
    ]);
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim().length > 0);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

const SILENT_AUDIO = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
const AAC_OUT = ["-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k"];

function mediaPathFromUrl(url: string): string | null {
  if (!url.startsWith("/api/media/")) return null;
  const rel = url.slice("/api/media/".length).split("/").filter(Boolean);
  const p = path.join(getMediaDir(), ...rel);
  if (!p.startsWith(getMediaDir())) return null; // path traversal guard
  return p;
}

function captionFilter(tmpDir: string, index: number, text: string, style: CaptionStylePreset): string | null {
  const wrapped = wrapCaption(text, style);
  if (!wrapped) return null;
  const capPath = path.join(tmpDir, `cap${index}.txt`);
  fs.writeFileSync(capPath, wrapped);
  return `drawtext=fontfile=${CAPTION_FONT_FILE}:textfile=${capPath}:reload=0:fontcolor=white:fontsize=32:line_spacing=8:box=1:boxcolor=black@0.5:boxborderw=14:x=(w-text_w)/2:y=h-th-90`;
}

function withCaption(baseFilter: string, caption: string | null): string {
  return caption ? `${baseFilter},${caption}` : baseFilter;
}

export interface RenderResult {
  url: string;
  skipped: string[];
  styleApplied: { pacing: string; transition: string; notes: string } | null;
  appliedFeedback: { notes: string } | null;
}

export interface RenderJob {
  status: "running" | "done" | "error";
  totalShots: number;
  completedShots: number;
  // Human-readable current step, for the "Encoding shot 3 of 6" /
  // "Assembling final video" style progress line.
  step: string;
  startedAt: string;
  finishedAt: string | null;
  // Real, observed seconds-per-completed-shot so far — the client uses this
  // (rather than a hardcoded guess) to show a live "~X min left" estimate
  // that gets more accurate as the render progresses.
  avgSecPerShot: number | null;
  result: RenderResult | null;
  error: string | null;
}

// In-memory only — a render is a short-lived, single-session thing; there's
// no need to survive a server restart mid-render (the user would just
// re-click Generate), same tradeoff as the category-scan/full-refresh jobs
// elsewhere in this codebase.
const jobs = new Map<string, RenderJob>();

export function getRenderJob(key: string): RenderJob | null {
  return jobs.get(key) || null;
}

// Best-effort cleanup of `_render_*` tmp directories left behind by a PAST
// render for this same outDir that never reached its finally block — e.g.
// the server process got killed/restarted mid-render (OOM, deploy) before
// the timeouts added elsewhere in this file existed, or before a hung
// ffmpeg/OpenAI call was ever going to resolve on its own. Each one can hold
// several full-resolution video segments plus extracted vision-model
// frames, so a handful of these left over from repeated stuck attempts is a
// real way to quietly fill up the disk (see the ENOSPC failures this was
// added to help prevent from recurring). Safe to run right before starting
// a new job for this outDir: if a job for this exact key were still
// genuinely running, startRenderJob already returned early above instead of
// reaching this point.
function cleanupOrphanedTmpDirs(outDir: string) {
  try {
    if (!fs.existsSync(outDir)) return;
    for (const entry of fs.readdirSync(outDir)) {
      if (/^_render_\d+$/.test(entry)) {
        fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Best-effort — never let a cleanup failure block starting the new render.
  }
}

// Fire-and-forget — starts the render in the background and returns
// immediately with the job's initial state. If a render for this exact key
// is already running, returns that existing job instead of starting a
// second overlapping one.
export function startRenderJob(
  key: string,
  board: StoryboardState,
  outDir: string,
  publicUrlPrefix: string
): { started: boolean; job: RenderJob } {
  const existing = jobs.get(key);
  if (existing && existing.status === "running") {
    return { started: false, job: existing };
  }

  const order = resolveStoryboardOrder(board.nodes, board.connections);
  const skipped: string[] = [];
  const usable = order.filter((n) => {
    if (!n.clip) {
      skipped.push(n.label || "untitled shot");
      return false;
    }
    return true;
  });

  const startedAt = new Date().toISOString();

  if (usable.length === 0) {
    const job: RenderJob = {
      status: "error",
      totalShots: 0,
      completedShots: 0,
      step: "",
      startedAt,
      finishedAt: startedAt,
      avgSecPerShot: null,
      result: null,
      error: "None of the shots have a clip attached yet — upload, pick from your library, or generate an AI reference image for at least one shot.",
    };
    jobs.set(key, job);
    return { started: true, job };
  }

  const job: RenderJob = {
    status: "running",
    totalShots: usable.length,
    completedShots: 0,
    step: "Starting...",
    startedAt,
    finishedAt: null,
    avgSecPerShot: null,
    result: null,
    error: null,
  };
  jobs.set(key, job);

  fs.mkdirSync(outDir, { recursive: true });
  cleanupOrphanedTmpDirs(outDir);
  const tmpDir = path.join(outDir, `_render_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const scalePad = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS}`;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const styleProfile = board.styleProfile || null;
  let captionStyle: CaptionStylePreset = styleProfile?.captionStyle || "descriptive";
  let durationMultiplier = styleProfile?.durationMultiplier ?? 1;
  let effectiveTransition: StoryboardTransitionPreset = styleProfile && styleProfile.transition !== "hard_cut" ? styleProfile.transition : "fade";
  let effectiveTransitionSec = styleProfile?.transition === "hard_cut" ? 0.05 : styleProfile?.transitionSec ?? TRANSITION_SEC;
  const feedbackText = (board.direction || "").trim();

  (async () => {
    const jobStartMs = Date.now();
    try {
      let appliedFeedback: { notes: string } | null = null;
      if (feedbackText) {
        job.step = "Reading your editing notes...";
        const adjustment = await interpretEditingFeedback({
          feedbackText,
          current: { captionStyle, durationMultiplier, transition: effectiveTransition, transitionSec: effectiveTransitionSec },
          apiKey: openaiApiKey,
        });
        if (adjustment) {
          captionStyle = adjustment.captionStyle;
          durationMultiplier = adjustment.durationMultiplier;
          effectiveTransition = adjustment.transition;
          effectiveTransitionSec = adjustment.transitionSec;
          appliedFeedback = { notes: adjustment.notes };
        }
      }

      const segmentPaths: string[] = [];
      const segDurations: number[] = [];

      for (let i = 0; i < usable.length; i++) {
        const node = usable[i];
        job.step = `Encoding shot ${i + 1} of ${usable.length}...`;
        const text = (node.instruction || node.label || "").trim();
        const caption = captionFilter(tmpDir, i, text, captionStyle);
        const clip = node.clip!;
        const srcPath = mediaPathFromUrl(clip.url);
        if (!srcPath || !fs.existsSync(srcPath)) {
          skipped.push(`${node.label || "untitled shot"} (file missing)`);
          job.completedShots++;
          continue;
        }
        const segPath = path.join(tmpDir, `seg${i}.mp4`);
        const videoOut = ["-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p"];
        let intendedSec = 0;

        if (clip.kind === "video") {
          const targetSec = Math.min(20, Math.max(1, estimateSpeechSeconds(text) * durationMultiplier));
          intendedSec = targetSec;
          const clipDurationSec = await probeDurationSec(srcPath);
          const startSec =
            clipDurationSec > targetSec
              ? await pickBestSegment({
                  srcPath,
                  text: feedbackText ? `${text}\n\n(Overall note from the creator about this edit: ${feedbackText})` : text,
                  targetSec,
                  clipDurationSec,
                  tmpDir,
                  apiKey: openaiApiKey,
                })
              : 0;
          const hasAudio = await probeHasAudio(srcPath);
          if (hasAudio) {
            await runFfmpeg([
              "-y", "-i", srcPath,
              "-vf", withCaption(scalePad, caption),
              ...videoOut,
              ...AAC_OUT,
              "-ss", String(startSec), "-t", String(targetSec),
              segPath,
            ]);
          } else {
            await runFfmpeg([
              "-y", "-i", srcPath, ...SILENT_AUDIO,
              "-vf", withCaption(scalePad, caption),
              "-map", "0:v:0", "-map", "1:a:0",
              ...videoOut,
              ...AAC_OUT,
              "-ss", String(startSec), "-t", String(targetSec), "-shortest",
              segPath,
            ]);
          }
        } else {
          const targetSec = Math.min(20, Math.max(1, estimateSpeechSeconds(text) * durationMultiplier));
          intendedSec = targetSec;
          const marginW = Math.round(W * 1.2);
          const marginH = Math.round(H * 1.2);
          const frames = Math.max(1, Math.round(FPS * targetSec));
          const kenBurns =
            `scale=${marginW}:${marginH}:force_original_aspect_ratio=increase,crop=${marginW}:${marginH},` +
            `zoompan=z='min(zoom+0.0008,1.15)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`;
          await runFfmpeg([
            "-y", "-loop", "1", "-i", srcPath, ...SILENT_AUDIO,
            "-vf", withCaption(kenBurns, caption),
            "-map", "0:v:0", "-map", "1:a:0",
            ...videoOut,
            ...AAC_OUT,
            "-t", String(targetSec), "-shortest",
            segPath,
          ]);
        }
        segmentPaths.push(segPath);
        const realDur = await probeDurationSec(segPath);
        segDurations.push(realDur > 0 ? realDur : intendedSec);
        job.completedShots++;
        job.avgSecPerShot = (Date.now() - jobStartMs) / 1000 / job.completedShots;
      }

      if (segmentPaths.length === 0) {
        throw new Error("None of the attached clips could be read from disk.");
      }

      const finalPath = path.join(outDir, "render.mp4");

      if (segmentPaths.length === 1) {
        fs.copyFileSync(segmentPaths[0], finalPath);
      } else {
        job.step = "Assembling final video (transitions + audio crossfade)...";
        const filterParts: string[] = [];
        let vLabel = "0:v";
        let aLabel = "0:a";
        let running = segDurations[0];
        for (let i = 1; i < segmentPaths.length; i++) {
          const t = Math.max(0.05, Math.min(effectiveTransitionSec, running / 2, segDurations[i] / 2));
          const offset = Math.max(0, running - t);
          const vOut = `v${i}`;
          const aOut = `a${i}`;
          filterParts.push(`[${vLabel}][${i}:v]xfade=transition=${effectiveTransition}:duration=${t.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`);
          filterParts.push(`[${aLabel}][${i}:a]acrossfade=d=${t.toFixed(3)}[${aOut}]`);
          vLabel = vOut;
          aLabel = aOut;
          running = running + segDurations[i] - t;
        }
        const inputArgs = segmentPaths.flatMap((p) => ["-i", p]);
        // Scales with shot count — a 19-shot crossfade assembly legitimately
        // needs more time than the per-shot default budget.
        const assemblyTimeoutMs = Math.max(SINGLE_SHOT_TIMEOUT_MS, segmentPaths.length * 20_000);
        await runFfmpeg(
          [
            "-y",
            ...inputArgs,
            "-filter_complex", filterParts.join(";"),
            "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
            "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p",
            ...AAC_OUT,
            finalPath,
          ],
          assemblyTimeoutMs
        );
      }

      job.result = {
        url: `${publicUrlPrefix}/render.mp4`,
        skipped,
        styleApplied: styleProfile ? { pacing: styleProfile.pacing, transition: styleProfile.transition, notes: styleProfile.notes } : null,
        appliedFeedback,
      };
      job.status = "done";
      job.step = "Done";
      job.finishedAt = new Date().toISOString();
    } catch (e: any) {
      job.status = "error";
      job.error = e?.message || "Render failed";
      job.finishedAt = new Date().toISOString();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();

  return { started: true, job };
}
