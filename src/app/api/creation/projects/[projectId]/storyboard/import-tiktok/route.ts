import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir } from "@/lib/db";
import { fetchTikTokVideo } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

// "Paste a TikTok link" on the storyboard canvas — same as the Video
// Analysis storyboard's import-tiktok route, just keyed by projectId instead
// of scriptId: downloads the linked video via the shared yt-dlp fetcher to
// data/media/storyboard/<projectId>/<nodeId>-tiktok.mp4, served back through
// the existing /api/media/[...path] catch-all.
export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const nodeId = body?.nodeId;
  if (!url || !/tiktok\.com/.test(url)) {
    return NextResponse.json({ error: "Please provide a valid TikTok video link" }, { status: 400 });
  }
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }

  const dir = path.join(getMediaDir(), "storyboard", params.projectId);
  try {
    const fetched = await fetchTikTokVideo(url, dir, `${nodeId}-tiktok`);
    if (!fetched.video_path) throw new Error("Download succeeded but no video file was produced.");
    const filename = path.basename(fetched.video_path);
    // Sidecar metadata for the "Breakdown into 6 stages" action — the
    // breakdown route needs the fetched title/description/stats to feed
    // analyzeVideo later, and FetchResult is otherwise discarded here.
    fs.writeFileSync(
      path.join(dir, `${nodeId}-tiktok.meta.json`),
      JSON.stringify({
        title: fetched.title,
        description: fetched.description,
        author: fetched.author,
        hashtags: fetched.hashtags,
        stats: fetched.stats,
        duration_sec: fetched.duration_sec,
      })
    );
    return NextResponse.json({ url: `/api/media/storyboard/${params.projectId}/${filename}`, kind: "video" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to import the TikTok video" }, { status: 500 });
  }
}
