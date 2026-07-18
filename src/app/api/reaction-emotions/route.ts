import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById } from "@/lib/db";
import { REACTION_EMOTIONS } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET: the full REACTION_EMOTIONS list plus this member's own usage counts
// (see User.reactionEmotionUsage in types.ts) — the client
// (StoryboardCanvas.tsx's reaction-emotion picker, shown before Generate
// Product Script / Generate Shoppable Script) sorts the list by usage
// descending so whichever emotions this member reaches for most float to
// the top over time, ties broken by the fixed REACTION_EMOTIONS order.
// Read-only; usage counts are only ever incremented server-side by the
// script-generation routes themselves right after a successful generation
// — see incrementReactionEmotionUsage in db.ts — so there's no POST here.
export async function GET() {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  return NextResponse.json({
    emotions: REACTION_EMOTIONS,
    usage: user?.reactionEmotionUsage || {},
  });
}
