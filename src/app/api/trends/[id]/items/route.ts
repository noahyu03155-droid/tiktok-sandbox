import { NextRequest, NextResponse } from "next/server";
import { listTrendBatches, updateTrendBatch } from "@/lib/db";

export const dynamic = "force-dynamic";

// Removes specific ranked entries from a trend batch (used by the Trend
// Analysis board's select-and-delete mode) — distinct from DELETE
// /api/trends?id=, which removes the whole batch. Only the trend-list
// entries are removed; the underlying VideoRecord (if any got hydrated)
// stays around, same as when a whole batch is deleted.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const batch = listTrendBatches().find((b) => b.id === params.id);
  if (!batch) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const items: { metric?: string; rank?: number }[] = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return NextResponse.json({ error: "Body must include items[] of { metric, rank }" }, { status: 400 });
  }

  const viewRanks = new Set(items.filter((i) => i.metric === "views").map((i) => i.rank));
  const salesRanks = new Set(items.filter((i) => i.metric === "sales").map((i) => i.rank));

  updateTrendBatch(params.id, {
    top_by_views: batch.top_by_views.filter((it) => !viewRanks.has(it.rank)),
    top_by_sales: batch.top_by_sales.filter((it) => !salesRanks.has(it.rank)),
  });

  return NextResponse.json({ ok: true });
}
