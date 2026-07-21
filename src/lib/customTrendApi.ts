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
// ---- codeX conventions (read from its live OpenAPI spec) ----
//   POST {base}/v1/videos/rank
//   body: { region?, category_id? (string|null), days (1-90, default 7),
//           order_by (enum), descending (default true),
//           page (default 1), page_size (1-100, default 20) }
//   response: { total, page, page_size, list: [ ...items ] }
//   auth: X-API-Key header. GMV values arrive as decimal STRINGS.
// The VideoRank item/enum schemas sat past the point where the spec fetch
// truncated, so the item mapper below is deliberately tolerant (nested
// `creator`/`product` objects OR flattened fields, several plausible field
// names per value), and the order_by enum value is discovered by trying
// likely candidates and treating a 422 as "wrong enum, try the next one".

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
    : // Flattened single-product fields on the item itself (codeX's rank
      // items flatten related entities — see CreatorRankItem's shape).
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
  const creatorHandle = str(creator?.unique_id) ?? str(raw.creator_unique_id) ?? str(raw.unique_id);
  return {
    video_id: str(raw.video_id) ?? str(raw.id) ?? `custom-${index}`,
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
          uid: str(creator?.uid) ?? str(raw.creator_id) ?? creatorHandle,
          unique_id: creatorHandle,
          nickname: str(creator?.nickname) ?? str(raw.nickname) ?? str(raw.creator_nickname) ?? creatorHandle,
          avatar: str(creator?.avatar_url) ?? str(creator?.avatar) ?? str(raw.avatar_url) ?? str(raw.creator_avatar),
          follower_count: num(creator?.follower_count) ?? num(raw.follower_count),
        }
      : null,
    product_info: products.map(mapProduct).filter((p: FastMossProductInfo | null): p is FastMossProductInfo => p !== null),
  };
}

// order_by enum candidates per sort intent, tried in order until one isn't
// rejected with a 422 — the winning value is remembered per process so the
// discovery cost is paid once. (The spec's VideoOrder enum definition was
// past the truncation point of the fetched OpenAPI doc; codeX's
// CreatorOrder uses plain snake_case metric names, so these are the
// plausible spellings of the two sorts this app needs.)
const ORDER_CANDIDATES: Record<"play_count" | "units_sold", string[]> = {
  play_count: ["play_count", "views", "view_count"],
  units_sold: ["units_sold", "sales", "gmv"],
};
const discoveredOrder: Partial<Record<"play_count" | "units_sold", string>> = {};

// Same signature semantics as fastmoss.ts's fetchCategoryTrendVideos so the
// two sources are interchangeable at the call site. Throws on hard failure —
// the caller (fastmoss.ts) catches and falls back to FastMoss.
export async function fetchCustomTrendVideos(
  orderField: "play_count" | "units_sold",
  opts: { days?: number; region?: string; limit?: number; categoryId?: number | string | null } = {}
): Promise<FastMossVideoResult[]> {
  const base = (process.env.CUSTOM_TREND_API_URL || "").replace(/\/+$/, "");
  const key = process.env.CUSTOM_TREND_API_KEY || "";
  if (!base || !key) return [];

  const headerName = process.env.CUSTOM_TREND_API_KEY_HEADER || "X-API-Key";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [headerName]: headerName.toLowerCase() === "authorization" ? `Bearer ${key}` : key,
  };

  const candidates = discoveredOrder[orderField]
    ? [discoveredOrder[orderField] as string]
    : ORDER_CANDIDATES[orderField];

  let lastErr: string = "no order_by candidate accepted";
  for (const orderBy of candidates) {
    const body = {
      region: opts.region ?? "US",
      category_id: opts.categoryId != null && opts.categoryId !== "" ? String(opts.categoryId) : null,
      days: Math.max(1, Math.min(90, Math.round(opts.days ?? 7))),
      order_by: orderBy,
      descending: true,
      page: 1,
      page_size: Math.max(1, Math.min(100, opts.limit ?? 20)),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(`${base}/v1/videos/rank`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 422) {
        // Validation error — most likely this order_by spelling isn't in
        // codeX's enum. Try the next candidate.
        lastErr = `order_by "${orderBy}" rejected (422)`;
        continue;
      }
      if (!res.ok) throw new Error(`codeX /v1/videos/rank HTTP ${res.status}`);
      const json = await res.json();
      const items: any[] = Array.isArray(json?.list) ? json.list : Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
      discoveredOrder[orderField] = orderBy;
      return items
        .map(mapItem)
        .filter((v): v is FastMossVideoResult => v !== null)
        .slice(0, opts.limit ?? 20);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr);
}
