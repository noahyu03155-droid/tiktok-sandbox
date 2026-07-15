import { NextRequest, NextResponse } from "next/server";
import { deleteTrackedCreator, getTrackedCreator, updateTrackedCreator } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ creator });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const patch: { tags?: string[] } = {};
  if (Array.isArray(body.tags)) patch.tags = body.tags.map((t: any) => String(t)).filter(Boolean);
  updateTrackedCreator(params.id, patch);
  return NextResponse.json({ creator: getTrackedCreator(params.id) });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  deleteTrackedCreator(params.id);
  return NextResponse.json({ ok: true });
}
