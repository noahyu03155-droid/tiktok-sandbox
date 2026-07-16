import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/session";
import { getVideo, getMediaDir, getOrCreateDefaultCreationProject, updateCreationProject } from "@/lib/db";
import { fetchTikTokVideo } from "@/lib/tiktok";
import type { StoryboardState, StoryboardNode } from "@/lib/types";

export const dynamic = "force-dynamic";

// Card layout constants duplicated from StoryboardCanvas.tsx (NODE_W/GAP_X)
// — kept in sync by hand since that file's constants aren't exported. If
// those ever change, update this to match so newly-imported nodes don't
// visually overlap existing ones.
const NODE_W = 300;
const GAP_X = 70;

// "Add to Creation" button on a Trend Analysis video card — downloads that
// specific trending video via the same yt-dlp fetcher the canvas's own
// "paste a TikTok link" feature uses, and drops it straight into the user's
// own single default canvas (auto-created if they don't have one yet) as a
// new card, ready to build off of without leaving Trend Analysis.
export async function POST(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const videoRecordId = typeof body?.videoRecordId === "string" ? body.videoRecordId : "";
  if (!videoRecordId) {
    return NextResponse.json({ error: "videoRecordId is required" }, { status: 400 });
  }

  const video = getVideo(videoRecordId);
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.source_url || !/tiktok\.com/.test(video.source_url)) {
    return NextResponse.json({ error: "This video doesn't have a usable TikTok link to import." }, { status: 400 });
  }

  const project = getOrCreateDefaultCreationProject(user.userId);
  const board: StoryboardState = project.storyboard || {
    nodes: [],
    connections: [],
    direction: "",
    zoom: 1,
    pan: { x: 40, y: 40 },
  };

  const nodeId = crypto.randomUUID();
  const dir = path.join(getMediaDir(), "storyboard", project.id);

  try {
    const fetched = await fetchTikTokVideo(video.source_url, dir, `${nodeId}-tiktok`);
    if (!fetched.video_path) throw new Error("Download succeeded but no video file was produced.");
    const filename = path.basename(fetched.video_path);
    const clipUrl = `/api/media/storyboard/${project.id}/${filename}`;

    const rightmost = board.nodes.reduce((max, n) => Math.max(max, n.x), 0);
    const newNode: StoryboardNode = {
      id: nodeId,
      label: (video.title || "Imported from Trends").slice(0, 60),
      instruction: video.title || "",
      x: board.nodes.length === 0 ? 60 : rightmost + NODE_W + GAP_X,
      y: 120,
      clip: { source: "tiktok", url: clipUrl, kind: "video" },
    };

    const newBoard: StoryboardState = { ...board, nodes: [...board.nodes, newNode] };
    updateCreationProject(project.id, { storyboard: newBoard });

    return NextResponse.json({ projectId: project.id, nodeId });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to import this video" }, { status: 500 });
  }
}
