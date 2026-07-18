// Scheduled full-catalog trend refresh: every TREND_REFRESH_INTERVAL_MS (see
// trends.ts, currently 3 days), walks every FastMoss category already
// confirmed to have data (fastmossCategoryValidity.validIds — the same list
// the category-tree scan in fastmossCategoryScan.ts produces) and pulls
// Top 20 by views + Top 20 by sales for each, via the same ingestTrendBatch
// path the manual "Update" button and the personalized "For You" section
// already use. That means:
//   - every category's video library gets pre-fetched/transcribed/analyzed
//     in the background, so a member visiting the Trend Analysis page never
//     has to sit and watch "Fetching video…"/"Queued" statuses themselves —
//     see the doc comment on TREND_REFRESH_INTERVAL_MS for how this pairs
//     with /api/trends/personalized's own freshness check.
//   - the aggregated "All Categories" feed (/api/trends/top-videos-all) has
//     a broad, constantly-refreshed pool of videos to draw from instead of
//     only whatever categories an admin happened to click "Update" on.
//
// Runs as an in-process background job (same fire-and-forget + polled-status
// pattern as fastmossCategoryScan.ts) rather than blocking any HTTP request
// — this can take many minutes across dozens of categories. Started
// automatically on server boot (see src/instrumentation.ts) and re-checked
// hourly; only actually kicks off a run once TREND_REFRESH_INTERVAL_MS has
// elapsed since the last completed run (persisted in db.json so the
// schedule survives a restart/redeploy, not just kept in memory).

import {
  fetchFastMossCategories,
  fetchCategoryTrendVideos,
  buildFastmossVideoUrl,
  formatUsd,
  toCreatorInfo,
} from "./fastmoss";
import type { FastMossVideoResult } from "./fastmoss";
import { ingestTrendBatch, TREND_FETCH_LIMIT, TREND_REFRESH_INTERVAL_MS, type RawTrendItem } from "./trends";
import { getFastmossCategoryValidity, getLastTrendFullRefresh, setLastTrendFullRefresh } from "./db";

interface CategoryNode {
  c_code: string;
  c_name: string;
  sub?: CategoryNode[];
}

export type FullRefreshStatus = {
  status: "idle" | "running" | "done" | "error";
  total: number;
  processed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

let runState: FullRefreshStatus = {
  status: "idle",
  total: 0,
  processed: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

// Merges the in-memory state of a run that's happened since this server
// process booted with the persisted "last completed run" (which survives
// restarts) — so the status panel still shows something meaningful right
// after a redeploy, before the next run has happened in this process.
export function getFullRefreshStatus(): FullRefreshStatus & { lastPersistedRun: ReturnType<typeof getLastTrendFullRefresh> } {
  return { ...runState, lastPersistedRun: getLastTrendFullRefresh() };
}

function flattenTree(nodes: CategoryNode[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  function walk(list: CategoryNode[]) {
    for (const n of list) {
      if (!seen.has(n.c_code)) {
        seen.add(n.c_code);
        out.push({ id: n.c_code, name: n.c_name });
      }
      if (n.sub && n.sub.length > 0) walk(n.sub);
    }
  }
  walk(nodes);
  return out;
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("code 30002") || msg.includes("code 30003");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRawItem(v: FastMossVideoResult, index: number): RawTrendItem {
  return {
    rank: index + 1,
    fastmoss_url: buildFastmossVideoUrl(v.video_id),
    video_url: v.video_url || undefined,
    fastmoss_title: v.desc || undefined,
    product_name: v.product_info?.[0]?.title || undefined,
    product_id: v.product_info?.[0]?.product_id || undefined,
    product_image: v.product_info?.[0]?.cover || undefined,
    product_price: v.product_info?.[0]?.price || undefined,
    views: v.play_count ?? undefined,
    likes: v.digg_count ?? undefined,
    comments: v.comment_count ?? undefined,
    gmv: formatUsd(v.gmv) || undefined,
    sales: v.units_sold ?? undefined,
    creator: toCreatorInfo(v.creator),
  };
}

const REGION = process.env.FASTMOSS_REGION || "US";
const DAYS = 7;
// Deliberately more conservative than the category-scan job's CONCURRENCY=3
// — each unit of work here is heavier (2 FastMoss calls, then potentially
// queueing up to 40 new videos for full fetch/transcribe/AI-breakdown),
// not one cheap probe call.
const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const INTER_CATEGORY_DELAY_MS = 500;

async function pullCategoryWithRetry(id: string, name: string): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const now = new Date();
      const from = new Date(now.getTime() - DAYS * 86400 * 1000);
      const [byViews, bySales] = await Promise.all([
        fetchCategoryTrendVideos("play_count", { days: DAYS, region: REGION, limit: TREND_FETCH_LIMIT, categoryId: Number(id) }),
        fetchCategoryTrendVideos("units_sold", { days: DAYS, region: REGION, limit: TREND_FETCH_LIMIT, categoryId: Number(id) }),
      ]);
      if (byViews.length === 0 && bySales.length === 0) return true; // nothing this window, not an error
      ingestTrendBatch({
        category: name,
        category_id: id,
        date_from: from.toISOString().slice(0, 10),
        date_to: now.toISOString().slice(0, 10),
        days: DAYS,
        top_by_views: byViews.map(toRawItem),
        top_by_sales: bySales.map(toRawItem),
      });
      return true;
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      console.error(`[fastmossFullRefresh] Pull failed for category ${id} (${name}), attempt ${attempt + 1}:`, err);
      return false;
    }
  }
  return false;
}

// Fire-and-forget — returns immediately with true if a run was actually
// started, false if one was already in progress. Poll getFullRefreshStatus()
// for progress.
export function startFullCatalogRefresh(): boolean {
  if (runState.status === "running") return false;
  if (!process.env.FASTMOSS_API_KEY) {
    runState = {
      status: "error",
      total: 0,
      processed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: "FASTMOSS_API_KEY isn't set — see README.",
    };
    return false;
  }

  runState = {
    status: "running",
    total: 0,
    processed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  (async () => {
    try {
      const validity = getFastmossCategoryValidity();
      const validIds = new Set(validity?.validIds || []);
      if (validIds.size === 0) {
        // Nobody's ever run the category-tree scan (or it found nothing) —
        // there's no known-good category list to refresh yet. Surface this
        // clearly rather than silently doing nothing forever; the admin
        // fixes it by running "Re-scan categories" once on the Trend
        // Analysis page.
        runState = {
          ...runState,
          status: "error",
          finishedAt: new Date().toISOString(),
          error: "No confirmed-valid FastMoss categories yet — run 'Re-scan categories' on the Trend Analysis page first.",
        };
        return;
      }

      const raw = (await fetchFastMossCategories()) as CategoryNode[];
      const flat = flattenTree(raw || []).filter((n) => validIds.has(n.id));
      runState.total = flat.length;

      let cursor = 0;
      async function worker() {
        while (cursor < flat.length) {
          const node = flat[cursor++];
          await pullCategoryWithRetry(node.id, node.name);
          runState.processed++;
          await sleep(INTER_CATEGORY_DELAY_MS);
        }
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, flat.length) }, () => worker());
      await Promise.all(workers);

      const finishedAt = new Date().toISOString();
      runState = { ...runState, status: "done", finishedAt };
      setLastTrendFullRefresh({
        finishedAt,
        categoriesProcessed: runState.processed,
        categoriesTotal: runState.total,
        status: "done",
      });
    } catch (err: any) {
      const finishedAt = new Date().toISOString();
      console.error("[fastmossFullRefresh] Full refresh failed:", err);
      runState = { ...runState, status: "error", finishedAt, error: err?.message || "Full refresh failed" };
      setLastTrendFullRefresh({
        finishedAt,
        categoriesProcessed: runState.processed,
        categoriesTotal: runState.total,
        status: "error",
        error: err?.message || "Full refresh failed",
      });
    }
  })();

  return true;
}

// ---- Scheduler: checked hourly, only actually runs once
// TREND_REFRESH_INTERVAL_MS has elapsed since the last COMPLETED run. ----

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let schedulerStarted = false;

function checkAndMaybeStart() {
  const last = getLastTrendFullRefresh();
  const lastAt = last?.finishedAt ? new Date(last.finishedAt).getTime() : 0;
  if (Date.now() - lastAt >= TREND_REFRESH_INTERVAL_MS) {
    startFullCatalogRefresh();
  }
}

// Called once from src/instrumentation.ts when the server process boots.
// Guarded against double-init (e.g. Next.js invoking register() more than
// once) with the module-level schedulerStarted flag.
export function ensureFullRefreshScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // Give the server a little time to finish booting before the first check.
  setTimeout(checkAndMaybeStart, 30_000);
  setInterval(checkAndMaybeStart, CHECK_INTERVAL_MS);
}
