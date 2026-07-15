import { NextRequest, NextResponse } from "next/server";
import { searchShopifyProducts } from "@/lib/shopify";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") || "";
  try {
    const products = await searchShopifyProducts(q, 15);
    return NextResponse.json({ products });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
