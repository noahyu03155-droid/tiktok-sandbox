import path from "path";
import fs from "fs";
import { updateVideoRecord, getVideo, getMediaDir } from "./db";
import { fetchTikTokVideo } from "./tiktok";
import { extractAudio, transcribeAudio } from "./transcribe";
import { analyzeVideo } from "./analyze";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A lot of what shows up as a permanent "error" card (especially in bulk
// trend imports pulling dozens of videos at once) is actually a transient
// hiccup — a brief network blip, TikTok momentarily rate-limiting a burst of
// near-simultaneous fetches, a Whisper subprocess that stumbled once. Retrying
// the whole fetch+transcribe attempt a couple of times with a short backoff
// self-heals most of those without any user action, instead of immediately
// surfacing a dead "Analysis failed" tile. A genuinely permanent failure
// (video deleted/private, malformed URL) just fails the same way three times
// and still ends up status:"error" — this only changes the timing, not the
// eventual outcome, for the ones that were never going to work.
const MAX_ATTEMPTS = 3;

/**
 * Fetches the video + metadata and transcribes it, but stops short of the
 * AI breakdown step (leaves analysis: null). Status ends at "done" either
 * way — "done" means "video + transcript are ready"; whether `analysis` is
 * populated tells the UI whether the AI breakdown has actually run yet.
 * Used for bulk trend-analysis imports, where we don't want to burn an LLM
 * call on all 40 videos immediately — the breakdown runs on demand per
 * video instead, via runAIBreakdown().
 */
export async function fetchAndTranscribe(id: string, url: string): Promise<void> {
  const mediaDir = getMediaDir();
  let lastErr: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      updateVideoRecord(id, { status: "fetching" });
      const fetched = await fetchTikTokVideo(url, mediaDir, id);

      updateVideoRecord(id, {
        status: "transcribing",
        webpage_url: fetched.webpage_url,
        title: fetched.title,
        description: fetched.description,
        author: fetched.author,
        author_id: fetched.author_id,
        duration_sec: fetched.duration_sec,
        stats: fetched.stats,
        hashtags: fetched.hashtags,
        video_path: fetched.video_path,
        thumbnail_path: fetched.thumbnail_path,
      });

      let transcriptText = "";
      let segments: any[] = [];
      if (fetched.video_path && fs.existsSync(fetched.video_path)) {
        const audioPath = path.join(mediaDir, `${id}.mp3`);
        await extractAudio(fetched.video_path, audioPath);
        const transcript = await transcribeAudio(audioPath);
        transcriptText = transcript.text;
        segments = transcript.segments;
      }

      updateVideoRecord(id, {
        status: "done",
        transcript_text: transcriptText,
        transcript_segments: segments,
      });
      return;
    } catch (err: any) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2000 * attempt); // 2s, then 4s
        continue;
      }
    }
  }

  updateVideoRecord(id, { status: "error", error_message: String(lastErr?.message || lastErr) });
}

/**
 * Runs just the AI breakdown step against a video record that already has a
 * transcript (from fetchAndTranscribe). Safe to call on demand — e.g. from
 * a "Run breakdown" button on the video detail page.
 */
export async function runAIBreakdown(id: string): Promise<void> {
  const video = getVideo(id);
  if (!video) throw new Error("video not found");
  try {
    updateVideoRecord(id, { status: "analyzing" });
    const analysis = await analyzeVideo({
      title: video.title,
      description: video.description,
      author: video.author,
      hashtags: video.hashtags,
      stats: video.stats,
      duration_sec: video.duration_sec,
      transcript_segments: video.transcript_segments,
    });
    updateVideoRecord(id, { status: "done", analysis });
  } catch (err: any) {
    updateVideoRecord(id, { status: "error", error_message: String(err?.message || err) });
  }
}

/**
 * Full fetch -> transcribe -> AI-breakdown pipeline, used by the main
 * "paste a link" flow where analyzing immediately is the whole point.
 */
export async function runAnalysisPipeline(id: string, url: string): Promise<void> {
  await fetchAndTranscribe(id, url);
  const video = getVideo(id);
  if (video && video.status === "done") {
    await runAIBreakdown(id);
  }
}
