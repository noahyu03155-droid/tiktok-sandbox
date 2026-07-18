import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getVideo, getUserById, updateVideoRecord } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { videoAccessError } from "@/lib/videoAuth";
import { getShopifyProduct } from "@/lib/shopify";
import { generateScriptForProduct } from "@/lib/scriptgen";
import type { GeneratedScript } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });
  if (!video.analysis) {
    return NextResponse.json({ error: "This video hasn't been broken down yet — run the breakdown first" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const shopifyProductId = body.shopify_product_id;
  if (!shopifyProductId) {
    return NextResponse.json({ error: "shopify_product_id is required" }, { status: 400 });
  }

  const sessionUser = getCurrentUser();
  const dbUser = sessionUser ? getUserById(sessionUser.userId) : null;

  try {
    const product = await getShopifyProduct(shopifyProductId);
    if (!product) return NextResponse.json({ error: "Shopify product not found" }, { status: 404 });

    const stages = await generateScriptForProduct({
      videoTitle: video.title || video.source_url,
      analysis: video.analysis,
      product,
      creatorProfile: dbUser?.creatorProfile || null,
    });

    const script: GeneratedScript = {
      id: uuidv4(),
      shopify_product_id: product.id,
      shopify_product_title: product.title,
      stages,
      created_at: new Date().toISOString(),
    };

    updateVideoRecord(params.id, { generated_scripts: [...video.generated_scripts, script] });

    return NextResponse.json({ script });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
