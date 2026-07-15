import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo } from "@/lib/db";
import { fetchTikTokVideo } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

// "Paste a TikTok link" on the storyboard canvas — downloads the linked
// video via the same yt-dlp fetcher the analysis pipeline uses, saved to
// data/media/storyboard/<scriptId>/<nodeId>-tiktok.mp4 and served back
// through the existing catch-all /api/media/[...path] route — same storage
// convention as the sibling upload route, so it's already covered by the
// app's Docker volume + .gitignore.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const nodeId = body?.nodeId;
  if (!url || !/tiktok\.com/.test(url)) {
    return NextResponse.json({ error: "Please provide a valid TikTok video link" }, { status: 400 });
  }
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }

  const dir = path.join(getMediaDir(), "storyboard", params.scriptId);
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
    return NextResponse.json({ url: `/api/media/storyboard/${params.scriptId}/${filename}`, kind: "video" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to import the TikTok video" }, { status: 500 });
  }
}
