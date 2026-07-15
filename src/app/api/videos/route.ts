import { NextRequest, NextResponse } from "next/server";
import { deleteVideoRecord, listVideos } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const videos = listVideos();
  return NextResponse.json({ videos });
}

// Bulk delete — used by the Video Analysis board's select-and-delete mode.
// Body: { ids: string[] }
export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "Body must include ids[]" }, { status: 400 });
  }
  for (const id of ids) {
    deleteVideoRecord(id);
  }
  return NextResponse.json({ ok: true, deleted: ids.length });
}
