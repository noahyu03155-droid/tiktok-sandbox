import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import type { TranscriptSegment } from "./types";

const TRANSCRIBE_PROVIDER = process.env.TRANSCRIBE_PROVIDER || "openai"; // "openai" | "local"

/** Extracts a mono 16kHz mp3 audio track from a video file using ffmpeg. */
export function extractAudio(videoPath: string, audioOutPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      audioOutPath,
    ]);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("close", (code) => {
      if (code === 0 && fs.existsSync(audioOutPath)) resolve(audioOutPath);
      else reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-800)}`));
    });
  });
}

async function transcribeWithOpenAI(audioPath: string): Promise<{ text: string; segments: TranscriptSegment[]; language?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (required when TRANSCRIBE_PROVIDER=openai)");
  const client = new OpenAI({ apiKey });

  const resp = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  } as any);

  const anyResp = resp as any;
  const segments: TranscriptSegment[] = (anyResp.segments || []).map((s: any) => ({
    start: Math.round(s.start * 100) / 100,
    end: Math.round(s.end * 100) / 100,
    text: (s.text || "").trim(),
  }));

  return { text: anyResp.text || "", segments, language: anyResp.language };
}

function transcribeLocal(audioPath: string): Promise<{ text: string; segments: TranscriptSegment[]; language?: string }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), "scripts", "transcribe_local.py");
    const py = spawn("python3", [scriptPath, audioPath]);
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));
    py.on("close", () => {
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() as string);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      } catch {
        reject(new Error(`Failed to parse transcribe_local.py output: ${stdout}\n${stderr}`));
      }
    });
  });
}

/** Transcribes an audio file into full text + timestamped segments. */
export async function transcribeAudio(audioPath: string) {
  if (TRANSCRIBE_PROVIDER === "local") {
    return transcribeLocal(audioPath);
  }
  return transcribeWithOpenAI(audioPath);
}
