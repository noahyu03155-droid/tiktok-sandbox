import { NextRequest, NextResponse } from "next/server";
import { getTrackedCreator } from "@/lib/db";
import { importCreatorScan } from "@/lib/creatorPipeline";

export const dynamic = "force-dynamic";

// Ingests a batch of a creator's videos scraped live from FastMoss (see the
// creator-tracker-rescan scheduled task / SKILL.md for the actual scrape
// procedure — this endpoint just does the merge-and-persist half, mirroring
// how POST /api/trends works for Trend Analysis).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.videos)) {
    return NextResponse.json({ error: "Body must include videos[]" }, { status: 400 });
  }

  try {
    const result = importCreatorScan(params.id, {
      name: body.name ?? null,
      avatar_url: body.avatar_url ?? null,
      followers: typeof body.followers === "number" ? body.followers : null,
      videos: body.videos,
    });
    return NextResponse.json({ creator: getTrackedCreator(params.id), ...result });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
