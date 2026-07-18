import { NextRequest, NextResponse } from "next/server";
import { getVideo, listLatestTrendBatchPerCategory } from "@/lib/db";
import type { TrendItem } from "@/lib/types";

export const dynamic = "force-dynamic";

function numericSales(item: TrendItem): number {
  if (typeof item.sales === "number") return item.sales;
  if (typeof item.sales === "string") {
    const n = Number(item.sales.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// Powers the "Trending Now — All Categories" section at the top of the
// Trend Analysis page: instead of showing each FastMoss category's pull as
// its own separate section (the existing per-batch list further down still
// does that), this merges every category's most recent Top-by-Sales list
// into ONE feed sorted by sales across the whole catalog — the "全类目，
// 销售最高的视频开始排序" view. Sourced from whatever's already been
// ingested (the scheduled full-catalog refresh in
// src/lib/fastmossFullRefresh.ts keeps this populated across every
// confirmed-valid category on a fixed cadence; any admin manual "Update"
// pull also feeds in here), so this route itself never hits FastMoss live —
// it's a pure read over already-stored batches.
export async function GET(req: NextRequest) {
  const limitRaw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 40;

  const latestPerCategory = listLatestTrendBatchPerCategory();
  const byVideoKey = new Map<string, { item: TrendItem; video: ReturnType<typeof getVideo> }>();
  for (const batch of latestPerCategory) {
    // Each category's stored top_by_sales is already a buffer past what any
    // single category displays (TREND_FETCH_LIMIT candidates vs.
    // TREND_DISPLAY_LIMIT shown) — a video that permanently failed to
    // fetch/transcribe is skipped here rather than merged in, so a
    // lower-ranked-but-usable item (from this category or another) fills
    // the slot instead. Same "Analysis failed" tile avoidance as
    // enrichAndBackfillTop in trends.ts, just applied across categories
    // instead of within one.
    for (const item of batch.top_by_sales) {
      const key = item.video_id || item.fastmoss_url;
      if (!key) continue;
      const video = item.video_id ? getVideo(item.video_id) : null;
      if (video && video.status === "error") continue;
      const existing = byVideoKey.get(key);
      if (!existing || numericSales(item) > numericSales(existing.item)) {
        byVideoKey.set(key, { item, video });
      }
    }
  }

  const merged = Array.from(byVideoKey.values())
    .sort((a, b) => numericSales(b.item) - numericSales(a.item))
    .slice(0, limit)
    .map(({ item, video }, index) => ({
      ...item,
      // Re-rank within the merged/sorted feed — the original per-category
      // rank (#1-#20 within that one category) isn't meaningful once
      // multiple categories are pooled together.
      rank: index + 1,
      video,
    }));

  return NextResponse.json({ items: merged, categoriesCount: latestPerCategory.length });
}
