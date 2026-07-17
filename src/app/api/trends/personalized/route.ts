import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, getVideo, getLatestTrendBatchByCategory } from "@/lib/db";
import { buildFastmossVideoUrl, fetchCategoryTrendVideos, fetchFastMossCategories, formatUsd, toCreatorInfo } from "@/lib/fastmoss";
import type { FastMossVideoResult } from "@/lib/fastmoss";
import { ingestTrendBatch, type RawTrendItem } from "@/lib/trends";
import type { TrendBatch, TrendItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const REGION = process.env.FASTMOSS_REGION || "US";
// Reuse a same-category batch pulled within the last 24h instead of
// re-hitting FastMoss's paid API on every page visit — many different
// users can share one category's cached pull (see
// getLatestTrendBatchByCategory in db.ts, and the shared logic in
// /api/trends/update which this route parallels).
const FRESH_MS = 24 * 60 * 60 * 1000;

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

// FastMoss's Open API has no dedicated "top trending products" endpoint —
// only per-product lookups given an already-known product_id (see
// fetchProductSalesTrend/fetchProductVideoCount). So "Top 20 viral
// products" is derived here by deduping the two video-level lists we
// already fetched (by views, by sales) down to one row per product_id,
// keeping whichever appearance had the higher view count, then sorting by
// views — at no extra FastMoss API cost beyond the two calls this route
// already makes.
function deriveTopProducts(items: TrendItem[], limit: number): TrendItem[] {
  const byProduct = new Map<string, TrendItem>();
  for (const item of items) {
    if (!item.product_id) continue;
    const existing = byProduct.get(item.product_id);
    if (!existing || (item.views ?? 0) > (existing.views ?? 0)) {
      byProduct.set(item.product_id, item);
    }
  }
  return Array.from(byProduct.values())
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, limit);
}

interface FastMossCategoryNode {
  c_code: string;
  c_name: string;
  sub?: FastMossCategoryNode[];
}

// A saved preferredCategoryId is picked at registration from a flattened
// (up to) 2-level list — see src/app/register/page.tsx's flatCategories —
// so a "no data for this exact category" case is almost always a narrow
// leaf category (e.g. "Dog & Cat Food") whose own product_category_id
// wasn't confirmed to have video-search results at scan time, even though
// its broader parent ("Pet Supplies") does. Walks the category tree one
// level to find that direct parent, if any; returns null if categoryId is
// already top-level (or isn't found in the tree at all, e.g. the tree
// changed since the user picked it).
function findParentCategory(tree: FastMossCategoryNode[], categoryId: string): { id: string; name: string } | null {
  for (const l1 of tree) {
    for (const l2 of l1.sub || []) {
      if (l2.c_code === categoryId) return { id: l1.c_code, name: l1.c_name };
    }
  }
  return null;
}

// Powers the "For You" section on the Trend Analysis page — reads the
// logged-in user's saved preferredCategoryId (set at registration, see
// /api/register) and returns Top 20 viral videos (by views, by sales) plus
// a derived Top 20 viral products list for that category, without
// requiring the user to pick a category on the page themselves each visit.
export async function GET(req: NextRequest) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const user = getUserById(sessionUser.userId);
  let categoryId = user?.preferredCategoryId || null;
  let categoryLabel = user?.preferredCategoryLabel || null;
  if (!categoryId) {
    return NextResponse.json({ batch: null, needsCategory: true });
  }

  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  let cached = getLatestTrendBatchByCategory(categoryId);
  let isFresh = !!cached && Date.now() - new Date(cached.created_at).getTime() < FRESH_MS;

  let batch: TrendBatch | null = cached;
  let shouldFetchLive = forceRefresh || !batch || !isFresh;
  // Set once a fallback to the broader parent category actually happens, so
  // the client can show a small "showing results for the broader category"
  // note instead of silently swapping categories on the user.
  let usedFallbackCategory: string | null = null;

  if (shouldFetchLive && process.env.FASTMOSS_API_KEY) {
    try {
      const days = 7;
      const now = new Date();
      const from = new Date(now.getTime() - days * 86400 * 1000);
      const [byViews, bySales] = await Promise.all([
        fetchCategoryTrendVideos("play_count", { days, region: REGION, limit: 20, categoryId }),
        fetchCategoryTrendVideos("units_sold", { days, region: REGION, limit: 20, categoryId }),
      ]);
      if (byViews.length > 0 || bySales.length > 0) {
        batch = ingestTrendBatch({
          category: categoryLabel || String(categoryId),
          category_id: String(categoryId),
          date_from: from.toISOString().slice(0, 10),
          date_to: now.toISOString().slice(0, 10),
          days,
          top_by_views: byViews.map(toRawItem),
          top_by_sales: bySales.map(toRawItem),
        });
      } else {
        // The exact saved category came back empty (a common case for a
        // narrow leaf category, e.g. "Dog & Cat Food" under "Pet
        // Supplies") — walk up to its direct parent category and retry
        // once there before giving up. Falls through to the `!batch`
        // English error below if the parent has nothing either.
        try {
          const tree = (await fetchFastMossCategories()) as FastMossCategoryNode[];
          const parent = findParentCategory(tree || [], categoryId);
          if (parent) {
            const parentCached = getLatestTrendBatchByCategory(parent.id);
            const parentIsFresh = !!parentCached && Date.now() - new Date(parentCached.created_at).getTime() < FRESH_MS;
            let parentBatch = parentCached;
            if (!parentBatch || !parentIsFresh) {
              const [parentByViews, parentBySales] = await Promise.all([
                fetchCategoryTrendVideos("play_count", { days, region: REGION, limit: 20, categoryId: Number(parent.id) }),
                fetchCategoryTrendVideos("units_sold", { days, region: REGION, limit: 20, categoryId: Number(parent.id) }),
              ]);
              if (parentByViews.length > 0 || parentBySales.length > 0) {
                parentBatch = ingestTrendBatch({
                  category: parent.name,
                  category_id: parent.id,
                  date_from: from.toISOString().slice(0, 10),
                  date_to: now.toISOString().slice(0, 10),
                  days,
                  top_by_views: parentByViews.map(toRawItem),
                  top_by_sales: parentBySales.map(toRawItem),
                });
              }
            }
            if (parentBatch) {
              batch = parentBatch;
              categoryId = parent.id;
              categoryLabel = parent.name;
              usedFallbackCategory = parent.name;
            }
          }
        } catch {
          // Parent lookup/retry failed — fall through to the cached/error
          // handling below exactly as if no fallback had been attempted.
        }
      }
      // If FastMoss returned nothing even after the fallback above, fall
      // through and keep using `cached` (if any) rather than clobbering it
      // with an empty result.
    } catch {
      // Live pull failed (rate limit, network, etc.) — fall back to
      // whatever cached batch we have, if any (handled below).
    }
  }

  if (!batch) {
    return NextResponse.json(
      {
        error: `No trend data yet for your saved category (${categoryLabel || categoryId}) — check back later.`,
        needsCategory: false,
      },
      { status: 502 }
    );
  }

  const enrichItem = (item: TrendItem) => ({ ...item, video: item.video_id ? getVideo(item.video_id) : null });
  const topByViews = batch.top_by_views.map(enrichItem);
  const topBySales = batch.top_by_sales.map(enrichItem);
  const topProducts = deriveTopProducts([...batch.top_by_views, ...batch.top_by_sales], 20).map(enrichItem);

  return NextResponse.json({
    usedFallbackCategory,
    batch: { ...batch, top_by_views: topByViews, top_by_sales: topBySales },
    topProducts,
    categoryId,
    categoryLabel: categoryLabel || batch.category,
  });
}
