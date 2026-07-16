import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { updateUser } from "@/lib/db";
import type { CreatorProfile } from "@/lib/types";

export const dynamic = "force-dynamic";

// Saves the short 5-question creator profile shown right after
// registration (see /onboarding/page.tsx) onto the current account. Every
// field is optional — the form can be partially filled or skipped
// entirely. This data is later read by the two script-generation routes
// (src/app/api/videos/[id]/generate-script/route.ts and
// .../storyboard/generate-product-script/route.ts) and threaded into
// src/lib/scriptgen.ts's prompt so scripts are tailored to this creator.
function cleanStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const profile: CreatorProfile = {
    ageRange: cleanStr(body.ageRange),
    occupation: cleanStr(body.occupation),
    interests: cleanStr(body.interests),
    experienceLevel: cleanStr(body.experienceLevel),
    contentStyle: cleanStr(body.contentStyle),
    completedAt: new Date().toISOString(),
  };

  updateUser(user.userId, { creatorProfile: profile });
  return NextResponse.json({ ok: true, profile });
}
