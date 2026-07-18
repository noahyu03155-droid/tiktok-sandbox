import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { startFullCatalogRefresh, getFullRefreshStatus } from "@/lib/fastmossFullRefresh";

export const dynamic = "force-dynamic";

// Status is visible to any signed-in member (same "everyone can see, only
// admin can trigger" convention as the category-scan status line already on
// the Trend Analysis page) — lets any member see when the shared video
// library was last refreshed.
export async function GET() {
  return NextResponse.json({ status: getFullRefreshStatus() });
}

// Manual early trigger — the scheduler (src/lib/fastmossFullRefresh.ts,
// wired up in src/instrumentation.ts) already runs this automatically every
// TREND_REFRESH_INTERVAL_MS, so this is just an admin override for "don't
// want to wait for the next scheduled run." Same real-FastMoss-credits
// admin-only gating as the category scan's own trigger route.
export async function POST() {
  const user = getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can trigger a full refresh" }, { status: 403 });
  }
  const started = startFullCatalogRefresh();
  return NextResponse.json({ started, status: getFullRefreshStatus() });
}
