import { NextRequest, NextResponse } from "next/server";
import { getVideo, updateVideoRecord } from "@/lib/db";
import type { StoryboardState } from "@/lib/types";

export const dynamic = "force-dynamic";

// Saves the "Generate Video" storyboard canvas state (node positions,
// point-to-point connections, attached clips, overall direction text) for
// one generated script. Mirrors /api/videos/[id]/canvas/route.ts's PUT
// pattern — plain getVideo + updateVideoRecord, no dedicated db.ts helper,
// same as the script refine/select-version routes.
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as StoryboardState | null;
  if (!body || typeof body !== "object" || !Array.isArray(body.nodes) || !Array.isArray(body.connections)) {
    return NextResponse.json({ error: "invalid storyboard payload" }, { status: 400 });
  }

  const scriptIdx = video.generated_scripts.findIndex((s) => s.id === params.scriptId);
  if (scriptIdx === -1) return NextResponse.json({ error: "script not found" }, { status: 404 });

  const newScripts = video.generated_scripts.map((s, i) => (i === scriptIdx ? { ...s, storyboard: body } : s));
  updateVideoRecord(params.id, { generated_scripts: newScripts });

  return NextResponse.json({ ok: true });
}
