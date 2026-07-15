import { NextRequest, NextResponse } from "next/server";
import { deleteTrendBatch, getVideo, listTrendBatches } from "@/lib/db";
import { ingestTrendBatch } from "@/lib/trends";

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

  const batch = ingestTrendBatch({
    category: body.category,
    date_from: body.date_from,
    date_to: body.date_to,
    top_by_views: body.top_by_views,
    top_by_sales: body.top_by_sales,
  });

  return NextResponse.json({ batch });
}
