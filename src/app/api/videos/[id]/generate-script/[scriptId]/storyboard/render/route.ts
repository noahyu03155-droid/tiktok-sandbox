import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo } from "@/lib/db";
import { resolveStoryboardOrder } from "@/lib/storyboard";

export const dynamic = "force-dynamic";

// Stitches whatever clips/reference stills are attached to a storyboard's
// nodes into one downloadable MP4 — hard cuts only, video track only (no
// audio track at all, to sidestep codec-mismatch headaches between real
// clips and AI-still-derived segments), normalized to a 720x1280 (9:16)
// canvas. This is NOT AI video generation — a node with no clip attached
// just gets skipped (reported back so the team knows what's missing), and
// nothing here calls a generative video model. That's an explicitly
// deferred, separately-scoped feature (needs picking + paying for a
// dedicated identity-preserving video-gen API).
const W = 720;
const H = 1280;
const MAX_CLIP_SEC = 8;
const IMAGE_SEC = 2.5;

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
      // code === null + a signal (usually SIGKILL) means something outside
      // ffmpeg itself killed the process — almost always the container
      // running out of memory mid-encode, not a bad input file. Surface
      // that plainly instead of dumping the raw ffprobe/stderr dump, which
      // is just informational stream metadata, not the actual failure.
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

function mediaPathFromUrl(url: string): string | null {
  if (!url.startsWith("/api/media/")) return null;
  const rel = url.slice("/api/media/".length).split("/").filter(Boolean);
  const p = path.join(getMediaDir(), ...rel);
  if (!p.startsWith(getMediaDir())) return null; // path traversal guard
  return p;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const script = video.generated_scripts.find((s) => s.id === params.scriptId);
  const board = script?.storyboard;
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

  const outDir = path.join(getMediaDir(), "storyboard", params.scriptId);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, `_render_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const scalePad = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30`;

  try {
    const segmentPaths: string[] = [];
    for (let i = 0; i < usable.length; i++) {
      const node = usable[i];
      const clip = node.clip!;
      const srcPath = mediaPathFromUrl(clip.url);
      if (!srcPath || !fs.existsSync(srcPath)) {
        skipped.push(`${node.label || "untitled shot"} (file missing)`);
        continue;
      }
      const segPath = path.join(tmpDir, `seg${i}.mp4`);
      // -preset veryfast + -threads 2 keep libx264's internal lookahead
      // buffering (its biggest memory cost) low — worth the small quality/
      // speed tradeoff on a container that doesn't have RAM to spare.
      if (clip.kind === "video") {
        await runFfmpeg([
          "-y", "-i", srcPath,
          "-t", String(MAX_CLIP_SEC),
          "-vf", scalePad,
          "-an",
          "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p",
          segPath,
        ]);
      } else {
        await runFfmpeg([
          "-y", "-loop", "1", "-i", srcPath,
          "-t", String(IMAGE_SEC),
          "-vf", scalePad,
          "-an",
          "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p",
          segPath,
        ]);
      }
      segmentPaths.push(segPath);
    }

    if (segmentPaths.length === 0) {
      return NextResponse.json({ error: "None of the attached clips could be read from disk." }, { status: 500 });
    }

    const listFile = path.join(tmpDir, "list.txt");
    fs.writeFileSync(listFile, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

    const finalPath = path.join(outDir, "render.mp4");
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalPath]);

    return NextResponse.json({ url: `/api/media/storyboard/${params.scriptId}/render.mp4`, skipped });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Render failed" }, { status: 500 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
