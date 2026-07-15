import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { createTrackedCreator, deleteTrackedCreator, findCreatorByHandle, listTrackedCreators } from "@/lib/db";

export const dynamic = "force-dynamic";

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

function parseHandle(input: string): { handle: string; profileUrl: string } | null {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/tiktok\.com\/@([\w.\-]+)/i);
  const handle = (urlMatch ? urlMatch[1] : trimmed.replace(/^@/, "")).trim();
  if (!handle) return null;
  return { handle, profileUrl: `https://www.tiktok.com/@${handle}` };
}

export async function GET() {
  const creators = listTrackedCreators();
  const nowSec = Date.now() / 1000;
  const enriched = creators.map((c) => {
    const recent = c.videos.filter((v) => v.create_timestamp && nowSec - v.create_timestamp <= SEVEN_DAYS_SEC);
    const uniqueProducts7d = new Set(recent.map((v) => v.product_name).filter(Boolean));
    return {
      ...c,
      // Lightweight badges for the list-card view — the full video array is
      // still included (list is capped in practice by what a scan pulls),
      // but the card itself only needs these three numbers.
      videos_7d: recent.length,
      products_7d: uniqueProducts7d.size,
      archived_count: c.videos.length,
    };
  });
  return NextResponse.json({ creators: enriched });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = parseHandle(String(body.handle || body.url || ""));
  if (!parsed) {
    return NextResponse.json({ error: "Provide a TikTok @handle or profile link" }, { status: 400 });
  }

  const existing = findCreatorByHandle(parsed.handle);
  if (existing) {
    return NextResponse.json({ creator: existing, alreadyTracked: true });
  }

  const id = uuidv4();
  createTrackedCreator(id, parsed.handle, parsed.profileUrl);

  return NextResponse.json({ creator: { id, handle: parsed.handle, profile_url: parsed.profileUrl } });
}

// Bulk delete — used by the Creator Tracker list's select-and-delete mode.
// Body: { ids: string[] }
export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "Body must include ids[]" }, { status: 400 });
  }
  for (const id of ids) {
    deleteTrackedCreator(id);
  }
  return NextResponse.json({ ok: true, deleted: ids.length });
}
