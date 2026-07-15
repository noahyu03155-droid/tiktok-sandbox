import { NextRequest, NextResponse } from "next/server";
import { getTrackedCreator, updateTrackedCreator } from "@/lib/db";

export const dynamic = "force-dynamic";

// FastMoss requires an authenticated browser session, so this can't
// actually re-scrape on its own — it just flags the creator as queued so
// the UI can show "queued for update" and point the user at asking Claude
// to run it live (same constraint as Trend Analysis's Update button). The
// real work happens via a live chat session (or the scheduled reminder)
// that ends by POSTing to /api/creators/[id]/import.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return NextResponse.json({ error: "not found" }, { status: 404 });
  updateTrackedCreator(params.id, { status: "pending", error_message: null });
  return NextResponse.json({ creator: getTrackedCreator(params.id) });
}
