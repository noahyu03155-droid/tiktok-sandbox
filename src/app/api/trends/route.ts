import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  createTrendBatch,
  createVideoRecord,
  deleteTrendBatch,
  findVideoByUrl,
  getVideo,
  listTrendBatches,
  updateVideoRecord,
} from "@/lib/db";
import { queueFetchAndTranscribe } from "@/lib/fetchQueue";
import type { TrendItem, CreatorInfo, VideoRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const batches = listTrendBatches();
  const enriched = batches.map((batch) => ({
    ...batch,
    top_by_views: batch.top_by_views.map((item) => ({
      ...item,
      video: item.video_id ? getVideo(item.video_id) : null,
    })),
    top_by_sales: batch.top_by_sales.map((item) => ({
      ...item,
      video: item.video_id ? getVideo(item.video_id) : null,
    })),
  }));
  return NextResponse.json({ batches: enriched });
}

interface RawItem {
  rank?: number;
  fastmoss_url: string;
  // The actual TikTok video URL to fetch/transcribe. Kept separate from
  // fastmoss_url (which is meant as the "view on FastMoss" reference link)
  // — previously these were conflated into fastmoss_url itself, which only
  // worked when that happened to be a tiktok.com URL and otherwise silently
  // left video_id null (no thumbnail, no click-through). Falls back to
  // fastmoss_url for backward compatibility if it's already a tiktok.com URL.
  video_url?: string;
  fastmoss_title?: string;
  product_name?: string;
  views?: number;
  likes?: number;
  comments?: number;
  gmv?: string;
  gmv_28d?: string;
  sales?: number | string;
  // Optional FastMoss creator/profile info to attach to the video record
  // when one gets created for this item (see CreatorInfo).
  creator?: CreatorInfo | null;
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing ?id=" }, { status: 400 });
  }
  deleteTrendBatch(id);
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (
    !body ||
    !body.category ||
    !body.date_from ||
    !body.date_to ||
    !Array.isArray(body.top_by_views) ||
    !Array.isArray(body.top_by_sales)
  ) {
    return NextResponse.json(
      { error: "Body must include category, date_from, date_to, top_by_views[], top_by_sales[]" },
      { status: 400 }
    );
  }

  const batchId = uuidv4();
  const urlToVideoId = new Map<string, string>();

  function buildItem(raw: RawItem, index: number): TrendItem {
    const fastmossUrl = (raw.fastmoss_url || "").trim();
    // Prefer an explicit video_url; fall back to fastmoss_url for callers
    // that (as before) pass the TikTok URL directly in that field.
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
          // 40-at-once crash) or never actually finished (still "pending" from
          // a run that got interrupted) — retry it rather than silently
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
      views: typeof raw.views === "number" ? raw.views : null,
      likes: typeof raw.likes === "number" ? raw.likes : null,
      comments: typeof raw.comments === "number" ? raw.comments : null,
      gmv: raw.gmv ?? null,
      gmv_28d: raw.gmv_28d ?? null,
      sales: raw.sales ?? null,
      video_id: videoId,
    };
  }

  const top_by_views = (body.top_by_views as RawItem[]).map(buildItem);
  const top_by_sales = (body.top_by_sales as RawItem[]).map(buildItem);

  const batch = {
    id: batchId,
    category: body.category,
    date_from: body.date_from,
    date_to: body.date_to,
    top_by_views,
    top_by_sales,
    created_at: new Date().toISOString(),
  };
  createTrendBatch(batch);

  return NextResponse.json({ batch });
}
