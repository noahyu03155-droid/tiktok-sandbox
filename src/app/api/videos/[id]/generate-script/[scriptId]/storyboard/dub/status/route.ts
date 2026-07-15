import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getMediaDir, getVideo, updateVideoRecord } from "@/lib/db";

export const dynamic = "force-dynamic";

// "AI dub (lip-sync)" — step 2 of 2. Polls a Sync.so generation job started
// by storyboard/dub/start/route.ts. On completion, downloads the result
// into this app's own media dir (same reasoning as everything else under
// data/media/ — Railway's volume is the only storage that survives a
// redeploy, an external sync.so URL is not guaranteed to stay valid) and
// saves the local URL onto the node so the render route can pick it up.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const syncKey = process.env.SYNC_API_KEY;
  if (!syncKey) {
    return NextResponse.json({ error: "SYNC_API_KEY isn't set." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const nodeId = body?.nodeId;
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }

  const scriptIdx = video.generated_scripts.findIndex((s) => s.id === params.scriptId);
  if (scriptIdx === -1) return NextResponse.json({ error: "script not found" }, { status: 404 });
  const script = video.generated_scripts[scriptIdx];
  const board = script.storyboard;
  const nodeIdx = board?.nodes.findIndex((n) => n.id === nodeId) ?? -1;
  if (!board || nodeIdx === -1) {
    return NextResponse.json({ error: "shot not found" }, { status: 404 });
  }
  const node = board.nodes[nodeIdx];
  const jobId = node.dub?.jobId;
  if (!jobId) {
    return NextResponse.json({ error: "No dub job is running for this shot." }, { status: 400 });
  }
  // Already resolved from a previous poll — don't hit Sync.so again.
  if (node.dub?.status === "done" || node.dub?.status === "error") {
    return NextResponse.json({ status: node.dub.status, url: node.dub.url, error: node.dub.error });
  }

  try {
    const res = await fetch(`https://api.sync.so/v2/generate/${jobId}`, {
      headers: { "x-api-key": syncKey },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.message || json?.error || `Sync.so status check failed (${res.status})`);
    }
    const status = json?.status;

    if (status === "COMPLETED" && json?.outputUrl) {
      const videoRes = await fetch(json.outputUrl);
      if (!videoRes.ok) throw new Error(`Failed to download the dubbed video (${videoRes.status})`);
      const arrBuf = await videoRes.arrayBuffer();
      const dir = path.join(getMediaDir(), "storyboard", params.scriptId);
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${nodeId}-dubbed.mp4`;
      fs.writeFileSync(path.join(dir, filename), Buffer.from(arrBuf));
      const url = `/api/media/storyboard/${params.scriptId}/${filename}`;

      const newNodes = board.nodes.map((n, i) =>
        i === nodeIdx ? { ...n, dub: { status: "done" as const, jobId, url } } : n
      );
      const newScripts = video.generated_scripts.map((s, i) =>
        i === scriptIdx ? { ...s, storyboard: { ...board, nodes: newNodes } } : s
      );
      updateVideoRecord(params.id, { generated_scripts: newScripts });

      return NextResponse.json({ status: "done", url });
    }

    if (status === "FAILED" || status === "REJECTED") {
      const errMsg = json?.error || `Sync.so generation ${status.toLowerCase()}`;
      const newNodes = board.nodes.map((n, i) =>
        i === nodeIdx ? { ...n, dub: { status: "error" as const, jobId, error: errMsg } } : n
      );
      const newScripts = video.generated_scripts.map((s, i) =>
        i === scriptIdx ? { ...s, storyboard: { ...board, nodes: newNodes } } : s
      );
      updateVideoRecord(params.id, { generated_scripts: newScripts });

      return NextResponse.json({ status: "error", error: errMsg });
    }

    // Still PENDING/PROCESSING — nothing to persist, just tell the client
    // to keep polling.
    return NextResponse.json({ status: "generating" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Status check failed" }, { status: 500 });
  }
}
