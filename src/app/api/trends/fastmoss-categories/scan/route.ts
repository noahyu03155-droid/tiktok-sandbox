import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { startCategoryScan, getCategoryScanStatus } from "@/lib/fastmossCategoryScan";

export const dynamic = "force-dynamic";

// Kicks off a full FastMoss category-tree scan in the background (see
// fastmossCategoryScan.ts for why this can't just run inline — hundreds of
// paid API calls, minutes of wall-clock time). Admin-only: this burns real
// FastMoss credits and only needs to run occasionally, not something every
// member account should be able to trigger freely.
export async function POST() {
  const user = getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可以触发类目扫描" }, { status: 403 });
  }
  if (!process.env.FASTMOSS_API_KEY) {
    return NextResponse.json({ error: "FASTMOSS_API_KEY isn't set — see README." }, { status: 400 });
  }
  const started = startCategoryScan();
  return NextResponse.json({ started, status: getCategoryScanStatus() });
}

export async function GET() {
  return NextResponse.json({ status: getCategoryScanStatus() });
}
