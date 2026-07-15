import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";
import { resolveStoryboardOrder } from "@/lib/storyboard";
import { estimateSpeechSeconds, probeDurationSec, pickBestSegment } from "@/lib/storyboardTrim";
import { wrapCaption, CAPTION_FONT_FILE, type CaptionStylePreset } from "@/lib/storyboardCaptions";
import { interpretEditingFeedback } from "@/lib/storyboardFeedback";
import type { StoryboardTransitionPreset } from "@/lib/types";

export const dynamic = "force-dynamic";

// Identical render pipeline to the Video Analysis storyboard's render
// route (captions, Ken Burns, crossfades, smart trim, dub preference,
// reference-style profile) — just reading/writing a standalone
// CreationProject's storyboard instead of a GeneratedScript's. See that
// route's comments for the full reasoning behind each piece; not repeated
// here to avoid the two copies drifting in their explanations.
const W = 720;
const H = 1280;
const DUB_SAFETY_CAP_SEC = 30;
const TRANSITION_SEC = 0.4;
const FPS = 30;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("close", (code, signal) => {
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
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => resolve(out.trim().length > 0));
    p.on("error", () => resolve(false));
  });
}

const SILENT_AUDIO = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
const AAC_OUT = ["-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k"];

function mediaPathFromUrl(url: string): string | null {
  if (!url.startsWith("/api/media/")) return null;
  const rel = url.slice("/api/media/".length).split("/").filter(Boolean);
  const p = path.join(getMediaDir(), ...rel);
  if (!p.startsWith(getMediaDir())) return null;
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

export async function POST(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const board = access.project.storyboard;
  if (!board || board.nodes.length === 0) {
    return NextResponse.json({ error: "This storyboard has no shots yet." }, { status: 400 });
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
  if (usable.length === 0) {
    return NextResponse.json(
      { error: "None of the shots have a clip attached yet — upload, pick from your library, or generate an AI reference image for at least one shot." },
      { status: 400 }
    );
  }

  const outDir = path.join(getMediaDir(), "storyboard", params.projectId);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, `_render_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const scalePad = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS}`;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const styleProfile = board.styleProfile || null;
  let captionStyle: CaptionStylePreset = styleProfile?.captionStyle || "descriptive";
  let durationMultiplier = styleProfile?.durationMultiplier ?? 1;
  let effectiveTransition: StoryboardTransitionPreset = styleProfile && styleProfile.transition !== "hard_cut" ? styleProfile.transition : "fade";
  let effectiveTransitionSec = styleProfile?.transition === "hard_cut" ? 0.05 : styleProfile?.transitionSec ?? TRANSITION_SEC;

  // "Regenerate with feedback" — board.direction is the docked "Overall
  // editing direction" textarea's value. It used to be inert (saved but
  // never read); now a non-empty note gets turned into adjustments to the
  // same pacing/caption/transition dials the reference-style profile above
  // also controls, so typing a note and clicking Regenerate actually
  // changes the output.
  const feedbackText = (board.direction || "").trim();
  let appliedFeedback: { notes: string } | null = null;
  if (feedbackText) {
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

  try {
    const segmentPaths: string[] = [];
    const segDurations: number[] = [];

    for (let i = 0; i < usable.length; i++) {
      const node = usable[i];
      const text = (node.instruction || node.label || "").trim();
      const caption = captionFilter(tmpDir, i, text, captionStyle);
      const useDub = node.dub?.status === "done" && node.dub.url;
      const clip = useDub ? { kind: "video" as const, url: node.dub!.url! } : node.clip!;
      const srcPath = mediaPathFromUrl(clip.url);
      if (!srcPath || !fs.existsSync(srcPath)) {
        skipped.push(`${node.label || "untitled shot"} (file missing)`);
        continue;
      }
      const segPath = path.join(tmpDir, `seg${i}.mp4`);
      const videoOut = ["-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p"];
      let intendedSec = 0;

      if (clip.kind === "video") {
        if (useDub) {
          intendedSec = DUB_SAFETY_CAP_SEC;
          await runFfmpeg([
            "-y", "-i", srcPath,
            "-vf", withCaption(scalePad, caption),
            ...videoOut,
            ...AAC_OUT,
            "-t", String(intendedSec),
            segPath,
          ]);
        } else {
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
    }

    if (segmentPaths.length === 0) {
      return NextResponse.json({ error: "None of the attached clips could be read from disk." }, { status: 500 });
    }

    const finalPath = path.join(outDir, "render.mp4");

    if (segmentPaths.length === 1) {
      fs.copyFileSync(segmentPaths[0], finalPath);
    } else {
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
      await runFfmpeg([
        "-y",
        ...inputArgs,
        "-filter_complex", filterParts.join(";"),
        "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
        "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p",
        ...AAC_OUT,
        finalPath,
      ]);
    }

    return NextResponse.json({
      url: `/api/media/storyboard/${params.projectId}/render.mp4`,
      skipped,
      styleApplied: styleProfile ? { pacing: styleProfile.pacing, transition: styleProfile.transition, notes: styleProfile.notes } : null,
      appliedFeedback,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Render failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
