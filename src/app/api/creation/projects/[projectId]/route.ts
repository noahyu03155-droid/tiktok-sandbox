import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireProjectAccess } from "@/lib/creationAuth";
import { deleteCreationProject, getMediaDir, updateCreationProject } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  return NextResponse.json({ project: access.project });
}

// Renames a project / attaches or clears the linked Shopify product. Not
// used for the storyboard itself — that's PUT on .../storyboard.
export async function PATCH(req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body?.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if ("shopifyProductId" in (body || {})) patch.shopifyProductId = body.shopifyProductId || null;
  if ("shopifyProductTitle" in (body || {})) patch.shopifyProductTitle = body.shopifyProductTitle || null;

  updateCreationProject(params.projectId, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { projectId: string } }) {
  const access = requireProjectAccess(params.projectId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  // Best-effort cleanup of any uploaded clips/renders this project made —
  // same media dir convention as the storyboard sub-routes
  // (data/media/storyboard/<projectId>/...).
  const dir = path.join(getMediaDir(), "storyboard", params.projectId);
  fs.rmSync(dir, { recursive: true, force: true });

  deleteCreationProject(params.projectId);
  return NextResponse.json({ ok: true });
}
