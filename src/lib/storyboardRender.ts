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
import OpenAI from "openai";
import { getMediaDir } from "@/lib/db";
import { resolveStoryboardOrder } from "@/lib/storyboard";
import { estimateSpeechSeconds, probeDurationSec, pickBestSegment } from "@/lib/storyboardTrim";
import { wrapCaption, CAPTION_FONT_FILE, type CaptionStylePreset } from "@/lib/storyboardCaptions";
import { interpretEditingFeedback } from "@/lib/storyboardFeedback";
import type { StoryboardState, StoryboardTransitionPreset, TranscriptSegment, StoryboardNode, CanvasConnection } from "@/lib/types";

// "off" — no captions at all, burn nothing in (the default; captions are
// opt-in, see the modal StoryboardCanvas.tsx shows before every render).
// "auto" — real speech-to-text captions, transcribed per-shot from that
// shot's own selected audio window via Whisper (see transcribeShotAudio
// below). Deliberately NOT "use the script text as a caption" anymore —
// that used to be the only behavior, and produced captions that didn't
// match what's actually said on screen once a shot's script text and its
// filmed clip drifted out of sync (e.g. the creator improvised while
// filming, or a shot got re-wired to a different clip later).
export type CaptionsMode = "off" | "auto";

// 1440x2560 — "2K" for a 9:16 vertical short-form video (portrait
// equivalent of 2560x1440). Was 720x1280; bumped per explicit request for
// higher output quality. Every filter below (scalePad, Ken Burns crop/zoom,
// caption position) derives its numbers from W/H, so this is the only place
// that needs to change.
const W = 1440;
const H = 2560;
// Default crossfade length between shots. Was 0.4s — reported as feeling
// "too aggressive" (a longer blend window means two differently-framed
// shots visibly ghost/swim through each other mid-transition, which reads
// as jarring rather than smooth, especially between close-ups shot from
// different angles). Shortening the blend window doesn't remove the
// crossfade, just tightens how long the ghosting is visible for — a
// snappier, less "swimmy" cut. Still overridden by a reference video's
// styleProfile.transitionSec when one's been imported.
const TRANSITION_SEC = 0.25;
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

// Pulls just the audio for the exact [startSec, startSec+durationSec)
// window a shot ended up using (the same window smart-trim picked / the
// same window that ends up in the final segment) — transcribing that exact
// slice, rather than the whole source clip, keeps the caption scoped to
// only what's actually said in THIS shot. Goes through runFfmpeg so it
// shares its kill-timeout instead of being able to hang indefinitely.
function extractAudioWindow(srcPath: string, startSec: number, durationSec: number, outPath: string): Promise<void> {
  return runFfmpeg([
    "-y", "-ss", String(startSec), "-t", String(durationSec), "-i", srcPath,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
    outPath,
  ]);
}

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

// WORD-level Whisper transcription (timestamp_granularities: ["word"]) —
// deliberately not the shared transcribeAudio() from @/lib/transcribe,
// which only requests segment-level timestamps. Whisper's "segment"
// granularity groups by pause detection, not sentence length — a person
// talking continuously through a whole 15-20s shot with no real pause can
// come back as ONE giant segment, which just moved the original "one huge
// static caption block" problem from render-time (script text) to
// transcribe-time (a still-too-long transcribed block, still needing
// wrapCaption's 3-line truncate-with-"…"). Word-level timestamps let
// groupWordsIntoCaptions below re-chunk the transcript into genuinely short,
// speech-paced captions instead.
async function transcribeShotWords(audioPath: string): Promise<WhisperWord[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const client = new OpenAI({ apiKey });
  const resp = (await client.audio.transcriptions.create(
    {
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
    } as any,
    { timeout: 25_000, maxRetries: 1 }
  )) as any;
  const words: WhisperWord[] = (resp?.words || [])
    .map((w: any) => ({ word: String(w.word || "").trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w: WhisperWord) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
  return words.length ? words : null;
}

// Groups words into short, punctuation-aware caption chunks instead of one
// long block — a new chunk starts whenever the current one hits
// MAX_WORDS_PER_CAPTION words, OR the word just added ends a clause (,) or
// sentence (. ! ?). This is what makes captions "follow the person's actual
// speaking pace, one phrase at a time" instead of dumping everything said
// in the shot onto screen at once.
const MAX_WORDS_PER_CAPTION = 6;

function groupWordsIntoCaptions(words: WhisperWord[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let bucket: WhisperWord[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    out.push({
      start: bucket[0].start,
      end: bucket[bucket.length - 1].end,
      text: bucket.map((w) => w.word).join(" "),
    });
    bucket = [];
  };
  for (const w of words) {
    bucket.push(w);
    if (/[.!?,]$/.test(w.word) || bucket.length >= MAX_WORDS_PER_CAPTION) {
      flush();
    }
  }
  flush();
  return out;
}

// Real speech-to-text captioning for "auto" mode — transcribes exactly what
// the person says in this shot's selected window via Whisper, instead of
// just re-displaying the pre-written script text, then re-chunks it into
// short speech-paced phrases (see groupWordsIntoCaptions) so the caller can
// burn in each phrase only while it's actually being said — see
// timedCaptionFilter below. Timestamps come back relative to the extracted
// audio window, which starts at the same t=0 as the shot's own encoded
// segment (both are cut from srcPath at the same startSec), so they line up
// with the final segment's timeline with no extra offset math needed.
// Best effort like pickBestSegment: a transcription hiccup (no API key, a
// network blip, a genuinely silent/unintelligible clip) just means this one
// shot ends up with no caption — never worth failing the whole render over.
async function transcribeShotAudio(
  srcPath: string,
  startSec: number,
  durationSec: number,
  tmpDir: string,
  index: number
): Promise<TranscriptSegment[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const audioPath = path.join(tmpDir, `whisper_${index}.mp3`);
    await extractAudioWindow(srcPath, startSec, durationSec, audioPath);
    const words = await Promise.race([
      transcribeShotWords(audioPath),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Whisper transcription timed out")), 30_000)),
    ]);
    if (!words) return null;
    const grouped = groupWordsIntoCaptions(words);
    return grouped.length ? grouped : null;
  } catch {
    return null;
  }
}

function mediaPathFromUrl(url: string): string | null {
  if (!url.startsWith("/api/media/")) return null;
  const rel = url.slice("/api/media/".length).split("/").filter(Boolean);
  const p = path.join(getMediaDir(), ...rel);
  if (!p.startsWith(getMediaDir())) return null; // path traversal guard
  return p;
}

// Caption sizing was originally tuned by eye against the old 720x1280
// canvas — kept proportional to H here so bumping W/H (e.g. up to 2K) keeps
// captions reading at the same relative on-screen size instead of shrinking
// to a sliver of the frame.
const CAPTION_SCALE = H / 1280;

// "auto" mode's caption builder — one drawtext filter per Whisper segment,
// each gated to only display during its own [start,end) window via
// ffmpeg's enable=between(t,...). Replaced an earlier single-static-block
// captionFilter() (now removed) that burned in the WHOLE shot's transcript
// as one fixed block for the shot's entire duration — which had two
// problems: overly long transcripts got word-wrapped to 3 lines and
// hard-truncated with "…" (Whisper transcribes the WHOLE shot's speech,
// easily more than a 3-line caption can hold), and there was no sense of
// the caption tracking what's being said moment-to-moment. This makes it
// read like real subtitles, one phrase appearing exactly when it's spoken
// and gone when it isn't.
function timedCaptionFilter(tmpDir: string, shotIndex: number, segments: TranscriptSegment[], style: CaptionStylePreset): string | null {
  const fontsize = Math.round(32 * CAPTION_SCALE);
  const lineSpacing = Math.round(8 * CAPTION_SCALE);
  const boxBorder = Math.round(14 * CAPTION_SCALE);
  const bottomMargin = Math.round(90 * CAPTION_SCALE);
  const parts: string[] = [];
  segments.forEach((seg, i) => {
    const wrapped = wrapCaption(seg.text, style);
    if (!wrapped) return;
    const capPath = path.join(tmpDir, `cap${shotIndex}_${i}.txt`);
    fs.writeFileSync(capPath, wrapped);
    const start = Math.max(0, seg.start).toFixed(2);
    const end = Math.max(seg.start + 0.1, seg.end).toFixed(2);
    // Commas inside the between(...) call must be backslash-escaped —
    // ffmpeg's filtergraph parser otherwise reads them as filter-chain
    // separators, same reason the outer filters are joined with plain ','.
    parts.push(
      `drawtext=fontfile=${CAPTION_FONT_FILE}:textfile=${capPath}:reload=0:fontcolor=white:fontsize=${fontsize}:line_spacing=${lineSpacing}:box=1:boxcolor=black@0.5:boxborderw=${boxBorder}:x=(w-text_w)/2:y=h-th-${bottomMargin}:enable='between(t\\,${start}\\,${end})'`
    );
  });
  return parts.length ? parts.join(",") : null;
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

// Finds the connected component in the board's connection graph (undirected
// — a card is "in" a component if it's reachable via ANY connection,
// forwards or backwards) that actually has the most RENDERABLE shots in it,
// and returns its node ids — or null if there's no real multi-node chain
// anywhere (zero connections, or every node is its own disconnected
// singleton). Used to scope a render to just the ONE chain the creator is
// actually working on: a board can accumulate a second, unrelated wired-up
// chain left over from testing a completely different idea — that's a real
// connected component too, so a simple "exclude nodes with zero
// connections" check doesn't catch it.
//
// Scored by CLIP COUNT, not raw node count — an earlier version picked
// whichever component simply had the most cards, which backfired the first
// time it ran: a leftover chain of mostly-empty placeholder cards (more
// cards, but few/no clips actually attached) outranked the creator's real,
// fully-shot 5-clip chain, and the real chain got entirely excluded,
// producing a false "none of the shots have a clip attached" error despite
// every real shot being ready. Counting actual renderable clips instead
// means the chain the creator has actually finished shooting always wins,
// regardless of which one happens to have more cards.
function primaryChainNodeIds(nodes: StoryboardNode[], connections: Pick<CanvasConnection, "fromId" | "toId">[]): Set<string> | null {
  if (connections.length === 0) return null; // nothing wired up at all — don't filter anything
  const adjacency = new Map<string, Set<string>>();
  for (const n of nodes) adjacency.set(n.id, new Set());
  for (const c of connections) {
    adjacency.get(c.fromId)?.add(c.toId);
    adjacency.get(c.toId)?.add(c.fromId);
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const isRenderableClip = (n: StoryboardNode) => !!n.clip && n.clip.source !== "tiktok";

  const seen = new Set<string>();
  let best: Set<string> = new Set();
  let bestScore = -1;
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const component = new Set<string>();
    const stack = [n.id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (component.has(cur)) continue;
      component.add(cur);
      seen.add(cur);
      for (const next of adjacency.get(cur) || []) {
        if (!component.has(next)) stack.push(next);
      }
    }
    if (component.size < 2) continue; // a lone singleton isn't a real chain — never a candidate
    let score = 0;
    for (const id of component) {
      const node = byId.get(id);
      if (node && isRenderableClip(node)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = component;
    }
  }
  // No multi-node component had any renderable clip at all — nothing to
  // meaningfully scope to, so don't filter (falls through to the normal
  // "none of the shots have a clip attached" error below if truly nothing
  // is ready, same message as before).
  return bestScore >= 1 ? best : null;
}

// Fire-and-forget — starts the render in the background and returns
// immediately with the job's initial state. If a render for this exact key
// is already running, returns that existing job instead of starting a
// second overlapping one.
export function startRenderJob(
  key: string,
  board: StoryboardState,
  outDir: string,
  publicUrlPrefix: string,
  captionsMode: CaptionsMode = "off"
): { started: boolean; job: RenderJob } {
  const existing = jobs.get(key);
  if (existing && existing.status === "running") {
    return { started: false, job: existing };
  }

  const order = resolveStoryboardOrder(board.nodes, board.connections);
  // resolveStoryboardOrder deliberately appends every disconnected chain it
  // finds (including true zero-connection orphans) in x-order — the right
  // call for rendering an UNWIRED single-shot board, but wrong once the
  // board also has a real wired chain: a leftover, fully-wired-up-to-itself
  // chain from testing a completely different idea (different product,
  // different shots) is just as "connected" as the real chain, so a simple
  // "has at least one connection" check isn't enough to exclude it — see
  // primaryChainNodeIds' own doc comment for how it picks the right one.
  const primaryChainIds = primaryChainNodeIds(board.nodes, board.connections);
  const skipped: string[] = [];
  const usable = order.filter((n) => {
    if (!n.clip) {
      skipped.push(n.label || "untitled shot");
      return false;
    }
    // clip.source === "tiktok" means this node's clip came from pasting a
    // TikTok VIDEO link — either the "Import original video" reference
    // widget on a connected chain's head node, or a trend video pasted
    // straight onto the canvas. Both exist purely to feed the Breakdown /
    // Breakdown-chain analysis (transcription + vision reference) and are
    // deliberately KEPT on the board afterwards as context (see Breakdown's
    // route doc comments) — they were never meant to themselves become a
    // rendered shot in the final output. Without this check, a reference
    // video left connected at the head of a chain would render as an
    // unwanted extra clip prepended before the real 6-stage shots.
    if (n.clip.source === "tiktok") {
      skipped.push(`${n.label || "reference video"} (reference clip — not one of your filmed shots, excluded from the render)`);
      return false;
    }
    if (primaryChainIds && !primaryChainIds.has(n.id)) {
      skipped.push(`${n.label || "untitled card"} (belongs to a different, disconnected chain on this board — excluded from the render)`);
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
        // Computed per-branch below, only in "auto" mode, only once the
        // shot's actual audio window is known — see transcribeShotAudio's
        // doc comment for why this is no longer just the script text.
        let caption: string | null = null;
        const clip = node.clip!;
        const srcPath = mediaPathFromUrl(clip.url);
        if (!srcPath || !fs.existsSync(srcPath)) {
          skipped.push(`${node.label || "untitled shot"} (file missing)`);
          job.completedShots++;
          continue;
        }
        const segPath = path.join(tmpDir, `seg${i}.mp4`);
        // Explicit -crf (lower = higher quality/bigger file; 18-20 is
        // "visually near-lossless" territory for x264) — without it,
        // libx264 falls back to its own default (23, noticeably softer),
        // and this segment may still get re-encoded 1-2 more times during
        // the crossfade-merge pass below, so starting from a high-quality
        // source matters more here than for a single-generation encode.
        const videoOut = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p"];
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
          if (captionsMode === "auto" && hasAudio) {
            const segments = await transcribeShotAudio(srcPath, startSec, targetSec, tmpDir, i);
            if (segments) caption = timedCaptionFilter(tmpDir, i, segments, captionStyle);
          }
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
        // Used to build ONE filter_complex chaining every segment's
        // xfade+acrossfade together, with all N segment files open as
        // ffmpeg inputs simultaneously. That works for a few shots, but in
        // production a longer board (19 shots -> 18 chained xfade/
        // acrossfade pairs, 19 simultaneously-open decoders) reliably blew
        // up with "Resource temporarily unavailable" / "Failed to inject
        // frame into filter network" — ffmpeg running out of some resource
        // (file descriptors / buffered frames) partway through such a deep
        // graph.
        //
        // The first fix for that (merge 2 clips at a time, left to right,
        // into a growing chain of intermediate files) traded that crash for
        // a different, worse problem: linear "fold-left" means the FIRST
        // segment gets re-encoded once per remaining segment — for 19
        // shots, shot 1's content goes through 18 successive lossy
        // re-encode generations before reaching the final file, which is
        // exactly the visible blur/muffled-audio quality loss reported
        // after that fix shipped.
        //
        // A balanced binary-tree merge keeps the "only 2 inputs open per
        // ffmpeg call" property (still avoids the resource-exhaustion
        // crash) while capping every piece of original content at
        // ceil(log2(N)) re-encode generations instead of up to N-1 — for 19
        // shots that's 5 generations worst-case instead of 18, a huge
        // reduction in cumulative generation loss for both video and audio.
        type Segment = { path: string; dur: number };
        let level: Segment[] = segmentPaths.map((p, i) => ({ path: p, dur: segDurations[i] }));
        let mergeCounter = 0;
        while (level.length > 1) {
          const next: Segment[] = [];
          for (let i = 0; i < level.length; i += 2) {
            if (i + 1 >= level.length) {
              // Odd one out this round — carries forward untouched to the
              // next round instead of forcing an unnecessary re-encode.
              next.push(level[i]);
              continue;
            }
            const a = level[i];
            const b = level[i + 1];
            const t = Math.max(0.05, Math.min(effectiveTransitionSec, a.dur / 2, b.dur / 2));
            const offset = Math.max(0, a.dur - t);
            const mergedPath = path.join(tmpDir, `merged${mergeCounter++}.mp4`);
            await runFfmpeg([
              "-y",
              "-i", a.path,
              "-i", b.path,
              "-filter_complex",
              `[0:v][1:v]xfade=transition=${effectiveTransition}:duration=${t.toFixed(3)}:offset=${offset.toFixed(3)}[v];[0:a][1:a]acrossfade=d=${t.toFixed(3)}[a]`,
              "-map", "[v]", "-map", "[a]",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p",
              ...AAC_OUT,
              mergedPath,
            ]);
            next.push({ path: mergedPath, dur: a.dur + b.dur - t });
          }
          level = next;
        }
        fs.copyFileSync(level[0].path, finalPath);
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
