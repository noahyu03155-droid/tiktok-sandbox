import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { startFullCatalogRefresh, getFullRefreshStatus, ensureFullRefreshScheduler } from "@/lib/fastmossFullRefresh";

export const dynamic = "force-dynamic";

// Boots the scheduler (setTimeout/setInterval that periodically checks
// whether TREND_REFRESH_INTERVAL_MS has elapsed and kicks off a refresh) the
// first time this route module is loaded into the running server process.
// Previously this lived in src/instrumentation.ts's register() hook, but
// that hook is bundled by webpack for BOTH the Node.js and Edge runtimes —
// and this module's dependency chain pulls in db.ts, which uses fs/path/
// crypto (Node-only). Even with a `NEXT_RUNTIME !== "nodejs"` guard around
// the dynamic import, webpack still needed to resolve that import target for
// the Edge bundle at build time, which broke `next build` outright (every
// deploy since had been failing — see git history). ensureFullRefreshScheduler
// is idempotent (guarded by its own module-level flag), so calling it here
// at module scope — reached only via a normal Node-runtime API route, never
// analyzed for Edge — is safe and avoids instrumentation.ts entirely. Also
// called from personalized/route.ts and trends/route.ts so the scheduler
// boots on the very first hit to any trends endpoint after a deploy.
ensureFullRefreshScheduler();

// Status is visible to any signed-in member (same "everyone can see, only
// admin can trigger" convention as the category-scan status line already on
// the Trend Analysis page) — lets any member see when the shared video
// library was last refreshed.
export async function GET() {
  return NextResponse.json({ status: getFullRefreshStatus() });
}

// Manual early trigger — the scheduler (src/lib/fastmossFullRefresh.ts,
// booted via ensureFullRefreshScheduler() above) already runs this
// automatically every TREND_REFRESH_INTERVAL_MS, so this is just an admin
// override for "don't want to wait for the next scheduled run." Same
// real-FastMoss-credits admin-only gating as the category scan's own
// trigger route.
export async function POST() {
  const user = getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can trigger a full refresh" }, { status: 403 });
  }
  const started = startFullCatalogRefresh();
  return NextResponse.json({ started, status: getFullRefreshStatus() });
}
