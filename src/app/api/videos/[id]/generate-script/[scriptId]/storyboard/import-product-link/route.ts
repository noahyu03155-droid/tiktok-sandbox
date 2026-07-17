import { NextRequest, NextResponse } from "next/server";
import { getVideo } from "@/lib/db";
import { scrapeProductLink } from "@/lib/tiktokProduct";

export const dynamic = "force-dynamic";

// "Paste a TikTok PRODUCT link" on the storyboard canvas — the sibling of
// import-tiktok, but for a product page instead of a video. Runs the
// best-effort Open Graph scrape (see src/lib/tiktokProduct.ts) and returns
// just the scraped fields for the client to patch onto the placeholder
// product card it already created optimistically (same pattern as
// import-tiktok returning just {url}) — nothing is created/saved
// server-side here; the card persists via the normal board autosave.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  const scraped = await scrapeProductLink(url);
  return NextResponse.json({
    productRef: {
      sourceUrl: url,
      title: scraped?.title || "",
      description: scraped?.description || "",
      imageUrl: scraped?.imageUrl || null,
      price: scraped?.price || null,
      rating: scraped?.rating || null,
      soldOrReviews: scraped?.soldOrReviews || null,
      storeName: scraped?.storeName || null,
      scrapeFailed: !scraped,
    },
  });
}
