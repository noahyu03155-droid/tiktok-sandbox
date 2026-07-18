import { NextRequest, NextResponse } from "next/server";
import { buildFastmossVideoUrl, fetchCategoryTrendVideos, formatUsd, toCreatorInfo } from "@/lib/fastmoss";
import type { FastMossVideoResult } from "@/lib/fastmoss";
import { ingestTrendBatch, TREND_FETCH_LIMIT, type RawTrendItem } from "@/lib/trends";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const REGION = process.env.FASTMOSS_REGION || "US";

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

// One-click replacement for the old "go ask Claude to live-scrape FastMoss
// in a logged-in Chrome tab" flow — calls FastMoss's own Open API directly,
// server-side, no browser session needed. Triggered by the "Update" button
// on the Trend Analysis page. Accepts an optional JSON body with a
// categoryId/categoryLabel (from the category picker) and a days window
// (7/28/90) — a bare POST with no body behaves exactly like the old
// hardcoded pets/7-days version.
export async function POST(req: NextRequest) {
  // Costs real FastMoss API credits per click, and the scheduled full-catalog
  // refresh (src/lib/fastmossFullRefresh.ts) already keeps every category
  // fresh automatically — same "everyone can see, only admin can trigger"
  // convention already used by /api/trends/full-refresh and the category
  // scan route. Previously any signed-in member could hit this with no gate.
  const user = getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can trigger a manual FastMoss update" }, { status: 403 });
  }

  if (!process.env.FASTMOSS_API_KEY) {
    return NextResponse.json(
      {
        error:
          "FASTMOSS_API_KEY isn't set yet. Sign up at developers.fastmoss.com, generate an API Key in the dashboard, then add it to .env (or Railway's Variables).",
      },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const categoryId =
    typeof body?.categoryId === "string" || typeof body?.categoryId === "number" ? body.categoryId : undefined;
  const categoryLabel =
    typeof body?.categoryLabel === "string" && body.categoryLabel.trim()
      ? body.categoryLabel.trim()
      : "Pet Food & Treats";
  const daysRaw = Number(body?.days);
  const days = [7, 28, 90].includes(daysRaw) ? daysRaw : 7;

  const now = new Date();
  const from = new Date(now.getTime() - days * 86400 * 1000);
  const date_from = from.toISOString().slice(0, 10);
  const date_to = now.toISOString().slice(0, 10);

  try {
    // Pulls TREND_FETCH_LIMIT (a buffer past the 20 actually displayed) so
    // any that fail to fetch/transcribe can be backfilled with a
    // lower-ranked candidate at read time — see enrichAndBackfillTop in
    // trends.ts.
    const [byViews, bySales] = await Promise.all([
      fetchCategoryTrendVideos("play_count", { days, region: REGION, limit: TREND_FETCH_LIMIT, categoryId }),
      fetchCategoryTrendVideos("units_sold", { days, region: REGION, limit: TREND_FETCH_LIMIT, categoryId }),
    ]);

    if (byViews.length === 0 && bySales.length === 0) {
      return NextResponse.json(
        {
          error: categoryId
            ? `FastMoss returned no matching videos (category: ${categoryLabel}, ${days} days) — this time window/category may genuinely have no data. Try a different category or date range.`
            : "FastMoss returned no matching pet videos — this week may genuinely have no data, or FASTMOSS_PET_CATEGORY_ID may be set too narrowly. Try unsetting that variable to fall back to keyword search.",
        },
        { status: 502 }
      );
    }

    const batch = ingestTrendBatch({
      category: categoryLabel,
      category_id: categoryId != null ? String(categoryId) : null,
      date_from,
      date_to,
      days,
      top_by_views: byViews.map(toRawItem),
      top_by_sales: bySales.map(toRawItem),
    });

    return NextResponse.json({ batch });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "FastMoss update failed — try again in a moment." }, { status: 500 });
  }
}
