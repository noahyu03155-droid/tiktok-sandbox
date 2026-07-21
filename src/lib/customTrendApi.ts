// Adapter for the user's own "codeX" Mini Commerce Intelligence API
// (FastAPI on Railway) — plugged in as the PREFERRED trend/products source
// in front of FastMoss (see fetchCategoryTrendVideos in fastmoss.ts: custom
// first, FastMoss as fallback whenever this isn't configured, errors, or
// returns nothing). Everything downstream consumes the FastMossVideoResult
// shape, so this adapter's whole job is mapping codeX responses into that
// shape at one choke point.
//
// ---- Configuration (Railway Variables / .env) ----
//   CUSTOM_TREND_API_URL         e.g. https://codex-api-production-8e73.up.railway.app
//   CUSTOM_TREND_API_KEY         the codeX-issued key (mk_live_...)
//   CUSTOM_TREND_API_KEY_HEADER  defaults to "X-API-Key" (what codeX expects)
//
// ---- codeX unified rankings API (read from its live OpenAPI spec) ----
//   GET /v1/videos/rank?period=day|week|month&region=US&category_id=all
//        &page=1&page_size=20&order_by=rank|units_sold|gmv|play_count|engagement_rate
//     -> { total, page, page_size, latest_ranking_date, list: [...],
//          period, region, category_id, source_category_id }
//   GET /v1/rank/categories
//     -> { total, list: [ { category_id, category_name, source_category_id } ] }
//   auth: X-API-Key header. GMV values may arrive as decimal STRINGS.
//
// Category mapping: this app's category picker uses FastMoss c_codes, while
// codeX ranks are keyed by its own category_id — but each codeX category
// carries the FastMoss id it was sourced from as `source_category_id`, so
// /v1/rank/categories is the bridge (cached below). A requested category
// that maps to nothing in codeX returns [] here, which makes the caller
// fall back to FastMoss — correct-category data over mislabeled data,
// always (this exact failure — a "Fashion Accessories" pull rendering pet
// products — is what motivated the mapping).

import type { FastMossProductInfo, FastMossVideoResult } from "./fastmoss";

export function isCustomTrendApiConfigured(): boolean {
  return Boolean(process.env.CUSTOM_TREND_API_URL && process.env.CUSTOM_TREND_API_KEY);
}

function num(v: any): number | null {
  const n = typeof v === "string" ? parseFloat(v.replace(/[$,]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: any): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// codeX prices arrive as a min/max pair (live-verified field names:
// price_min / price_max) — render as "$a - $b", collapsing to "$a" when
// equal or when only one side exists.
function priceRange(min: any, max: any): string | null {
  const a = num(min);
  const b = num(max);
  if (a == null && b == null) return null;
  if (a != null && b != null && a !== b) return `$${a} - $${b}`;
  return `$${a ?? b}`;
}

function apiConfig(): { base: string; headers: Record<string, string> } | null {
  const base = (process.env.CUSTOM_TREND_API_URL || "").replace(/\/+$/, "");
  const key = process.env.CUSTOM_TREND_API_KEY || "";
  if (!base || !key) return null;
  const headerName = process.env.CUSTOM_TREND_API_KEY_HEADER || "X-API-Key";
  return {
    base,
    headers: { [headerName]: headerName.toLowerCase() === "authorization" ? `Bearer ${key}` : key },
  };
}

async function getWithTimeout(url: string, headers: Record<string, string>, timeoutMs = 20_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`codeX ${new URL(url).pathname} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---- category bridge (FastMoss c_code <-> codeX category_id) ----
interface CodexRankCategory {
  category_id: string;
  category_name: string;
  source_category_id: string;
}

let codexCategoriesCache: { at: number; list: CodexRankCategory[] } | null = null;
const CODEX_CATEGORIES_TTL_MS = 10 * 60 * 1000;

export async function fetchCodexRankCategories(): Promise<CodexRankCategory[]> {
  const cfg = apiConfig();
  if (!cfg) return [];
  if (codexCategoriesCache && Date.now() - codexCategoriesCache.at < CODEX_CATEGORIES_TTL_MS) {
    return codexCategoriesCache.list;
  }
  const json = await getWithTimeout(`${cfg.base}/v1/rank/categories`, cfg.headers);
  const list: CodexRankCategory[] = Array.isArray(json?.list)
    ? json.list.filter((c: any) => c && typeof c.category_id === "string")
    : [];
  codexCategoriesCache = { at: Date.now(), list };
  return list;
}

// Resolves the app-side category (a FastMoss c_code from the picker, or
// possibly already a codeX id) to the codeX category_id the rank endpoints
// expect. null/"" -> "all". Unmappable -> null (caller returns [] so the
// FastMoss fallback serves the category instead).
async function resolveCodexCategoryId(requested: number | string | null | undefined): Promise<string | null> {
  if (requested == null || requested === "") return "all";
  const want = String(requested);
  try {
    const cats = await fetchCodexRankCategories();
    const direct = cats.find((c) => c.category_id === want);
    if (direct) return direct.category_id;
    const bySource = cats.find((c) => c.source_category_id === want);
    if (bySource) return bySource.category_id;
    return null;
  } catch {
    // Category listing unavailable — send the raw id through rather than
    // giving up entirely; codeX treats an unknown id as no rows, which
    // still lands in the FastMoss fallback.
    return want;
  }
}

// ---- item mapping ----
function mapProduct(p: any): FastMossProductInfo | null {
  if (!p || typeof p !== "object") return null;
  return {
    product_id: str(p.product_id) ?? str(p.id) ?? "",
    title: str(p.title) ?? str(p.name) ?? str(p.product_name) ?? "",
    cover: str(p.cover_url) ?? str(p.cover) ?? str(p.image) ?? str(p.image_url),
    price: str(p.price),
    units_sold: num(p.units_sold) ?? num(p.sales),
    gmv: num(p.gmv),
    detail_url: str(p.detail_url) ?? str(p.url) ?? str(p.product_url),
  };
}

function mapItem(raw: any, index: number): FastMossVideoResult | null {
  if (!raw || typeof raw !== "object") return null;
  const videoUrl = str(raw.video_url) ?? str(raw.tiktok_url) ?? str(raw.share_url);
  const products = Array.isArray(raw.products)
    ? raw.products
    : Array.isArray(raw.product_info)
    ? raw.product_info
    : raw.product
    ? [raw.product]
    : // Flattened single-product fields on the item itself (codeX rank
      // items flatten related entities, same style as its creator ranks).
    raw.product_id || raw.product_name || raw.product_title
    ? [
        {
          product_id: raw.product_id,
          title: raw.product_title ?? raw.product_name,
          cover_url: raw.product_cover_url ?? raw.product_image,
          // Live-verified: video rank items carry the linked product's
          // price as price_min/price_max on the item itself.
          price: raw.product_price ?? priceRange(raw.price_min, raw.price_max),
          units_sold: raw.product_units_sold ?? raw.units_sold,
          gmv: raw.product_gmv ?? raw.gmv,
          detail_url: raw.product_url ?? raw.source_url,
        },
      ]
    : [];
  const creator = raw.creator && typeof raw.creator === "object" ? raw.creator : null;
  const creatorHandle =
    str(creator?.unique_id) ?? str(raw.creator_unique_id) ?? str(raw.unique_id) ?? str(raw.creator_handle);
  return {
    video_id: str(raw.video_id) ?? str(raw.video_external_id) ?? str(raw.id) ?? `custom-${index}`,
    desc: str(raw.title) ?? str(raw.desc) ?? str(raw.description),
    video_url: videoUrl,
    cover: str(raw.cover_url) ?? str(raw.cover) ?? str(raw.thumbnail),
    // published_at is an ISO string live; publish_time (epoch seconds) kept
    // as a fallback spelling.
    publish_time:
      num(raw.publish_time) ?? (str(raw.published_at) ? Math.floor(Date.parse(raw.published_at) / 1000) || null : null),
    play_count: num(raw.play_count) ?? num(raw.views) ?? num(raw.view_count),
    digg_count: num(raw.digg_count) ?? num(raw.likes) ?? num(raw.like_count),
    comment_count: num(raw.comment_count) ?? num(raw.comments),
    share_count: num(raw.share_count) ?? num(raw.shares),
    units_sold: num(raw.units_sold) ?? num(raw.sales),
    gmv: num(raw.gmv),
    creator: creatorHandle
      ? {
          uid: str(creator?.uid) ?? str(raw.creator_id) ?? str(raw.creator_external_id) ?? creatorHandle,
          unique_id: creatorHandle,
          // Live-verified codeX spellings: creator_name / creator_avatar_url.
          nickname:
            str(creator?.nickname) ?? str(raw.creator_name) ?? str(raw.nickname) ?? str(raw.creator_nickname) ?? creatorHandle,
          avatar:
            str(creator?.avatar_url) ?? str(creator?.avatar) ?? str(raw.creator_avatar_url) ?? str(raw.avatar_url) ?? str(raw.creator_avatar),
          follower_count: num(creator?.follower_count) ?? num(raw.follower_count),
        }
      : null,
    product_info: products.map(mapProduct).filter((p: FastMossProductInfo | null): p is FastMossProductInfo => p !== null),
  };
}

// ---- dedicated PRODUCT ranking (GET /v1/products/rank) ----
// The Product tab used to derive products from the VIDEO rank's attached
// product info — but only a minority of ranked videos carry product data,
// so a "Top 50" regularly shriveled to a handful of cards. codeX's product
// rank endpoint returns actual products directly (order_by=units_sold),
// which is what the tab wants. Returned as a neutral intermediate shape —
// NOT RawTrendItem — so this module doesn't need value imports from
// trends.ts/fastmoss.ts (fastmoss.ts already imports from here; a value
// import back would create a cycle).
export interface CustomProductRankItem {
  product_id: string;
  title: string;
  image: string | null;
  price: string | null;
  units_sold: number | null;
  gmv: number | null;
  detail_url: string | null;
}

export async function fetchCustomProductRank(opts: {
  days?: number;
  region?: string;
  limit?: number;
  categoryId?: number | string | null;
}): Promise<CustomProductRankItem[]> {
  const cfg = apiConfig();
  if (!cfg) return [];
  const codexCategoryId = await resolveCodexCategoryId(opts.categoryId);
  if (codexCategoryId === null) return [];

  const limit = opts.limit ?? 50;
  const items = await fetchWithPeriodFallback(periodFromDays(opts.days ?? 7), limit, async (period) => {
    const params = new URLSearchParams({
      period,
      region: opts.region ?? "US",
      category_id: codexCategoryId,
      page: "1",
      page_size: String(Math.max(1, Math.min(100, limit))),
      // Legal per the spec's ^(rank|units_sold|gmv|total_units_sold|total_gmv)$.
      order_by: "units_sold",
    });
    const json = await getWithTimeout(`${cfg.base}/v1/products/rank?${params.toString()}`, cfg.headers);
    return Array.isArray(json?.list) ? (json.list as any[]) : [];
  });
  return items
    .map((raw): CustomProductRankItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const id = str(raw.product_id) ?? str(raw.product_external_id) ?? str(raw.id);
      const title = str(raw.title) ?? str(raw.product_name) ?? str(raw.name);
      if (!id || !title) return null;
      return {
        product_id: id,
        title,
        image: str(raw.cover_url) ?? str(raw.image_url) ?? str(raw.cover) ?? str(raw.image),
        // Live-verified codeX fields: price_min/price_max (no plain `price`),
        // source_url (no `detail_url`).
        price: str(raw.price) ?? priceRange(raw.price_min, raw.price_max),
        units_sold: num(raw.units_sold) ?? num(raw.total_units_sold),
        gmv: num(raw.gmv) ?? num(raw.total_gmv),
        detail_url: str(raw.source_url) ?? str(raw.detail_url) ?? str(raw.product_url) ?? str(raw.url),
      };
    })
    .filter((p): p is CustomProductRankItem => p !== null)
    .slice(0, opts.limit ?? 50);
}

// ---- per-product sales trend (POST /v1/products/trend) ----
// Replaces FastMoss's /product/v1/salesTrend for the product detail page's
// Overview chart — the FastMoss plan lost access to that endpoint (403
// "can not access current endpoint"). The codeX ProductTrendRequest/
// Response schemas sat past the fetched spec's truncation point, so both
// the request (two likely shapes tried in order, 422 = try next) and the
// response parse (several plausible field spellings) are tolerant. Returns
// null on any failure — the caller falls back to FastMoss, and failing
// THAT surfaces the same error as before.
export async function fetchCustomProductTrend(
  productId: string,
  days: number
): Promise<{ list: { dt: string; units_sold: number; gmv: number }[]; overview: { units_sold: number; gmv: number; live_count: number; creator_count: number; aweme_count: number; currency: string; region: string } } | null> {
  const cfg = apiConfig();
  if (!cfg) return null;
  const bodies: Record<string, any>[] = [
    { product_id: productId, days },
    { product_id: productId, period: periodFromDays(days) },
    { product_id: productId },
  ];
  for (const body of bodies) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(`${cfg.base}/v1/products/trend`, {
        method: "POST",
        headers: { ...cfg.headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 422) continue; // wrong request shape — try the next candidate
      if (!res.ok) return null;
      const json: any = await res.json();
      const rawPoints: any[] = Array.isArray(json?.list)
        ? json.list
        : Array.isArray(json?.points)
        ? json.points
        : Array.isArray(json?.trend)
        ? json.trend
        : Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json)
        ? json
        : [];
      const list = rawPoints
        .map((p: any) => ({
          dt: str(p?.dt) ?? str(p?.date) ?? str(p?.day) ?? str(p?.ranking_date) ?? "",
          units_sold: num(p?.units_sold) ?? num(p?.sales) ?? 0,
          gmv: num(p?.gmv) ?? 0,
        }))
        .filter((p) => p.dt);
      if (list.length === 0) return null;
      const totals = list.reduce(
        (acc, p) => ({ units: acc.units + p.units_sold, gmv: acc.gmv + p.gmv }),
        { units: 0, gmv: 0 }
      );
      return {
        list,
        overview: {
          units_sold: num(json?.overview?.units_sold) ?? totals.units,
          gmv: num(json?.overview?.gmv) ?? totals.gmv,
          live_count: num(json?.overview?.live_count) ?? 0,
          creator_count: num(json?.overview?.creator_count) ?? 0,
          aweme_count: num(json?.overview?.aweme_count) ?? 0,
          currency: str(json?.overview?.currency) ?? "USD",
          region: str(json?.overview?.region) ?? "US",
        },
      };
    } catch {
      return null;
    }
  }
  return null;
}

// The app asks in days (7/28/90); codeX ranks come in day/week/month
// snapshots. 7 -> week, anything longer -> month, shorter -> day.
function periodFromDays(days: number): "day" | "week" | "month" {
  if (days >= 28) return "month";
  if (days >= 7) return "week";
  return "day";
}

// codeX's week/month snapshots are much sparser than its day snapshots (a
// 7D pull came back with 5 rows while day rankings held far more) — so if
// the preferred period can't fill the request, try the other periods and
// keep whichever returned the MOST rows. Order: preferred first, then
// shorter periods (denser data), month last.
function periodFallbackOrder(preferred: "day" | "week" | "month"): ("day" | "week" | "month")[] {
  if (preferred === "month") return ["month", "week", "day"];
  if (preferred === "week") return ["week", "day", "month"];
  return ["day", "week", "month"];
}

// Runs `fetchForPeriod` across the fallback order until one period fills
// `wanted` rows; otherwise returns the largest result seen. Shared by the
// video and product rank fetchers below.
async function fetchWithPeriodFallback<T>(
  preferred: "day" | "week" | "month",
  wanted: number,
  fetchForPeriod: (period: "day" | "week" | "month") => Promise<T[]>
): Promise<T[]> {
  let best: T[] = [];
  for (const period of periodFallbackOrder(preferred)) {
    try {
      const items = await fetchForPeriod(period);
      if (items.length >= wanted) return items;
      if (items.length > best.length) best = items;
    } catch {
      // A single period failing shouldn't kill the whole pull — the caller
      // treats an overall empty result as "fall back to FastMoss" anyway.
    }
  }
  return best;
}

// Same signature semantics as fastmoss.ts's fetchCategoryTrendVideos so the
// two sources are interchangeable at the call site. Throws on hard failure —
// the caller (fastmoss.ts) catches and falls back to FastMoss. Returns []
// (also triggering the fallback) when the requested category doesn't exist
// in codeX at all.
export async function fetchCustomTrendVideos(
  orderField: "play_count" | "units_sold",
  opts: { days?: number; region?: string; limit?: number; categoryId?: number | string | null } = {}
): Promise<FastMossVideoResult[]> {
  const cfg = apiConfig();
  if (!cfg) return [];

  const codexCategoryId = await resolveCodexCategoryId(opts.categoryId);
  if (codexCategoryId === null) return [];

  const limit = opts.limit ?? 20;
  const items = await fetchWithPeriodFallback(periodFromDays(opts.days ?? 7), limit, async (period) => {
    const params = new URLSearchParams({
      period,
      region: opts.region ?? "US",
      category_id: codexCategoryId,
      page: "1",
      page_size: String(Math.max(1, Math.min(100, limit))),
      // Both are legal order_by values per the spec's ^(rank|units_sold|gmv|
      // play_count|engagement_rate)$ pattern.
      order_by: orderField,
    });
    const json = await getWithTimeout(`${cfg.base}/v1/videos/rank?${params.toString()}`, cfg.headers);
    return Array.isArray(json?.list) ? (json.list as any[]) : [];
  });
  return items
    .map(mapItem)
    .filter((v): v is FastMossVideoResult => v !== null)
    .slice(0, limit);
}
