// Best-effort generic product-link preview scraper — parses standard Open
// Graph / Twitter Card meta tags from the target page's server-rendered
// HTML. This is NOT a TikTok Shop API integration (none exists / is
// accessible from this codebase) — it's a generic technique that happens to
// work for many e-commerce product pages, TikTok Shop included WHEN its
// pages happen to server-render OG tags, but will often return null/partial
// data for JS-rendered SPA product pages. Callers must treat a null/mostly-
// empty result as expected and fall back to letting the user fill in
// product details by hand (see productRef.scrapeFailed).
export interface ScrapedProductData {
  title: string;
  description: string;
  imageUrl: string | null;
  price: string | null;
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

    const title = meta("og:title") || meta("twitter:title") || "";
    const description = meta("og:description") || meta("twitter:description") || "";
    const imageUrl = meta("og:image") || meta("twitter:image") || null;
    const priceMatch = html.match(/[$¥£€]\s?\d+(?:[.,]\d{2})?/);
    const price = priceMatch ? priceMatch[0] : null;

    if (!title && !description) return null;
    return { title, description, imageUrl, price };
  } catch {
    return null;
  }
}
