import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { getVideo, getMediaDir, updateCreationProject } from "@/lib/db";
import { requireProjectAccess } from "@/lib/creationAuth";
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
// "paste a TikTok link" feature uses, and drops it as a new card into a
// canvas project the user explicitly picked via ProjectPickerModal (see
// StoryboardCanvas.tsx's sibling picker on AnalysisTabs.tsx). Used to
// silently pick getOrCreateDefaultCreationProject — whichever project was
// most recently updated, or a brand-new "My Canvas" — which meant a member
// with more than one project could never tell (or control) where an import
// landed. requireProjectAccess both confirms projectId belongs to this
// user (or an admin) and 404s cleanly if it doesn't exist.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const videoRecordId = typeof body?.videoRecordId === "string" ? body.videoRecordId : "";
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  if (!videoRecordId) {
    return NextResponse.json({ error: "videoRecordId is required" }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const access = requireProjectAccess(projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const video = getVideo(videoRecordId);
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.source_url || !/tiktok\.com/.test(video.source_url)) {
    return NextResponse.json({ error: "This video doesn't have a usable TikTok link to import." }, { status: 400 });
  }

  const project = access.project;
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
