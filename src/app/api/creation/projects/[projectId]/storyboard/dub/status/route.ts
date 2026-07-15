import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { getMediaDir, updateCreationProject } from "@/lib/db";

export const dynamic = "force-dynamic";

// Same polling/download logic as the Video Analysis storyboard's
// dub/status route, keyed by projectId.
export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const syncKey = process.env.SYNC_API_KEY;
  if (!syncKey) {
    return NextResponse.json({ error: "SYNC_API_KEY isn't set." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const nodeId = body?.nodeId;
  if (typeof nodeId !== "string" || !nodeId) {
    return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
  }

  const board = access.project.storyboard;
  const nodeIdx = board?.nodes.findIndex((n) => n.id === nodeId) ?? -1;
  if (!board || nodeIdx === -1) {
    return NextResponse.json({ error: "shot not found" }, { status: 404 });
  }
  const node = board.nodes[nodeIdx];
  const jobId = node.dub?.jobId;
  if (!jobId) {
    return NextResponse.json({ error: "No dub job is running for this shot." }, { status: 400 });
  }
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
      const dir = path.join(getMediaDir(), "storyboard", params.projectId);
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${nodeId}-dubbed.mp4`;
      fs.writeFileSync(path.join(dir, filename), Buffer.from(arrBuf));
      const url = `/api/media/storyboard/${params.projectId}/${filename}`;

      const newNodes = board.nodes.map((n, i) =>
        i === nodeIdx ? { ...n, dub: { status: "done" as const, jobId, url } } : n
      );
      updateCreationProject(params.projectId, { storyboard: { ...board, nodes: newNodes } });

      return NextResponse.json({ status: "done", url });
    }

    if (status === "FAILED" || status === "REJECTED") {
      const errMsg = json?.error || `Sync.so generation ${status.toLowerCase()}`;
      const newNodes = board.nodes.map((n, i) =>
        i === nodeIdx ? { ...n, dub: { status: "error" as const, jobId, error: errMsg } } : n
      );
      updateCreationProject(params.projectId, { storyboard: { ...board, nodes: newNodes } });

      return NextResponse.json({ status: "error", error: errMsg });
    }

    return NextResponse.json({ status: "generating" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Status check failed" }, { status: 500 });
  }
}
