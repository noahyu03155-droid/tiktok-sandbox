import { NextRequest, NextResponse } from "next/server";
import { fetchProductSalesTrend, fetchProductVideoCount, fetchCreatorStats } from "@/lib/fastmoss";

export const dynamic = "force-dynamic";

// On-demand, stateless lookup powering a trend card's "AI Analysis" panel —
// deliberately NOT called automatically for every card on every Update
// (each call costs real FastMoss API credits: salesTrend + videoList, plus
// an optional creator/v1/search lookup). The frontend only calls this when
// a user explicitly expands a specific card.
export async function POST(req: NextRequest) {
  if (!process.env.FASTMOSS_API_KEY) {
    return NextResponse.json(
      { error: "FASTMOSS_API_KEY isn't set — see README for how to get one from developers.fastmoss.com." },
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
    const [salesTrend, saturation7d, creatorStats] = await Promise.all([
      fetchProductSalesTrend(productId, days),
      fetchProductVideoCount(productId, 7),
      creatorHandle ? fetchCreatorStats(creatorHandle).catch(() => null) : Promise.resolve(null),
    ]);

    return NextResponse.json({ salesTrend, saturation7d, creatorStats });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load product analysis" }, { status: 500 });
  }
}
