// Best-effort generic product-link preview scraper — prefers STRUCTURED
// sources (JSON-LD Product blocks, then product:price/og:price meta tags)
// and only falls back to a blind whole-page currency regex as a last
// resort, since that regex used to be the ONLY mechanism and happily
// matched an unrelated "$1" (a coupon, shipping-insurance upsell, review
// snippet...) long before reaching the real price.
//
// Honesty note: this is NOT a TikTok Shop API integration (none exists / is
// accessible from this codebase). TikTok Shop product pages are heavily
// JS-rendered SPAs, so even the structured-data extraction below will often
// come back empty for TikTok Shop specifically — the structured paths
// mainly help generic/other e-commerce product pages that DO server-render
// JSON-LD or price meta tags. TikTok Shop links will still commonly need
// the user to fill the fields in by hand; callers must treat a null/mostly-
// empty result as expected and fall back to letting the user edit the card
// (see productRef.scrapeFailed — that UX is unchanged).
export interface ScrapedProductData {
  title: string;
  description: string;
  imageUrl: string | null;
  price: string | null;
  // Best-effort extras, null when nothing structured was found:
  // aggregateRating.ratingValue, e.g. "4.6".
  rating: string | null;
  // Labeled generically on purpose — a true "sold count" is essentially
  // never available via generic scraping, so when present this is really an
  // aggregate review-count proxy (aggregateRating.reviewCount).
  soldOrReviews: string | null;
  // brand.name from the JSON-LD Product block, when present.
  storeName: string | null;
}

// Currency code -> display prefix for assembling a price string from
// structured data. JPY/CNY intentionally map to no prefix (the "¥" glyph is
// ambiguous between them); anything unrecognized defaults to "$".
function currencyPrefix(code: string | null | undefined): string {
  if (!code) return "$";
  const upper = code.toUpperCase();
  if (upper === "USD") return "$";
  if (upper === "GBP") return "£";
  if (upper === "EUR") return "€";
  if (upper === "JPY" || upper === "CNY") return "";
  return "$";
}

// Finds the first JSON-LD block describing a Product. Some sites emit
// several <script type="application/ld+json"> blocks (and some are
// malformed), so each parse failure is skipped rather than fatal; a block
// can also be a bare object, an array, or an @graph wrapper, and "@type"
// itself can be a string or an array.
function findJsonLdProduct(html: string): Record<string, any> | null {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of blocks) {
    let parsed: any;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const candidates: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.["@graph"])
      ? parsed["@graph"]
      : [parsed];
    for (const entry of candidates) {
      if (!entry || typeof entry !== "object") continue;
      const type = entry["@type"];
      if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return entry;
    }
  }
  return null;
}

export async function scrapeProductLink(url: string): Promise<ScrapedProductData | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; COTORXBot/1.0; +product-link-preview)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    function meta(prop: string): string | null {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
      const m = html.match(re);
      return m ? m[1].trim() : null;
    }

    let price: string | null = null;
    let rating: string | null = null;
    let soldOrReviews: string | null = null;
    let storeName: string | null = null;
    let ldTitle: string | null = null;

    // 1) JSON-LD Product block — the most trustworthy source when present.
    const product = findJsonLdProduct(html);
    if (product) {
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      const rawPrice = offers?.price;
      if (rawPrice !== undefined && rawPrice !== null && `${rawPrice}`.trim() !== "") {
        price = `${currencyPrefix(typeof offers?.priceCurrency === "string" ? offers.priceCurrency : null)}${`${rawPrice}`.trim()}`;
      }
      const ratingValue = product.aggregateRating?.ratingValue;
      if (ratingValue !== undefined && ratingValue !== null && `${ratingValue}`.trim() !== "") {
        rating = `${ratingValue}`.trim();
      }
      const reviewCount = product.aggregateRating?.reviewCount;
      if (reviewCount !== undefined && reviewCount !== null && `${reviewCount}`.trim() !== "") {
        soldOrReviews = `${reviewCount} reviews`;
      }
      if (typeof product.brand === "string" && product.brand.trim()) {
        storeName = product.brand.trim();
      } else if (typeof product.brand?.name === "string" && product.brand.name.trim()) {
        storeName = product.brand.name.trim();
      }
      if (typeof product.name === "string" && product.name.trim()) {
        ldTitle = product.name.trim();
      } else if (storeName) {
        // brand.name as a last-ditch title stand-in when the block has no name.
        ldTitle = storeName;
      }
    }

    // 2) Price meta tags (product:price:amount / og:price:amount) — second
    //    choice, still structured (same meta() helper as the OG tags below).
    if (!price) {
      const amount = meta("product:price:amount") || meta("og:price:amount");
      if (amount) {
        const currency = meta("product:price:currency") || meta("og:price:currency");
        price = `${currencyPrefix(currency)}${amount}`;
      }
    }

    // 3) Last resort ONLY: the old blind currency-regex scan over the whole
    //    raw HTML. Kept because it's better than nothing, but it's exactly
    //    the mechanism that scraped "$1" off an unrelated page element when
    //    the real listed price was $28.00 — hence steps 1 and 2 above.
    if (!price) {
      const priceMatch = html.match(/[$¥£€]\s?\d+(?:[.,]\d{2})?/);
      price = priceMatch ? priceMatch[0] : null;
    }

    const title = meta("og:title") || meta("twitter:title") || ldTitle || "";
    const description = meta("og:description") || meta("twitter:description") || "";
    const imageUrl = meta("og:image") || meta("twitter:image") || null;

    if (!title && !description) return null;
    return { title, description, imageUrl, price, rating, soldOrReviews, storeName };
  } catch {
    return null;
  }
}
