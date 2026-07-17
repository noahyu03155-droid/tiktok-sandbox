import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, getVideo } from "@/lib/db";
import { buildFastmossVideoUrl, fetchCategoryTrendVideos, fetchFastMossCategories, formatUsd, toCreatorInfo } from "@/lib/fastmoss";
import type { FastMossVideoResult } from "@/lib/fastmoss";
import { ingestTrendBatch, type RawTrendItem } from "@/lib/trends";

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
  if (!categoryId) {
    return NextResponse.json({ products: null, needsCategory: true });
  }

  if (!process.env.FASTMOSS_API_KEY) {
    return NextResponse.json(
      { error: "FASTMOSS_API_KEY isn't set — can't pull live product data." },
      { status: 400 }
    );
  }

  try {
    const days = 7;
    let raw = await fetchCategoryTrendVideos("units_sold", { days, region: REGION, limit: 50, categoryId });
    let usedFallbackCategory: string | null = null;

    if (raw.length === 0) {
      try {
        const tree = (await fetchFastMossCategories()) as FastMossCategoryNode[];
        const parent = findParentCategory(tree || [], categoryId);
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

    if (raw.length === 0) {
      return NextResponse.json(
        { error: `No product data yet for your saved category (${categoryLabel || categoryId}) — check back later.` },
        { status: 502 }
      );
    }

    const dedupedRaw = dedupeBySales(raw.map(toRawItem), 50).map((item, i) => ({ ...item, rank: i + 1 }));

    // Reuses the shared ingest pipeline purely so each product gets the same
    // video hydration (video_id lookup/creation + transcribe queueing) that
    // powers the "Add to Creation" button on ProductCard — not because this
    // needs to persist as a "views" batch too (top_by_views is empty here).
    const batch = ingestTrendBatch({
      category: categoryLabel || String(categoryId),
      category_id: String(categoryId),
      date_from: new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10),
      date_to: new Date().toISOString().slice(0, 10),
      days,
      top_by_views: [],
      top_by_sales: dedupedRaw,
    });

    const products = batch.top_by_sales.map((item) => ({
      ...item,
      video: item.video_id ? getVideo(item.video_id) : null,
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
