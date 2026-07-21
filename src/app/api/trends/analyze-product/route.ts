import { NextRequest, NextResponse } from "next/server";
import { fetchProductSalesTrend, fetchProductVideoCount, fetchCreatorStats } from "@/lib/fastmoss";
import { fetchCustomProductTrend, isCustomTrendApiConfigured } from "@/lib/customTrendApi";

export const dynamic = "force-dynamic";

// On-demand, stateless lookup powering a trend card's "AI Analysis" panel —
// deliberately NOT called automatically for every card on every Update
// (FastMoss calls cost real API credits; codeX calls are the user's own).
// The frontend only calls this when a user explicitly expands a card.
//
// Sales trend is codeX-FIRST (fetchCustomProductTrend) with FastMoss as
// fallback — the FastMoss plan lost access to /product/v1/salesTrend (403
// "can not access current endpoint"), which used to kill the whole panel.
// The two secondary lookups (video saturation, creator stats) are FastMoss-
// only and now BEST-EFFORT: if they fail, the panel renders without them
// instead of erroring out entirely.
export async function POST(req: NextRequest) {
  if (!process.env.FASTMOSS_API_KEY && !isCustomTrendApiConfigured()) {
    return NextResponse.json(
      { error: "Neither the custom trend API nor FASTMOSS_API_KEY is configured — can't load product analysis." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const productId = typeof body?.product_id === "string" ? body.product_id.trim() : "";
  const creatorHandle = typeof body?.creator_handle === "string" ? body.creator_handle.trim() : "";
  const daysRaw = Number(body?.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 7;

  if (!productId) {
    return NextResponse.json({ error: "product_id is required" }, { status: 400 });
  }

  try {
    const [customTrend, saturation7d, creatorStats] = await Promise.all([
      isCustomTrendApiConfigured() ? fetchCustomProductTrend(productId, days) : Promise.resolve(null),
      fetchProductVideoCount(productId, 7).catch(() => null),
      creatorHandle ? fetchCreatorStats(creatorHandle).catch(() => null) : Promise.resolve(null),
    ]);

    let salesTrend = customTrend;
    let salesTrendError: string | null = null;
    if (!salesTrend) {
      try {
        salesTrend = await fetchProductSalesTrend(productId, days);
      } catch (e: any) {
        salesTrendError = e?.message || "Sales trend unavailable";
      }
    }

    if (!salesTrend) {
      // Both sources failed — keep the old behavior of surfacing an error,
      // but only when there's genuinely nothing to show.
      return NextResponse.json({ error: salesTrendError || "Sales trend unavailable" }, { status: 502 });
    }

    return NextResponse.json({ salesTrend, saturation7d, creatorStats });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load product analysis" }, { status: 500 });
  }
}
