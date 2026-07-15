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

export async function fetchPetTrendVideos(
  orderField: "play_count" | "units_sold",
  days = 7,
  region = "US",
  limit = 20
): Promise<FastMossVideoResult[]> {
  const categoryIdRaw = process.env.FASTMOSS_PET_CATEGORY_ID;
  const categoryId = categoryIdRaw ? Number(categoryIdRaw) : undefined;

  if (categoryId != null && !Number.isNaN(categoryId)) {
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
