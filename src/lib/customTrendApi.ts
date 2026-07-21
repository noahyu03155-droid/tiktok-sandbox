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
          price: raw.product_price,
          units_sold: raw.product_units_sold,
          gmv: raw.product_gmv,
          detail_url: raw.product_url,
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
    publish_time: num(raw.publish_time),
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
          nickname: str(creator?.nickname) ?? str(raw.nickname) ?? str(raw.creator_nickname) ?? creatorHandle,
          avatar: str(creator?.avatar_url) ?? str(creator?.avatar) ?? str(raw.avatar_url) ?? str(raw.creator_avatar),
          follower_count: num(creator?.follower_count) ?? num(raw.follower_count),
        }
      : null,
    product_info: products.map(mapProduct).filter((p: FastMossProductInfo | null): p is FastMossProductInfo => p !== null),
  };
}

// The app asks in days (7/28/90); codeX ranks come in day/week/month
// snapshots. 7 -> week, anything longer -> month, shorter -> day.
function periodFromDays(days: number): "day" | "week" | "month" {
  if (days >= 28) return "month";
  if (days >= 7) return "week";
  return "day";
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

  const params = new URLSearchParams({
    period: periodFromDays(opts.days ?? 7),
    region: opts.region ?? "US",
    category_id: codexCategoryId,
    page: "1",
    page_size: String(Math.max(1, Math.min(100, opts.limit ?? 20))),
    // Both are legal order_by values per the spec's ^(rank|units_sold|gmv|
    // play_count|engagement_rate)$ pattern.
    order_by: orderField,
  });

  const json = await getWithTimeout(`${cfg.base}/v1/videos/rank?${params.toString()}`, cfg.headers);
  const items: any[] = Array.isArray(json?.list) ? json.list : [];
  return items
    .map(mapItem)
    .filter((v): v is FastMossVideoResult => v !== null)
    .slice(0, opts.limit ?? 20);
}
