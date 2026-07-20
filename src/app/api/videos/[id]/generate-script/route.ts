import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getVideo, getUserById, updateVideoRecord } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { videoAccessError } from "@/lib/videoAuth";
import { getShopifyProduct } from "@/lib/shopify";
import { scrapeProductLink } from "@/lib/tiktokProduct";
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
  const shopifyProductId = typeof body.shopify_product_id === "string" ? body.shopify_product_id : "";
  // Alternative to picking from the Shopify catalog — paste any product
  // page URL (own store, AliExpress, Amazon, a TikTok Shop link, whatever)
  // and scrape it the same way the Creation canvas's "paste a product
  // link" card does (src/lib/tiktokProduct.ts, generic Open Graph/JSON-LD
  // scrape, not TikTok-specific despite the file name).
  const productUrl = typeof body.product_url === "string" ? body.product_url.trim() : "";
  if (!shopifyProductId && !productUrl) {
    return NextResponse.json({ error: "shopify_product_id or product_url is required" }, { status: 400 });
  }

  const sessionUser = getCurrentUser();
  const dbUser = sessionUser ? getUserById(sessionUser.userId) : null;

  try {
    // ShopifyProductSummary-shaped either way, so generateScriptForProduct
    // downstream doesn't need to know which source it came from — same
    // pattern as /api/creation/projects/[projectId]/storyboard/generate-product-script's
    // connectedProductNodeId branch.
    let product: { id: string; title: string; handle: string; description: string; tags: string[]; productType: string; imageUrl: string | null };
    if (shopifyProductId) {
      const shopifyProduct = await getShopifyProduct(shopifyProductId);
      if (!shopifyProduct) return NextResponse.json({ error: "Shopify product not found" }, { status: 404 });
      product = shopifyProduct;
    } else {
      const scraped = await scrapeProductLink(productUrl);
      if (!scraped || (!scraped.title && !scraped.description)) {
        return NextResponse.json(
          { error: "Couldn't read product details from that link — try a different product page, or search the Shopify catalog instead." },
          { status: 400 }
        );
      }
      product = {
        id: `link:${uuidv4()}`,
        title: scraped.title || "Untitled product",
        handle: "",
        description: [scraped.description, scraped.price ? `Price: ${scraped.price}` : ""].filter(Boolean).join("\n"),
        tags: [],
        productType: "",
        imageUrl: scraped.imageUrl || null,
      };
    }

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
