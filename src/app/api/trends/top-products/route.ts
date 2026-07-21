import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, getVideo } from "@/lib/db";
import { buildFastmossVideoUrl, fetchCategoryTrendVideos, fetchFastMossCategories, formatUsd, toCreatorInfo } from "@/lib/fastmoss";
import type { FastMossVideoResult } from "@/lib/fastmoss";
import { ingestTrendBatch, type RawTrendItem } from "@/lib/trends";
import { filterAndScoreProducts } from "@/lib/productRelevance";
import { fetchCustomProductRank, isCustomTrendApiConfigured } from "@/lib/customTrendApi";

export const dynamic = "force-dynamic";

const REGION = process.env.FASTMOSS_REGION || "US";

// Powers the Trend Analysis page's "Product" tab (see TrendsPageContent.tsx)
// — a dedicated Top 50 SELLING products list (sorted by units sold, not
// views) for the signed-in user's own saved registration category. Distinct
// from /api/trends/personalized's "Top 20 Viral Products" (views-sorted,
// capped at 20, folded into the "For You" video section) — this route is
// its own tab with its own live pull, fetched lazily only when the user
// actually switches to the Product tab.
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

interface FastMossCategoryNode {
  c_code: string;
  c_name: string;
  sub?: FastMossCategoryNode[];
}

// Same "narrow leaf category has no data, walk up to its direct parent"
// fallback as /api/trends/personalized — duplicated rather than shared
// since it's a tiny, self-contained helper (see that route's comment for
// the full reasoning).
function findParentCategory(tree: FastMossCategoryNode[], categoryId: string): { id: string; name: string } | null {
  for (const l1 of tree) {
    for (const l2 of l1.sub || []) {
      if (l2.c_code === categoryId) return { id: l1.c_code, name: l1.c_name };
    }
  }
  return null;
}

// Multiple videos in the raw (sales-sorted) list can push the same product
// — keep whichever appearance had the higher sales figure, then re-sort and
// cap at `limit`. Ranks are reassigned afterward (see the GET handler) since
// the original per-video rank no longer reflects final product position
// once duplicates are dropped.
function dedupeBySales(items: RawTrendItem[], limit: number): RawTrendItem[] {
  const byProduct = new Map<string, RawTrendItem>();
  for (const item of items) {
    if (!item.product_id) continue;
    const existing = byProduct.get(item.product_id);
    const val = typeof item.sales === "number" ? item.sales : 0;
    const existingVal = existing ? (typeof existing.sales === "number" ? existing.sales : 0) : -1;
    if (!existing || val > existingVal) byProduct.set(item.product_id, item);
  }
  return Array.from(byProduct.values())
    .sort((a, b) => (typeof b.sales === "number" ? b.sales : 0) - (typeof a.sales === "number" ? a.sales : 0))
    .slice(0, limit);
}

export async function GET(req: NextRequest) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const user = getUserById(sessionUser.userId);
  // The Product tab's own category dropdown (see TrendsPageContent.tsx) lets
  // ANYONE browse any category's top sellers, not just their own saved one —
  // an explicit ?categoryId always wins. Falls back to the user's saved
  // registration category when the client doesn't pass one (its default
  // selection), so this still "just works" the way it did before the
  // dropdown existed.
  const qsCategoryId = req.nextUrl.searchParams.get("categoryId");
  const qsCategoryLabel = req.nextUrl.searchParams.get("categoryLabel");
  let categoryId = qsCategoryId || user?.preferredCategoryId || null;
  let categoryLabel = (qsCategoryId ? qsCategoryLabel : null) || user?.preferredCategoryLabel || null;
  // ?all=1 forces an "all categories" pull even when the user HAS a saved
  // category — that powers the Product tab's second section (the catalog-
  // wide Top 20 shown UNDER the personalized For You list). With no
  // category anywhere, all-categories is also the default rather than a
  // dead end. The custom trend API treats a null category_id as "across
  // the whole catalog".
  const forceAll = req.nextUrl.searchParams.get("all") === "1";
  const allCategories = forceAll || !categoryId;
  if (allCategories) {
    categoryId = null;
    categoryLabel = "All categories";
  }

  if (!process.env.FASTMOSS_API_KEY && !isCustomTrendApiConfigured()) {
    return NextResponse.json(
      { error: "Neither CUSTOM_TREND_API_URL/KEY nor FASTMOSS_API_KEY is set — can't pull live product data." },
      { status: 400 }
    );
  }

  try {
    // Same 7/28/90 choices as the Video tab's own day-range buttons —
    // defaults to 7 if missing/invalid.
    const qsDays = Number(req.nextUrl.searchParams.get("days"));
    const days = qsDays === 28 || qsDays === 90 ? qsDays : 7;
    // Optional ?limit= (clamped 5-50, default 50) — the all-categories
    // second section only wants a Top 20, no point pulling/scoring 50.
    // NOTE the null check BEFORE Number(): Number(null) is 0 (not NaN), so
    // the earlier `Number.isFinite(Number(get("limit")))` version turned
    // "no limit param at all" into 0 → clamped to 5 — which is exactly why
    // the Product tab (which never sends limit) showed only 5 cards while
    // direct testing with an explicit limit=50 showed all 50.
    const qsLimitRaw = req.nextUrl.searchParams.get("limit");
    const limit = qsLimitRaw !== null && Number.isFinite(Number(qsLimitRaw))
      ? Math.max(5, Math.min(50, Math.round(Number(qsLimitRaw))))
      : 50;

    // PREFERRED source: codeX's dedicated product ranking — real products,
    // directly. The older path below derives products from the VIDEO rank's
    // attached product info, and since only a minority of ranked videos
    // carry product data, a "Top 50" regularly came out as 4-5 cards (the
    // exact complaint that added this). Falls through to the video-derived
    // path whenever codeX isn't configured, errors, or has nothing for
    // this category.
    let dedupedRaw: RawTrendItem[] | null = null;
    if (isCustomTrendApiConfigured()) {
      try {
        const prodItems = await fetchCustomProductRank({ days, region: REGION, limit, categoryId });
        if (prodItems.length > 0) {
          dedupedRaw = prodItems.map((p, i) => ({
            rank: i + 1,
            fastmoss_url: p.detail_url || "",
            product_name: p.title,
            product_id: p.product_id,
            product_image: p.image || undefined,
            product_price: p.price || undefined,
            gmv: p.gmv != null ? formatUsd(p.gmv) || undefined : undefined,
            sales: p.units_sold ?? undefined,
          }));
        }
      } catch {
        // codeX product rank unavailable — video-derived fallback below.
      }
    }

    let raw: FastMossVideoResult[] = [];
    let usedFallbackCategory: string | null = null;
    if (!dedupedRaw) {
      raw = await fetchCategoryTrendVideos("units_sold", { days, region: REGION, limit, categoryId });
    }

    if (!dedupedRaw && raw.length === 0 && !allCategories) {
      try {
        const tree = (await fetchFastMossCategories()) as FastMossCategoryNode[];
        // categoryId is guaranteed non-null in this branch (allCategories
        // is false), but it's a `let` reassigned below so TS can't narrow
        // it across the awaits — hence the String() instead of a bare pass.
        const parent = findParentCategory(tree || [], String(categoryId));
        if (parent) {
          const parentRaw = await fetchCategoryTrendVideos("units_sold", {
            days,
            region: REGION,
            limit: 50,
            categoryId: Number(parent.id),
          });
          if (parentRaw.length > 0) {
            raw = parentRaw;
            categoryId = parent.id;
            categoryLabel = parent.name;
            usedFallbackCategory = parent.name;
          }
        }
      } catch {
        // Parent lookup/retry failed — fall through to the "no data" error
        // below exactly as if no fallback had been attempted.
      }
    }

    if (!dedupedRaw && raw.length === 0) {
      return NextResponse.json(
        { error: `No product data yet for your saved category (${categoryLabel || categoryId}) — check back later.` },
        { status: 502 }
      );
    }

    if (!dedupedRaw) {
      dedupedRaw = dedupeBySales(raw.map(toRawItem), limit).map((item, i) => ({ ...item, rank: i + 1 }));
    }

    // COTORX-side relevance filter + per-user recommendation scoring — see
    // productRelevance.ts. FastMoss tags category on the VIDEO, not the
    // product attached to it, so obviously off-category products (e.g. an
    // eyelash serum under "Pet Supplies") can slip through even when
    // FastMoss's own data is otherwise fine; this is COTORX filtering its
    // own display, not a FastMoss bug workaround. Non-fatal — falls back to
    // showing everything, unscored, if the AI call fails.
    // "All categories" pulls skip the relevance filter entirely — there's
    // no category to be relevant TO, and asking the AI to filter against
    // "All categories" would just produce noise.
    const candidates = allCategories
      ? []
      : dedupedRaw
          .filter((item) => item.product_id && (item.product_name || item.fastmoss_title))
          .map((item) => ({
            product_id: item.product_id as string,
            title: (item.product_name || item.fastmoss_title || "").toString(),
          }));
    const { keep, score } = await filterAndScoreProducts(
      categoryLabel || String(categoryId),
      candidates,
      user
        ? {
            preferredCategoryLabel: user.preferredCategoryLabel,
            insightTags: user.insightTags,
            journalKeywords: user.journalKeywords,
            interests: user.creatorProfile?.interests ?? null,
          }
        : null
    );

    let filteredRaw = dedupedRaw.filter((item) => !item.product_id || keep.get(item.product_id) !== false);
    // Safety net: never let an AI hiccup wipe the whole list down to
    // nothing — fall back to the unfiltered set rather than show an empty
    // page.
    if (filteredRaw.length === 0) filteredRaw = dedupedRaw;
    filteredRaw = filteredRaw.map((item, i) => ({ ...item, rank: i + 1 }));

    // Reuses the shared ingest pipeline purely so each product gets the same
    // video hydration (video_id lookup/creation + transcribe queueing) that
    // powers the "Add to Creation" button on ProductCard — not because this
    // needs to persist as a "views" batch too (top_by_views is empty here).
    const batch = ingestTrendBatch({
      category: categoryLabel || String(categoryId ?? "All categories"),
      category_id: categoryId ? String(categoryId) : null,
      date_from: new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10),
      date_to: new Date().toISOString().slice(0, 10),
      days,
      top_by_views: [],
      top_by_sales: filteredRaw,
    });

    const products = batch.top_by_sales.map((item) => ({
      ...item,
      video: item.video_id ? getVideo(item.video_id) : null,
      recommendationScore: item.product_id ? score.get(item.product_id) ?? null : null,
    }));

    return NextResponse.json({
      products,
      categoryId,
      categoryLabel: categoryLabel || batch.category,
      usedFallbackCategory,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to load top products" }, { status: 500 });
  }
}
