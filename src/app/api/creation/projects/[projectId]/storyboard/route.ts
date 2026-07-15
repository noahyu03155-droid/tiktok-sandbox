import { NextRequest, NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/creationAuth";
import { updateCreationProject } from "@/lib/db";
import type { StoryboardState } from "@/lib/types";

export const dynamic = "force-dynamic";

// Saves the Creation canvas state (node positions, connections, attached
// clips, direction text, style profile). Mirrors
// /api/videos/[id]/generate-script/[scriptId]/storyboard/route.ts's PUT
// pattern exactly, just against a standalone CreationProject instead of a
// GeneratedScript nested under a video.
export async function PUT(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = (await req.json().catch(() => null)) as StoryboardState | null;
  if (!body || typeof body !== "object" || !Array.isArray(body.nodes) || !Array.isArray(body.connections)) {
    return NextResponse.json({ error: "invalid storyboard payload" }, { status: 400 });
  }

  updateCreationProject(params.projectId, { storyboard: body });
  return NextResponse.json({ ok: true });
}
