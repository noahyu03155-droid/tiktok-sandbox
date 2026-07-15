import path from "path";
import fs from "fs";
import { updateVideoRecord, getVideo, getMediaDir } from "./db";
import { fetchTikTokVideo } from "./tiktok";
import { extractAudio, transcribeAudio } from "./transcribe";
import { analyzeVideo } from "./analyze";

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
  } catch (err: any) {
    updateVideoRecord(id, { status: "error", error_message: String(err?.message || err) });
  }
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
