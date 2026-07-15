import { NextRequest, NextResponse } from "next/server";
import { getVideo, updateVideoRecord } from "@/lib/db";
import type { CanvasState } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as CanvasState | null;
  if (!body || typeof body !== "object" || !body.cardPositions || !Array.isArray(body.notes)) {
    return NextResponse.json({ error: "invalid canvas payload" }, { status: 400 });
  }

  updateVideoRecord(params.id, { canvas: body });
  return NextResponse.json({ ok: true });
}
