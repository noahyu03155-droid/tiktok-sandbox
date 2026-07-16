// Direct FastMoss Open API client (https://developers.fastmoss.com) — replaces
// the old "ask Claude to live-scrape FastMoss in a logged-in Chrome tab" flow
// for Trend Analysis. Credit-based paid API: needs FASTMOSS_API_KEY in .env
// (see README for signup steps). All endpoints are POST, JSON in/out, auth
// via `Authorization: Bearer <key>`.
//
// Category targeting: if FASTMOSS_PET_CATEGORY_ID is set, we filter server-side
// via `product_category_id` (cheapest/most precise — use
// /api/trends/fastmoss-categories to look up the right id once you have a
// key). If it's not set, we fall back to a small keyword sweep (dog/cat/pet/
// puppy/kitten) plus the same isPetRelevant() keyword classifier already used
// by the Creator Tracker pipeline, so this still works with zero config.

import { isPetRelevant } from "./petCategories";
import type { CreatorInfo } from "./types";

const BASE_URL = "https://openapi.fastmoss.com";

export interface FastMossProductInfo {
  product_id: string;
  title: string;
  cover: string | null;
  price: string | null;
  units_sold: number | null;
  gmv: number | null;
  detail_url: string | null;
}

export interface FastMossVideoResult {
  video_id: string;
  desc: string | null;
  video_url: string | null;
  cover: string | null;
  publish_time: number | null;
  play_count: number | null;
  digg_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  units_sold: number | null;
  gmv: number | null;
  creator: {
    uid: string;
    unique_id: string;
    nickname: string;
    avatar: string | null;
    follower_count: number | null;
  } | null;
  product_info: FastMossProductInfo[] | null;
}

function getApiKey(): string {
  const key = process.env.FASTMOSS_API_KEY;
  if (!key) {
    throw new Error(
      "FASTMOSS_API_KEY isn't set — add it to .env (or the Railway Variables tab), see README for how to get one from developers.fastmoss.com."
    );
  }
  return key;
}

async function fastmossPost<T = any>(path: string, body: Record<string, any>): Promise<T> {
  const key = getApiKey();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 0) {
    const msg = json?.msg || json?.message || `HTTP ${res.status}`;
    // code 30002/30003 are FastMoss's own "out of credits / rate limited"
    // codes (see thingsToNote.html) — surface those distinctly since they're
    // the most common real-world failure once the key itself is valid.
    throw new Error(`FastMoss ${path} failed (code ${json?.code ?? "?"}): ${msg}`);
  }
  return json.data as T;
}

export async function fetchFastMossCategories() {
  return fastmossPost("/product/v1/categoryInfo", {});
}

// Cheap probe: does this category actually have any trending video data at
// all? Used by the full-tree category scan (src/lib/fastmossCategoryScan.ts)
// to decide whether to keep or hide a category in the picker. pagesize:1
// because we only need to know total > 0, not the actual videos — keeps
// each probe as cheap as this endpoint allows. Uses a wide 90-day window
// (the widest the Trend Analysis date-range selector offers) so a category
// isn't wrongly marked dead just because nothing happened to post in the
// last 7 days specifically.
export async function categoryHasVideos(categoryId: string | number, region = "US"): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const min = now - 90 * 86400;
  const data = await fastmossPost<{ total: number; list: any[] }>("/video/v1/search", {
    filter: {
      region,
      is_ecommerce: 1,
      product_category_id: Number(categoryId),
      create_time_range: { min, max: now },
    },
    page: 1,
    pagesize: 1,
  });
  return (data.total || 0) > 0;
}

async function searchVideos(opts: {
  keywords?: string;
  orderField: "play_count" | "units_sold";
  days: number;
  region: string;
  pagesize: number;
  categoryId?: number;
}): Promise<{ list: FastMossVideoResult[]; total: number }> {
  const now = Math.floor(Date.now() / 1000);
  const min = now - opts.days * 86400;
  const filter: Record<string, any> = {
    region: opts.region,
    is_ecommerce: 1,
    create_time_range: { min, max: now },
  };
  if (opts.categoryId != null) filter.product_category_id = opts.categoryId;

  const data = await fastmossPost<{ list: FastMossVideoResult[]; total: number }>("/video/v1/search", {
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
    filter,
    orderby: [{ field: opts.orderField, order: "desc" }],
    page: 1,
    pagesize: opts.pagesize,
  });
  return { list: data.list || [], total: data.total || 0 };
}

// Fallback keyword sweep used when no FASTMOSS_PET_CATEGORY_ID is configured.
// Runs a handful of small pet-adjacent keyword searches (each costs its own
// API credit — see pricing page — so this is more expensive than a single
// category-filtered call; set the category id once you know it).
const FALLBACK_KEYWORDS = ["dog", "cat", "pet", "puppy", "kitten"];

// General version: an explicit categoryId always wins over the env var,
// letting a caller (the Trend Analysis page's category picker) target any
// FastMoss category, not just the pets one this app started with. Falls
// back to FASTMOSS_PET_CATEGORY_ID, then to the keyword sweep, exactly like
// before, when no categoryId is passed — so any existing caller (or a
// scheduled task) that doesn't know about categories yet keeps working
// unchanged.
export async function fetchCategoryTrendVideos(
  orderField: "play_count" | "units_sold",
  opts: {
    days?: number;
    region?: string;
    limit?: number;
    categoryId?: number | string | null;
  } = {}
): Promise<FastMossVideoResult[]> {
  const days = opts.days ?? 7;
  const region = opts.region ?? "US";
  const limit = opts.limit ?? 20;

  let categoryId: number | undefined;
  if (opts.categoryId != null && opts.categoryId !== "") {
    const n = Number(opts.categoryId);
    if (!Number.isNaN(n)) categoryId = n;
  } else {
    const categoryIdRaw = process.env.FASTMOSS_PET_CATEGORY_ID;
    if (categoryIdRaw) {
      const n = Number(categoryIdRaw);
      if (!Number.isNaN(n)) categoryId = n;
    }
  }

  if (categoryId != null) {
    const { list } = await searchVideos({ orderField, days, region, pagesize: limit, categoryId });
    return list.slice(0, limit);
  }

  const seen = new Map<string, FastMossVideoResult>();
  for (const kw of FALLBACK_KEYWORDS) {
    const { list } = await searchVideos({ keywords: kw, orderField, days, region, pagesize: 50 });
    for (const v of list) {
      if (!seen.has(v.video_id)) seen.set(v.video_id, v);
    }
  }
  const petOnly = Array.from(seen.values()).filter((v) => {
    const text = [v.desc || "", ...((v.product_info || []).map((p) => p.title || ""))].join(" ");
    return isPetRelevant(text);
  });
  petOnly.sort((a, b) => (b[orderField] ?? 0) - (a[orderField] ?? 0));
  return petOnly.slice(0, limit);
}

// Kept for any existing caller (e.g. a scheduled task) that still calls the
// old pet-specific name with the old positional-args signature — delegates
// straight through to fetchCategoryTrendVideos with no categoryId override.
export async function fetchPetTrendVideos(
  orderField: "play_count" | "units_sold",
  days = 7,
  region = "US",
  limit = 20
): Promise<FastMossVideoResult[]> {
  return fetchCategoryTrendVideos(orderField, { days, region, limit });
}

export interface FastMossSalesTrendPoint {
  dt: string;
  units_sold: number;
  gmv: number;
}

export interface FastMossSalesTrendResult {
  list: FastMossSalesTrendPoint[];
  overview: {
    units_sold: number;
    gmv: number;
    live_count: number;
    creator_count: number;
    aweme_count: number;
    currency: string;
    region: string;
  };
}

// Real per-day units_sold/gmv for a specific product, plus totals — powers
// the on-demand "AI Analysis" sales-trend chart on a trend card. FastMoss
// caps this at 28 days regardless of what's asked for (documented API
// limit, not our own choice), so a caller asking for the site's 90-day
// window still only gets a 28-day chart here — that's the real ceiling of
// what this endpoint can return, not a bug.
export async function fetchProductSalesTrend(productId: string, days: number): Promise<FastMossSalesTrendResult> {
  const clampedDays = Math.max(1, Math.min(28, Math.round(days)));
  const data = await fastmossPost<FastMossSalesTrendResult>("/product/v1/salesTrend", {
    filter: { product_id: productId, days: clampedDays },
  });
  return { list: data.list || [], overview: data.overview };
}

// How many videos have been posted promoting this product in the last N
// days — a proxy for "how saturated/competitive is this product right
// now" (mirrors the "SATURATION (posted last 7 days)" stat FastMoss's own
// UI shows). We only need the count, so pagesize is kept at 1 to minimize
// the response payload — data.total is accurate regardless of pagesize.
export async function fetchProductVideoCount(productId: string, days: number): Promise<number> {
  const data = await fastmossPost<{ total: number }>("/product/v1/videoList", {
    filter: { product_id: productId, days: Math.max(1, Math.round(days)) },
    page: 1,
    pagesize: 1,
  });
  return data.total || 0;
}

export interface FastMossCreatorStats {
  day28_gmv: number | null;
  day28_units_sold: number | null;
  currency: string | null;
}

// Looks up a creator's own trailing-28-day GMV by @handle. FastMoss has no
// day-by-day creator GMV trend endpoint (only product-level trends have
// that) — this is a single aggregate snapshot, not chart data, and the
// caller should render it as a stat, not a sparkline.
export async function fetchCreatorStats(handle: string): Promise<FastMossCreatorStats | null> {
  const data = await fastmossPost<{ list: any[] }>("/creator/v1/search", {
    filter: { unique_id: handle },
    page: 1,
    pagesize: 1,
  });
  const row = data.list?.[0];
  if (!row) return null;
  return {
    day28_gmv: typeof row.day28_gmv === "number" ? row.day28_gmv : null,
    day28_units_sold: typeof row.day28_units_sold === "number" ? row.day28_units_sold : null,
    currency: row.currency || null,
  };
}

export function toCreatorInfo(c: FastMossVideoResult["creator"]): CreatorInfo | null {
  if (!c) return null;
  return {
    name: c.nickname || null,
    handle: c.unique_id || null,
    avatar_url: c.avatar || null,
    followers: c.follower_count ?? null,
    avg_views: null,
    avg_likes: null,
    profile_url: c.unique_id ? `https://www.tiktok.com/@${c.unique_id}` : null,
  };
}

export function buildFastmossVideoUrl(videoId: string): string {
  return `https://www.fastmoss.com/zh/media-source/video/${videoId}`;
}

// Matches the "$97.8K" style strings the rest of the app already displays
// for gmv/gmv_28d (see TrendItem in types.ts) — keeps the new API-sourced
// batches visually consistent with older manually-pasted ones.
export function formatUsd(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${n.toFixed(0)}`;
}
