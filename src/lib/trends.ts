// Shared trend-batch ingestion logic — used by both the manual-paste route
// (POST /api/trends, e.g. when Claude pastes a batch it live-scraped in
// chat) and the one-click FastMoss API update route (POST
// /api/trends/update). Pulled out of the route handler so the two callers
// can't drift apart.

import { v4 as uuidv4 } from "uuid";
import {
  createTrendBatch,
  createVideoRecord,
  findVideoByUrl,
  updateVideoRecord,
} from "@/lib/db";
import { queueFetchAndTranscribe } from "@/lib/fetchQueue";
import type { CreatorInfo, TrendBatch, TrendItem, VideoRecord } from "@/lib/types";

export interface RawTrendItem {
  rank?: number;
  fastmoss_url: string;
  // The actual TikTok video URL to fetch/transcribe. Kept separate from
  // fastmoss_url (meant as the "view on FastMoss" reference link) — falls
  // back to fastmoss_url for backward compatibility if it's already a
  // tiktok.com URL.
  video_url?: string;
  fastmoss_title?: string;
  product_name?: string;
  product_id?: string;
  views?: number;
  likes?: number;
  comments?: number;
  gmv?: string;
  gmv_28d?: string;
  sales?: number | string;
  creator?: CreatorInfo | null;
}

export interface IngestTrendBatchInput {
  category: string;
  category_id?: string | null;
  date_from: string;
  date_to: string;
  days?: number;
  top_by_views: RawTrendItem[];
  top_by_sales: RawTrendItem[];
}

export function ingestTrendBatch(input: IngestTrendBatchInput): TrendBatch {
  const batchId = uuidv4();
  const urlToVideoId = new Map<string, string>();

  function buildItem(raw: RawTrendItem, index: number): TrendItem {
    const fastmossUrl = (raw.fastmoss_url || "").trim();
    const rawVideoUrl = (raw.video_url || "").trim();
    const videoUrl = rawVideoUrl && /tiktok\.com/.test(rawVideoUrl)
      ? rawVideoUrl
      : /tiktok\.com/.test(fastmossUrl)
      ? fastmossUrl
      : "";
    let videoId: string | null = null;

    if (videoUrl) {
      if (urlToVideoId.has(videoUrl)) {
        videoId = urlToVideoId.get(videoUrl) as string;
      } else {
        const existing = findVideoByUrl(videoUrl);
        if (existing) {
          videoId = existing.id;
          const patch: Partial<VideoRecord> = {};
          if (existing.source !== "trend") patch.source = "trend";
          if (raw.creator && !existing.creator) patch.creator = raw.creator;
          if (Object.keys(patch).length > 0) updateVideoRecord(videoId, patch);
          // A previous attempt for this same video may have failed (e.g. the
          // 40-at-once crash) or never actually finished (still "pending"
          // from a run that got interrupted) — retry rather than silently
          // reusing a broken/incomplete record.
          if (existing.status === "error" || existing.status === "pending") {
            queueFetchAndTranscribe(videoId, videoUrl);
          }
        } else {
          videoId = uuidv4();
          createVideoRecord(videoId, videoUrl, { source: "trend", creator: raw.creator ?? null });
          queueFetchAndTranscribe(videoId, videoUrl);
        }
        urlToVideoId.set(videoUrl, videoId);
      }
    }

    return {
      rank: raw.rank ?? index + 1,
      fastmoss_url: fastmossUrl,
      fastmoss_title: raw.fastmoss_title ?? null,
      product_name: raw.product_name ?? null,
      product_id: raw.product_id ?? null,
      views: typeof raw.views === "number" ? raw.views : null,
      likes: typeof raw.likes === "number" ? raw.likes : null,
      comments: typeof raw.comments === "number" ? raw.comments : null,
      gmv: raw.gmv ?? null,
      gmv_28d: raw.gmv_28d ?? null,
      sales: raw.sales ?? null,
      video_id: videoId,
      creator_handle: raw.creator?.handle ?? null,
    };
  }

  const top_by_views = input.top_by_views.map(buildItem);
  const top_by_sales = input.top_by_sales.map(buildItem);

  const batch: TrendBatch = {
    id: batchId,
    category: input.category,
    category_id: input.category_id ?? null,
    date_from: input.date_from,
    date_to: input.date_to,
    days: input.days ?? 7,
    top_by_views,
    top_by_sales,
    created_at: new Date().toISOString(),
  };
  createTrendBatch(batch);
  return batch;
}
