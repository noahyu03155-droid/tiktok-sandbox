import { NextRequest, NextResponse } from "next/server";
import { getTrackedCreator, updateTrackedCreator } from "@/lib/db";
import type { CreatorAffiliateStats } from "@/lib/types";

export const dynamic = "force-dynamic";

function num(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

// Ingests aggregate performance stats scraped live from TikTok Shop's own
// Seller Center -> Affiliate Center -> creator-detail page (PPS, GMV, GPM,
// video count/avg views/engagement, follower demographics). Separate from
// /api/creators/[id]/import, which handles the FastMoss per-video product
// breakdown — these are two independent data sources with their own
// scrape cadence.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const demographics = body.demographics
    ? {
        male_pct: num(body.demographics.male_pct),
        female_pct: num(body.demographics.female_pct),
        age_18_24_pct: num(body.demographics.age_18_24_pct),
        age_25_34_pct: num(body.demographics.age_25_34_pct),
        age_35_44_pct: num(body.demographics.age_35_44_pct),
        age_45_54_pct: num(body.demographics.age_45_54_pct),
        age_55_plus_pct: num(body.demographics.age_55_plus_pct),
      }
    : null;

  const affiliate: CreatorAffiliateStats = {
    pps_score: num(body.pps_score),
    window_from: body.window_from ?? null,
    window_to: body.window_to ?? null,
    gmv: num(body.gmv),
    items_sold: num(body.items_sold),
    gpm: num(body.gpm),
    video_gpm: num(body.video_gpm),
    videos_count: num(body.videos_count),
    avg_video_views: num(body.avg_video_views),
    avg_engagement_rate: num(body.avg_engagement_rate),
    est_post_rate: num(body.est_post_rate),
    avg_commission_rate: num(body.avg_commission_rate),
    products_count: num(body.products_count),
    brand_collaborations: num(body.brand_collaborations),
    demographics,
    scraped_at: new Date().toISOString(),
  };

  const patch: { affiliate: CreatorAffiliateStats; name?: string; avatar_url?: string; followers?: number } = { affiliate };
  if (typeof body.name === "string" && body.name) patch.name = body.name;
  if (typeof body.avatar_url === "string" && body.avatar_url) patch.avatar_url = body.avatar_url;
  if (typeof body.followers === "number") patch.followers = body.followers;

  updateTrackedCreator(params.id, patch);
  return NextResponse.json({ creator: getTrackedCreator(params.id) });
}
