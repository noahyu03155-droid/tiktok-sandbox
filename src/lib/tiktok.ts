import { spawn } from "child_process";
import path from "path";

export interface FetchResult {
  id: string;
  source_url: string;
  webpage_url: string | null;
  title: string;
  description: string;
  author: string;
  author_id: string;
  create_timestamp: number | null;
  duration_sec: number | null;
  stats: {
    play_count: number | null;
    digg_count: number | null;
    comment_count: number | null;
    share_count: number | null;
  };
  hashtags: string[];
  video_path: string | null;
  thumbnail_path: string | null;
  error?: string;
}

/**
 * Downloads a TikTok video + metadata via the yt-dlp Python script.
 * Requires: pip3 install -r scripts/requirements.txt
 */
export function fetchTikTokVideo(url: string, outDir: string, recordId: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), "scripts", "fetch_tiktok.py");
    const py = spawn("python3", [scriptPath, url, outDir, recordId]);

    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));

    py.on("close", (code) => {
      if (!stdout.trim()) {
        reject(new Error(stderr || `fetch_tiktok.py exited with code ${code} and no output`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() as string);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Failed to parse fetch_tiktok.py output: ${stdout}\n${stderr}`));
      }
    });
  });
}
