import { NextRequest, NextResponse } from "next/server";
import { getVideo } from "@/lib/db";
import { runAIBreakdown } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

// Triggers the AI breakdown step on demand for a video that's already been
// fetched + transcribed (used by the "Run breakdown" button — mainly for
// trend-analysis videos, which are imported in bulk without an automatic
// breakdown to avoid burning an LLM call on all of them up front).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  // A stuck status:"analyzing" (e.g. the dev server restarted mid-request,
  // or an old build without the Claude-call timeout hung indefinitely)
  // otherwise can never be retried — this route used to reject anything
  // that wasn't already "done"/"error". ?force=1 (used by the UI's "stuck?
  // retry" link) lets a user manually break out of that deadlock.
  const force = req.nextUrl.searchParams.get("force") === "1";
  const retryableStuck = force && video.status === "analyzing";
  if (video.status !== "done" && video.status !== "error" && !retryableStuck) {
    return NextResponse.json({ error: "video isn't ready yet (still fetching/transcribing)" }, { status: 409 });
  }
  if (!video.transcript_segments || video.transcript_segments.length === 0) {
    return NextResponse.json({ error: "no transcript available to analyze" }, { status: 400 });
  }

  runAIBreakdown(params.id); // fire and forget, client polls for status

  return NextResponse.json({ ok: true });
}
