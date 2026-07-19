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
import { resolveStoryboardOrder, resolveChainNodeIds } from "@/lib/storyboard";
import { estimateSpeechSeconds, probeDurationSec, pickBestSegment } from "@/lib/storyboardTrim";
import { wrapCaption, CAPTION_FONT_FILE, CAPTION_FONT_FILE_BOLD, type CaptionStylePreset } from "@/lib/storyboardCaptions";
import { interpretEditingFeedback } from "@/lib/storyboardFeedback";
import type { StoryboardState, StoryboardTransitionPreset, TranscriptSegment } from "@/lib/types";

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

// How far past the script-text-estimated shot duration we're willing to
// extend a cut point looking for a natural pause. Bounded on purpose — this
// is a "let the sentence/reaction finish" nudge, not a license to let one
// shot balloon and throw off the whole video's pacing.
//
// Was 1.5s — far too tight in practice. The base estimate (estimateSpeechSeconds)
// assumes a brisk ~155wpm voiceover-read pace, but real UGC testimonials are
// often slower and less clipped than that — pauses, "like", trailing off,
// genuine emotion taking a beat to land — so the base guess regularly landed
// short of where the sentence/reaction actually finished. A 1.5s search
// window for the real pause was usually too narrow to reach it, so the cut
// kept landing at the same unsafe spot (reported repeatedly as "cuts off
// right at 'I need'" — the render was chopping the line before the speaker
// finished it). Widened to give real speech room to actually finish.
const NATURAL_PAUSE_EXTEND_MAX_SEC = 5;

// Runs ffmpeg's silencedetect filter over [fromSec, toSec) of srcPath and
// returns every silence_start timestamp found (as absolute seconds into
// srcPath, not relative to fromSec). Used to find where a shot's audio
// actually has a natural gap, rather than always hard-cutting at the
// estimateSpeechSeconds() guess regardless of whether that guess landed
// mid-word or mid-expression.
function findSilenceStarts(srcPath: string, fromSec: number, toSec: number): Promise<number[]> {
  return new Promise((resolve) => {
    const windowSec = Math.max(0.1, toSec - fromSec);
    const p = spawn("ffmpeg", [
      "-y", "-ss", String(fromSec), "-t", String(windowSec), "-i", srcPath,
      "-af", "silencedetect=noise=-30dB:d=0.25",
      "-f", "null", "-",
    ]);
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", () => {
      clearTimeout(timer);
      const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => fromSec + parseFloat(m[1]));
      resolve(starts);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

// Nudges a shot's cut-off point forward to the nearest natural pause in the
// audio, instead of always hard-cutting exactly at the script-text-estimated
// duration — the reported "cuts off mid-word right as the transition to the
// next shot starts, doesn't let the reaction/emotion finish playing out"
// problem. Bounded by NATURAL_PAUSE_EXTEND_MAX_SEC and by the clip's own
// remaining length; falls back to the original estimate (unchanged
// behavior) if no pause is found in that window, or if detection itself
// fails for any reason — this is a nice-to-have polish pass, never worth
// blocking or breaking a shot's encode over.
async function extendToNaturalPause(srcPath: string, startSec: number, targetSec: number, clipDurationSec: number): Promise<number> {
  const minEnd = startSec + targetSec;
  const maxEnd = Math.min(clipDurationSec, minEnd + NATURAL_PAUSE_EXTEND_MAX_SEC);
  if (maxEnd <= minEnd) return targetSec;
  try {
    const starts = await findSilenceStarts(srcPath, minEnd, maxEnd);
    if (starts.length > 0) {
      return Math.max(targetSec, starts[0] - startSec);
    }
    // No detected silence anywhere in the extended window — in practice
    // this almost always means the speaker is still talking continuously
    // all the way through it (a genuinely mid-sentence/mid-reaction cut
    // point), not that there's nothing worth extending for. Falling back to
    // the original short estimate here would put the cut right back at the
    // exact spot this function exists to avoid, so extend to the full
    // window instead — a few extra seconds of real content is a much safer
    // failure mode than truncating someone mid-word.
    return maxEnd - startSec;
  } catch {
    // Best-effort — fall through to the original estimate.
  }
  return targetSec;
}

// Pulls the audio for a (possibly padded) [fromSec, fromSec+durationSec)
// window of srcPath. Goes through runFfmpeg so it shares its kill-timeout
// instead of being able to hang indefinitely.
function extractAudioWindow(srcPath: string, fromSec: number, durationSec: number, outPath: string): Promise<void> {
  return runFfmpeg([
    "-y", "-ss", String(fromSec), "-t", String(durationSec), "-i", srcPath,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
    outPath,
  ]);
}

// How much surrounding audio (before/after the shot's actual [startSec,
// startSec+durationSec) window) to include when sending audio to Whisper for
// word-level timing, clamped to the source clip's real bounds. Purely for
// transcription context — words from the padding are filtered back out
// afterward (see transcribeShotAudio). Whisper's per-word timestamps get
// noticeably less accurate right at the edges of a short, hard-clipped
// audio file (a word cut off mid-sound at the very start/end of the file
// throws off its own alignment and can drag neighboring words' timestamps
// with it) — reported as "captions don't match the person's actual speaking
// pace." Giving Whisper a little real audio before and after the window it
// actually needs anchors the alignment properly; the extra words at the
// edges just get discarded once we only keep what falls inside the shot's
// real window.
const WHISPER_CONTEXT_PAD_SEC = 1.5;

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

// Whisper is well known for hallucinating stock YouTube-outro-style phrases
// ("thank you for watching", "please like and subscribe"...) when fed
// near-silent or very quiet audio — it was trained on captioned YouTube
// video, where those lines are extremely common right where the audio
// trails off. probeHasAudio only checks whether an audio STREAM exists,
// not whether it's actually audible speech, so a quiet room-tone shot can
// still reach Whisper and come back with confidently "transcribed"
// boilerplate that was never actually said. Checked against the FULL
// joined transcript (not per-chunk) so a hallucinated phrase spanning
// multiple caption chunks still gets caught.
const HALLUCINATION_PATTERNS = [
  /thank(s| you) for watching/i,
  /(please\s+)?(like and )?subscribe/i,
  /don'?t forget to (like and )?subscribe/i,
  /see you (in the )?next (video|time)/i,
  /^(you|bye( bye)?|thanks?)\.?$/i,
];

function looksLikeHallucination(fullText: string): boolean {
  const clean = fullText.trim();
  if (clean.length <= 2) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(clean));
}

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
export async function transcribeShotAudio(
  srcPath: string,
  startSec: number,
  durationSec: number,
  clipDurationSec: number,
  tmpDir: string,
  index: number
): Promise<TranscriptSegment[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    // Extract with a little real audio on either side of the shot's actual
    // window (clamped to the clip's real bounds) — see WHISPER_CONTEXT_PAD_SEC's
    // doc comment for why an isolated, hard-clipped window throws off
    // Whisper's own word-timing accuracy.
    const padLeft = Math.min(WHISPER_CONTEXT_PAD_SEC, startSec);
    const padRight = Math.min(WHISPER_CONTEXT_PAD_SEC, Math.max(0, clipDurationSec - (startSec + durationSec)));
    const extractStart = startSec - padLeft;
    const extractDuration = padLeft + durationSec + padRight;

    const audioPath = path.join(tmpDir, `whisper_${index}.mp3`);
    await extractAudioWindow(srcPath, extractStart, extractDuration, audioPath);
    const rawWords = await Promise.race([
      transcribeShotWords(audioPath),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Whisper transcription timed out")), 30_000)),
    ]);
    if (!rawWords) return null;

    // rawWords' timestamps are relative to extractStart (0 = extractStart),
    // not to the shot's own window (0 = startSec) — shift by padLeft so
    // downstream code (and the final drawtext filter, which is built against
    // the shot's own [0, durationSec) timeline) doesn't need to know padding
    // ever happened. Keep a word if it overlaps the real window at all (its
    // shifted end > 0 and shifted start < durationSec), then clamp into
    // [0, durationSec] so a word straddling the boundary doesn't produce a
    // caption cue that starts before or runs past the shot itself.
    const words = rawWords
      .map((w) => ({ word: w.word, start: w.start - padLeft, end: w.end - padLeft }))
      .filter((w) => w.end > 0 && w.start < durationSec)
      .map((w) => ({ word: w.word, start: Math.max(0, w.start), end: Math.min(durationSec, w.end) }));
    if (!words.length) return null;

    const fullText = words.map((w) => w.word).join(" ");
    if (looksLikeHallucination(fullText)) return null;
    const grouped = groupWordsIntoCaptions(words);
    return grouped.length ? grouped : null;
  } catch {
    return null;
  }
}

export function mediaPathFromUrl(url: string): string | null {
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
// `clipStartSec` is the SAME value passed to this shot's own `-ss` when
// encoding the segment below (`startSec` in the video branch of the loop
// this is called from) — see the doc comment on the call site for why it
// has to be added in here rather than left at 0. Segments come in already
// shot-relative (0 = startSec, per transcribeShotAudio's own doc comment),
// so this just re-expresses that shot-relative time in the absolute source
// timeline drawtext's `enable=between(t,...)` actually evaluates against.
function timedCaptionFilter(tmpDir: string, shotIndex: number, segments: TranscriptSegment[], style: CaptionStylePreset, clipStartSec: number): string | null {
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
    const start = Math.max(0, clipStartSec + seg.start).toFixed(2);
    const end = Math.max(clipStartSec + seg.start + 0.1, clipStartSec + seg.end).toFixed(2);
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

// Concatenates already-encoded per-shot segments into one final video with
// crossfade transitions between them, writing the result to finalPath.
// Shared by the AI render pipeline and the manual-edit render pipeline
// below — extracted so both go through the exact same, already-tuned
// assembly logic (binary-tree merge, not a single giant filter_complex or a
// linear fold-left — see the inline comments for why those two both failed
// in production: resource exhaustion on a long board, and cumulative
// generation-loss blur/muffling, respectively).
async function assembleFinalVideo(
  segmentPaths: string[],
  segDurations: number[],
  tmpDir: string,
  finalPath: string,
  transition: StoryboardTransitionPreset,
  transitionSec: number
): Promise<void> {
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], finalPath);
    return;
  }
  // Used to build ONE filter_complex chaining every segment's
  // xfade+acrossfade together, with all N segment files open as ffmpeg
  // inputs simultaneously. That works for a few shots, but in production a
  // longer board (19 shots -> 18 chained xfade/acrossfade pairs, 19
  // simultaneously-open decoders) reliably blew up with "Resource
  // temporarily unavailable" / "Failed to inject frame into filter network"
  // — ffmpeg running out of some resource (file descriptors / buffered
  // frames) partway through such a deep graph.
  //
  // The first fix for that (merge 2 clips at a time, left to right, into a
  // growing chain of intermediate files) traded that crash for a different,
  // worse problem: linear "fold-left" means the FIRST segment gets
  // re-encoded once per remaining segment — for 19 shots, shot 1's content
  // goes through 18 successive lossy re-encode generations before reaching
  // the final file, which is exactly the visible blur/muffled-audio quality
  // loss reported after that fix shipped.
  //
  // A balanced binary-tree merge keeps the "only 2 inputs open per ffmpeg
  // call" property (still avoids the resource-exhaustion crash) while
  // capping every piece of original content at ceil(log2(N)) re-encode
  // generations instead of up to N-1 — for 19 shots that's 5 generations
  // worst-case instead of 18, a huge reduction in cumulative generation
  // loss for both video and audio.
  type Segment = { path: string; dur: number };
  let level: Segment[] = segmentPaths.map((p, i) => ({ path: p, dur: segDurations[i] }));
  let mergeCounter = 0;
  while (level.length > 1) {
    const next: Segment[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        // Odd one out this round — carries forward untouched to the next
        // round instead of forcing an unnecessary re-encode.
        next.push(level[i]);
        continue;
      }
      const a = level[i];
      const b = level[i + 1];
      const t = Math.max(0.05, Math.min(transitionSec, a.dur / 2, b.dur / 2));
      const offset = Math.max(0, a.dur - t);
      const mergedPath = path.join(tmpDir, `merged${mergeCounter++}.mp4`);
      await runFfmpeg([
        "-y",
        "-i", a.path,
        "-i", b.path,
        "-filter_complex",
        `[0:v][1:v]xfade=transition=${transition}:duration=${t.toFixed(3)}:offset=${offset.toFixed(3)}[v];[0:a][1:a]acrossfade=d=${t.toFixed(3)}[a]`,
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

// Fire-and-forget — starts the render in the background and returns
// immediately with the job's initial state. If a render for this exact key
// is already running, returns that existing job instead of starting a
// second overlapping one.
export function startRenderJob(
  key: string,
  board: StoryboardState,
  outDir: string,
  publicUrlPrefix: string,
  captionsMode: CaptionsMode = "off",
  chainTailId?: string
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
  // different shots) is just as "connected" as the real chain.
  //
  // chainTailId — the id of the specific chain-tail node whose Generate
  // button was actually clicked (StoryboardCanvas.tsx renders one button
  // per chain via resolveChainTails, so the button IS the chain) — scopes
  // the render deterministically to exactly that chain's nodes, walking
  // backward via resolveChainNodeIds. This replaced an earlier "auto-detect
  // the one true chain" heuristic (scored candidate components by size,
  // then by renderable-clip count) that kept getting outsmarted by messy
  // real-world boards accumulating several unrelated chains over time —
  // including once excluding an ENTIRE real chain's worth of shots because
  // some other leftover chain scored higher. No more guessing needed: the
  // click tells us exactly which chain was meant.
  const scopedChainIds = chainTailId ? resolveChainNodeIds(chainTailId, board.connections) : null;
  const skipped: string[] = [];
  const usable = order.filter((n) => {
    if (scopedChainIds && !scopedChainIds.has(n.id)) {
      // Not skip-logged — this is every OTHER chain/card on the board,
      // which is normal and not worth reporting as "skipped" (that's
      // reserved for things that were part of the intended chain but
      // couldn't be used).
      return false;
    }
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
          let targetSec = Math.min(20, Math.max(1, estimateSpeechSeconds(text) * durationMultiplier));
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
            // Don't hard-cut exactly at the script-text estimate if that
            // lands mid-word or mid-expression right before the transition
            // to the next shot — nudge forward (bounded) to wherever the
            // audio actually has a natural pause, so the sentence/reaction
            // finishes playing out before the cut.
            targetSec = await extendToNaturalPause(srcPath, startSec, targetSec, clipDurationSec);
          }
          intendedSec = targetSec;
          if (captionsMode === "auto" && hasAudio) {
            const segments = await transcribeShotAudio(srcPath, startSec, targetSec, clipDurationSec, tmpDir, i);
            // `startSec` here is the SAME value fed to `-ss` below. Passed
            // through so timedCaptionFilter can express its drawtext
            // enable= windows in absolute source time — see that function's
            // doc comment for why: `-ss` positioned after `-vf` (as it is
            // here) trims the OUTPUT after filtering runs, so drawtext's own
            // internal `t` clock is measured against the untrimmed source,
            // not the trimmed shot. Confirmed by direct ffmpeg testing
            // (enable='between(t,0,dur)' with a trailing `-ss startSec`
            // stayed invisible the whole trimmed clip; only
            // between(t,startSec,startSec+dur) actually showed it) — without
            // this, any shot where the AI picked a non-zero start point
            // (i.e. most shots on a source video longer than the target
            // speech length) would burn captions in at the wrong moment.
            if (segments) caption = timedCaptionFilter(tmpDir, i, segments, captionStyle, startSec);
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
      job.step = "Assembling final video (transitions + audio crossfade)...";
      await assembleFinalVideo(segmentPaths, segDurations, tmpDir, finalPath, effectiveTransition, effectiveTransitionSec);

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

// ---- Manual edit render ----
// A separate, much simpler render path for the "✂️ Manual Edit" timeline
// editor (StoryboardCanvas.tsx / ManualEditModal.tsx) — the creator directly
// picks each clip's in/out points and any text overlays themselves, instead
// of the AI render pipeline above choosing them (smart-trim, natural-pause
// extension, Whisper captions, editing-feedback interpretation — none of
// that applies here; the whole point of this path is "do exactly what I
// told you, nothing smarter"). Shares runFfmpeg/assembleFinalVideo/the
// same `jobs` map + RenderJob polling shape with the AI path above so the
// client can reuse the exact same polling logic, just against a
// manual-render job key instead.

export interface ManualEditClipInput {
  nodeId: string;
  url: string;
  kind: "video" | "image";
  // Seconds into the SOURCE clip. For images, trimStart is always treated
  // as 0 and trimEnd is just "how many seconds to show this image for".
  trimStart: number;
  trimEnd: number;
  label: string;
}

export interface ManualEditTextOverlay {
  // Index into the clips array (post-reorder) this overlay is burned onto.
  clipIndex: number;
  text: string;
  // Seconds relative to the CLIP'S OWN trimmed timeline (0 = the moment
  // this clip starts playing, after trimming).
  startSec: number;
  endSec: number;
  // All optional, default to "bottom"/"medium"/non-bold/white if omitted —
  // kept optional so older client payloads (pre-styling) still work.
  position?: "top" | "center" | "bottom";
  size?: "small" | "medium" | "large";
  bold?: boolean;
  // "#rrggbb" hex from the client's <input type="color">. Real font-family
  // swapping would mean bundling/apt-installing more font files (see
  // storyboardCaptions.ts's doc comment on CAPTION_FONT_FILE) — bold weight
  // + color are the styling knobs actually wired up to ffmpeg drawtext.
  color?: string;
}

// A clip dropped onto ManualEditModal.tsx's B-roll row — positioned by
// absolute time on the GLOBAL timeline (unlike ManualEditClipInput, which is
// ordered/concatenated end-to-end), so it can overlap whichever base clip(s)
// happen to be playing during [startSec, startSec+duration). Composited on
// top of the base video during that window via ffmpeg's `overlay` filter —
// see the B-roll handling inside startManualRenderJob's per-clip loop below.
// v1 simplification: a B-roll segment spanning a cut between two base clips
// is truncated to just the first clip's remaining time rather than split
// across the boundary (splitting would mean building the SAME overlay twice
// against two different clip segments, correctly time-shifted in each —
// doable but not worth the complexity for how rarely a dragged B-roll clip
// would land exactly on a cut).
// boxX/boxY/boxW/boxH position the B-roll WITHIN the 9:16 output canvas as
// 0-1 fractions (0,0,1,1 = full-frame cutaway, the original/default
// behavior) — dragged/resized in ManualEditModal.tsx's live preview (see
// that file's beginBrollBoxMoveDrag/beginBrollBoxResizeDrag) to shrink it
// into a picture-in-picture inset instead. Optional + defaulted to full
// frame at every read site so older cached client payloads without these
// fields still render exactly as before.
export interface ManualEditBRollInput {
  url: string;
  kind: "video" | "image";
  startSec: number; // position on the whole timeline's global clock
  duration: number;
  trimStart: number; // in-point within the broll's OWN source (video only)
  label: string;
  boxX?: number;
  boxY?: number;
  boxW?: number;
  boxH?: number;
}

// A single optional background-music track for the whole manual-edit export
// — unlike B-roll (positioned at a specific point) this spans the entire
// final video, looped if shorter than the render or trimmed if longer (see
// the `-stream_loop -1` + `amix=duration=first` mixing pass at the end of
// startManualRenderJob), mixed under whatever audio the clips themselves
// already have at `volume` (0-1).
export interface ManualEditMusicInput {
  url: string;
  volume: number;
}

// One entry per boundary BETWEEN adjacent clips in the manual-edit timeline
// (so `clips.length - 1` entries) — lets the creator pick a different
// transition at each cut, unlike the AI render pipeline's one preset for
// the whole video. "hard_cut" is approximated the same way the AI pipeline
// does it (see startRenderJob): a very short 0.05s fade rather than a true
// zero-duration cut, since ffmpeg's xfade needs a nonzero duration.
export interface ManualEditTransition {
  preset: StoryboardTransitionPreset;
  sec: number;
}

const OVERLAY_SIZE_PX: Record<NonNullable<ManualEditTextOverlay["size"]>, number> = { small: 26, medium: 36, large: 50 };

// Converts a "#rrggbb" hex from the client's color picker into ffmpeg
// drawtext's expected `0xRRGGBB` form, falling back to white on anything
// that isn't a clean 6-digit hex (a stray value here would otherwise break
// the whole filtergraph string, failing the render).
function toFfmpegColor(hex: string | undefined): string {
  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) return `0x${hex.slice(1)}`;
  return "white";
}

// `clipTrimStart` is the SAME value this clip's own `-ss` uses below (see
// startManualRenderJob's call site) — required for the same reason
// timedCaptionFilter (the AI-render pipeline's equivalent, above) takes a
// `clipStartSec` param: an output-positioned `-ss` trims AFTER filtering
// runs, so drawtext's `enable=between(t,...)` is evaluated against the
// UNTRIMMED source's own timeline, not the trimmed clip's — confirmed by
// direct ffmpeg testing. o.startSec/o.endSec are authored as "seconds after
// this clip's own trim point" (per TextOverlay's doc comment on the client),
// so clipTrimStart has to be added back in here to land at the right
// absolute moment. Without this, any clip trimmed at the start (trimStart >
// 0) would burn its captions in `trimStart` seconds too late.
function manualCaptionFilter(tmpDir: string, clipIndex: number, overlays: ManualEditTextOverlay[], clipTrimStart: number): string | null {
  const forThisClip = overlays.filter((o) => o.clipIndex === clipIndex && o.text.trim());
  if (forThisClip.length === 0) return null;
  const boxBorder = Math.round(14 * CAPTION_SCALE);
  const margin = Math.round(90 * CAPTION_SCALE);
  const parts = forThisClip.map((o, i) => {
    const capPath = path.join(tmpDir, `mcap${clipIndex}_${i}.txt`);
    fs.writeFileSync(capPath, wrapCaption(o.text, "descriptive"));
    const start = Math.max(0, clipTrimStart + o.startSec).toFixed(2);
    const end = Math.max(clipTrimStart + o.startSec + 0.1, clipTrimStart + o.endSec).toFixed(2);
    const fontsize = Math.round((OVERLAY_SIZE_PX[o.size || "medium"]) * CAPTION_SCALE);
    const yExpr = o.position === "top" ? `${margin}` : o.position === "center" ? `(h-th)/2` : `h-th-${margin}`;
    const fontFile = o.bold ? CAPTION_FONT_FILE_BOLD : CAPTION_FONT_FILE;
    const fontColor = toFfmpegColor(o.color);
    return `drawtext=fontfile=${fontFile}:textfile=${capPath}:reload=0:fontcolor=${fontColor}:fontsize=${fontsize}:box=1:boxcolor=black@0.5:boxborderw=${boxBorder}:x=(w-text_w)/2:y=${yExpr}:enable='between(t\\,${start}\\,${end})'`;
  });
  return parts.join(",");
}

// Builds a filter_complex graph that composites 0+ B-roll segments on top of
// a single base clip (input 0) — one `overlay` step per segment, each gated
// to its own [absStart, absEnd) window via `enable=between(t,...)`, same
// time-gating pattern (and same absolute-source-time basis — see
// manualCaptionFilter's doc comment above) as the caption drawtext filters.
// Only called when there's at least one B-roll segment overlapping this
// clip; otherwise the caller keeps using the plain, single-input `-vf` path
// unchanged. Returns the name of the final composited (and, if `caption` is
// set, captioned) video pad to `-map`.
function buildBrollFilterComplex(
  baseFilter: string,
  caption: string | null,
  firstBrollInputIndex: number,
  segments: { absStart: number; absEnd: number; boxX: number; boxY: number; boxW: number; boxH: number }[]
): { filterComplex: string; videoPad: string } {
  const parts: string[] = [`[0:v]${baseFilter}[base]`];
  let cur = "base";
  segments.forEach((seg, i) => {
    const inIdx = firstBrollInputIndex + i;
    const brollPad = `broll${i}`;
    const overlayPad = `ov${i}`;
    // Scaled/padded to the segment's OWN box size (in pixels, derived from
    // its 0-1 canvas-fraction boxW/boxH) and drawn at its own boxX/boxY —
    // not always the full WxH canvas at 0,0 like before — which is what
    // lets a B-roll shrink into a picture-in-picture inset instead of
    // always being a full-frame cutaway. Mirrors exactly what
    // ManualEditModal.tsx's live preview shows (same box math — see that
    // file's beginBrollBoxMoveDrag/beginBrollBoxResizeDrag), so what the
    // editor sees while dragging is what actually renders.
    const boxWpx = Math.max(2, Math.round(seg.boxW * W));
    const boxHpx = Math.max(2, Math.round(seg.boxH * H));
    const boxXpx = Math.round(seg.boxX * W);
    const boxYpx = Math.round(seg.boxY * H);
    const segScalePad = `scale=${boxWpx}:${boxHpx}:force_original_aspect_ratio=decrease,pad=${boxWpx}:${boxHpx}:(ow-iw)/2:(oh-ih)/2,fps=${FPS}`;
    parts.push(`[${inIdx}:v]${segScalePad}[${brollPad}]`);
    parts.push(
      `[${cur}][${brollPad}]overlay=${boxXpx}:${boxYpx}:enable='between(t\\,${seg.absStart.toFixed(2)}\\,${seg.absEnd.toFixed(2)})'[${overlayPad}]`
    );
    cur = overlayPad;
  });
  if (caption) {
    parts.push(`[${cur}]${caption}[capped]`);
    cur = "capped";
  }
  return { filterComplex: parts.join(";"), videoPad: cur };
}

// Merges segments STRICTLY in order, left to right, using a possibly
// DIFFERENT transition preset/duration at each boundary — unlike
// assembleFinalVideo's balanced binary-tree merge (which is order-agnostic
// about WHICH transition plays where, since the AI pipeline only ever
// applies one uniform transition to the whole video), a per-boundary
// transition choice only makes sense merged in the original left-to-right
// order. Manual-edit timelines are also typically much shorter than a full
// AI-rendered board (a handful of curated clips, not up to 19 auto-picked
// shots), so the "first segment gets re-encoded once per remaining
// segment" generation-loss concern that forced the AI pipeline off linear
// merging is a much smaller tradeoff here — and giving the creator control
// over each individual cut's transition is worth it for this path.
async function mergeSequentialWithTransitions(
  segmentPaths: string[],
  segDurations: number[],
  transitions: ManualEditTransition[],
  tmpDir: string,
  finalPath: string
): Promise<void> {
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], finalPath);
    return;
  }
  let accPath = segmentPaths[0];
  let accDur = segDurations[0];
  for (let i = 1; i < segmentPaths.length; i++) {
    const nextPath = segmentPaths[i];
    const nextDur = segDurations[i];
    const trans = transitions[i - 1] || { preset: "fade", sec: TRANSITION_SEC };
    const preset = trans.preset === "hard_cut" ? "fade" : trans.preset;
    const t = trans.preset === "hard_cut" ? 0.05 : Math.max(0.05, Math.min(trans.sec, accDur / 2, nextDur / 2));
    const offset = Math.max(0, accDur - t);
    const mergedPath = path.join(tmpDir, `mmerged${i}.mp4`);
    await runFfmpeg([
      "-y",
      "-i", accPath,
      "-i", nextPath,
      "-filter_complex",
      `[0:v][1:v]xfade=transition=${preset}:duration=${t.toFixed(3)}:offset=${offset.toFixed(3)}[v];[0:a][1:a]acrossfade=d=${t.toFixed(3)}[a]`,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p",
      ...AAC_OUT,
      mergedPath,
    ]);
    accPath = mergedPath;
    accDur = accDur + nextDur - t;
  }
  fs.copyFileSync(accPath, finalPath);
}

// Fire-and-forget, same shape as startRenderJob — starts in the background,
// client polls getRenderJob(key) same as always. Uses a caller-supplied key
// (StoryboardCanvas.tsx namespaces it, e.g. `manual:${aiRenderKey}`) so a
// manual-edit render and an AI render for the same board can't collide in
// the shared `jobs` map.
export function startManualRenderJob(
  key: string,
  clips: ManualEditClipInput[],
  textOverlays: ManualEditTextOverlay[],
  transitions: ManualEditTransition[],
  broll: ManualEditBRollInput[],
  music: ManualEditMusicInput | null,
  outDir: string,
  publicUrlPrefix: string
): { started: boolean; job: RenderJob } {
  const existing = jobs.get(key);
  if (existing && existing.status === "running") {
    return { started: false, job: existing };
  }

  const startedAt = new Date().toISOString();
  if (clips.length === 0) {
    const job: RenderJob = {
      status: "error",
      totalShots: 0,
      completedShots: 0,
      step: "",
      startedAt,
      finishedAt: startedAt,
      avgSecPerShot: null,
      result: null,
      error: "No clips to export — add at least one shot to the timeline first.",
    };
    jobs.set(key, job);
    return { started: true, job };
  }

  const job: RenderJob = {
    status: "running",
    totalShots: clips.length,
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
  const skipped: string[] = [];

  (async () => {
    const jobStartMs = Date.now();
    try {
      const segmentPaths: string[] = [];
      const segDurations: number[] = [];
      // Nominal-duration accumulator matching the CLIENT's own timeline math
      // (itemDur/offsetOfItem in ManualEditModal.tsx) — this is what lets a
      // B-roll block dropped at, say, "6.2s into the whole sequence" get
      // matched back to whichever base clip actually covers that moment.
      let clipGlobalStart = 0;

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        job.step = `Encoding clip ${i + 1} of ${clips.length}...`;
        const srcPath = mediaPathFromUrl(clip.url);
        if (!srcPath || !fs.existsSync(srcPath)) {
          skipped.push(`${clip.label || "untitled clip"} (file missing)`);
          job.completedShots++;
          continue;
        }
        // Images always play from their own t=0 (no trim-start concept for
        // a still), so only video clips need the offset.
        const clipTrimStart = clip.kind === "video" ? clip.trimStart : 0;
        const caption = manualCaptionFilter(tmpDir, i, textOverlays, clipTrimStart);
        const segPath = path.join(tmpDir, `mseg${i}.mp4`);
        const videoOut = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p"];

        const nominalDur = clip.kind === "video" ? Math.max(0.3, clip.trimEnd - clip.trimStart) : Math.max(0.3, clip.trimEnd);
        const clipStart = clipGlobalStart;
        const clipEnd = clipStart + nominalDur;
        clipGlobalStart = clipEnd;

        // Which B-roll segments (if any) fall inside this clip's window,
        // clamped to it and re-expressed in the clip's own absolute-source
        // time (0 = clip's untrimmed source start — see manualCaptionFilter's
        // doc comment for why that's the basis `enable=between(t,...)` needs).
        const brollHits = broll
          .map((b) => {
            const overlapStart = Math.max(b.startSec, clipStart);
            const overlapEnd = Math.min(b.startSec + b.duration, clipEnd);
            if (overlapEnd - overlapStart < 0.05) return null;
            return {
              b,
              absStart: clipTrimStart + (overlapStart - clipStart),
              absEnd: clipTrimStart + (overlapEnd - clipStart),
            };
          })
          .filter((h): h is { b: ManualEditBRollInput; absStart: number; absEnd: number } => h !== null);
        // Cap each VIDEO B-roll hit's visible window to however much of its
        // own source footage actually exists past its trim-in point — a
        // duration dragged out further than the source's real length would
        // otherwise leave the overlay filter waiting on frames that were
        // never going to arrive.
        for (const hit of brollHits) {
          if (hit.b.kind !== "video") continue;
          const brollSrc = mediaPathFromUrl(hit.b.url);
          if (!brollSrc || !fs.existsSync(brollSrc)) continue;
          const srcDur = await probeDurationSec(brollSrc);
          if (srcDur > 0) {
            const available = Math.max(0.3, srcDur - hit.b.trimStart);
            hit.absEnd = Math.min(hit.absEnd, hit.absStart + available);
          }
        }
        const validHits = brollHits.filter((h) => {
          const p = mediaPathFromUrl(h.b.url);
          return !!p && fs.existsSync(p) && h.absEnd - h.absStart > 0.05;
        });
        const brollInputArgs: string[] = [];
        validHits.forEach((hit) => {
          const brollSrc = mediaPathFromUrl(hit.b.url)!;
          if (hit.b.kind === "image") {
            brollInputArgs.push("-loop", "1", "-itsoffset", hit.absStart.toFixed(3), "-i", brollSrc);
          } else {
            // -itsoffset delays this input's OWN presented timestamps so it
            // starts showing ITS OWN frame 0 exactly when the overlay window
            // opens, rather than already being `absStart` seconds into
            // itself the moment it becomes visible.
            brollInputArgs.push("-ss", String(hit.b.trimStart), "-itsoffset", hit.absStart.toFixed(3), "-i", brollSrc);
          }
        });

        if (clip.kind === "video") {
          const dur = nominalDur;
          const hasAudio = await probeHasAudio(srcPath);
          if (validHits.length === 0) {
            // No B-roll on this clip — the original, simpler single-input
            // path, unchanged.
            if (hasAudio) {
              await runFfmpeg([
                "-y", "-i", srcPath,
                "-vf", withCaption(scalePad, caption),
                ...videoOut,
                ...AAC_OUT,
                "-ss", String(clip.trimStart), "-t", String(dur),
                segPath,
              ]);
            } else {
              await runFfmpeg([
                "-y", "-i", srcPath, ...SILENT_AUDIO,
                "-vf", withCaption(scalePad, caption),
                "-map", "0:v:0", "-map", "1:a:0",
                ...videoOut,
                ...AAC_OUT,
                "-ss", String(clip.trimStart), "-t", String(dur), "-shortest",
                segPath,
              ]);
            }
          } else {
            // base=0, [silent-audio lavfi=1 if this clip has no audio of its
            // own], B-roll input(s) after that.
            const firstBrollIdx = hasAudio ? 1 : 2;
            const { filterComplex, videoPad } = buildBrollFilterComplex(
              scalePad,
              caption,
              firstBrollIdx,
              validHits.map((h) => ({
                absStart: h.absStart,
                absEnd: h.absEnd,
                boxX: h.b.boxX ?? 0,
                boxY: h.b.boxY ?? 0,
                boxW: h.b.boxW ?? 1,
                boxH: h.b.boxH ?? 1,
              }))
            );
            await runFfmpeg([
              "-y", "-i", srcPath,
              ...(hasAudio ? [] : SILENT_AUDIO),
              ...brollInputArgs,
              "-filter_complex", filterComplex,
              "-map", `[${videoPad}]`, "-map", hasAudio ? "0:a:0" : "1:a:0",
              ...videoOut,
              ...AAC_OUT,
              "-ss", String(clip.trimStart), "-t", String(dur),
              ...(hasAudio ? [] : ["-shortest"]),
              segPath,
            ]);
          }
        } else {
          const dur = nominalDur;
          const marginW = Math.round(W * 1.2);
          const marginH = Math.round(H * 1.2);
          const frames = Math.max(1, Math.round(FPS * dur));
          const kenBurns =
            `scale=${marginW}:${marginH}:force_original_aspect_ratio=increase,crop=${marginW}:${marginH},` +
            `zoompan=z='min(zoom+0.0008,1.15)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`;
          if (validHits.length === 0) {
            await runFfmpeg([
              "-y", "-loop", "1", "-i", srcPath, ...SILENT_AUDIO,
              "-vf", withCaption(kenBurns, caption),
              "-map", "0:v:0", "-map", "1:a:0",
              ...videoOut,
              ...AAC_OUT,
              "-t", String(dur), "-shortest",
              segPath,
            ]);
          } else {
            // base=0, silent-audio lavfi=1 (images always need it), B-roll
            // input(s) from 2 onward.
            const { filterComplex, videoPad } = buildBrollFilterComplex(
              kenBurns,
              caption,
              2,
              validHits.map((h) => ({
                absStart: h.absStart,
                absEnd: h.absEnd,
                boxX: h.b.boxX ?? 0,
                boxY: h.b.boxY ?? 0,
                boxW: h.b.boxW ?? 1,
                boxH: h.b.boxH ?? 1,
              }))
            );
            await runFfmpeg([
              "-y", "-loop", "1", "-i", srcPath,
              ...SILENT_AUDIO,
              ...brollInputArgs,
              "-filter_complex", filterComplex,
              "-map", `[${videoPad}]`, "-map", "1:a:0",
              ...videoOut,
              ...AAC_OUT,
              "-t", String(dur), "-shortest",
              segPath,
            ]);
          }
        }
        segmentPaths.push(segPath);
        const realDur = await probeDurationSec(segPath);
        segDurations.push(realDur > 0 ? realDur : clip.trimEnd - clip.trimStart);
        job.completedShots++;
        job.avgSecPerShot = (Date.now() - jobStartMs) / 1000 / job.completedShots;
      }

      if (segmentPaths.length === 0) {
        throw new Error("None of the clips could be read from disk.");
      }

      // Separate filename from the AI pipeline's render.mp4 — an AI render
      // and a manual-edit export for the same board are two independent
      // artifacts (different jobs keys let them even run "concurrently" in
      // the jobs map), and sharing one filename would let whichever
      // finishes last silently clobber the other's output on disk.
      const finalPath = path.join(outDir, "manual-render.mp4");
      job.step = "Assembling final video...";
      // Per-boundary transitions, in original order — see
      // mergeSequentialWithTransitions's doc comment for why this path uses
      // a different merge strategy than the AI pipeline's binary tree.
      await mergeSequentialWithTransitions(segmentPaths, segDurations, transitions, tmpDir, finalPath);

      // Background music — mixed in as a final pass over the assembled
      // video rather than per-clip, since it's meant to play continuously
      // underneath the whole thing regardless of where cuts/transitions
      // land. `-stream_loop -1` on the music input loops it indefinitely so
      // a short track still covers a longer video; `amix=duration=first`
      // then trims the mixed audio back down to the video's own (first
      // input's) length either way, so it works whether the track is
      // shorter OR longer than the final render. Best-effort: a bad/missing
      // music file just means the export ships without it rather than
      // failing the whole render.
      if (music && music.url) {
        const musicSrc = mediaPathFromUrl(music.url);
        if (musicSrc && fs.existsSync(musicSrc)) {
          job.step = "Mixing background music...";
          try {
            const mixedPath = path.join(tmpDir, "final_with_music.mp4");
            const vol = Math.max(0, Math.min(1, music.volume));
            await runFfmpeg(
              [
                "-y",
                "-i", finalPath,
                "-stream_loop", "-1", "-i", musicSrc,
                "-filter_complex",
                `[1:a]volume=${vol.toFixed(2)}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
                "-map", "0:v:0", "-map", "[aout]",
                "-c:v", "copy",
                ...AAC_OUT,
                "-shortest",
                mixedPath,
              ],
              SINGLE_SHOT_TIMEOUT_MS
            );
            fs.copyFileSync(mixedPath, finalPath);
          } catch {
            // Ship without music rather than failing the export.
          }
        }
      }

      job.result = { url: `${publicUrlPrefix}/manual-render.mp4`, skipped, styleApplied: null, appliedFeedback: null };
      job.status = "done";
      job.step = "Done";
      job.finishedAt = new Date().toISOString();
    } catch (e: any) {
      job.status = "error";
      job.error = e?.message || "Export failed";
      job.finishedAt = new Date().toISOString();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();

  return { started: true, job };
}
