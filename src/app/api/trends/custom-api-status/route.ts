import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// Admin-only diagnostic for the codeX integration — exists because every
// failure in the custom-API path is deliberately silent-with-fallback
// (FastMoss serves whatever it can), which makes "is codeX actually being
// used?" impossible to tell from the UI. Confirmed failure mode this was
// built for: a 401 "invalid or expired API key" quietly turning every pull
// into the FastMoss pet-category fallback, which the user experienced as
// "wrong categories / only 5 products". Never returns the key itself —
// only its length/prefix and the live HTTP results of calling codeX with it.
export async function GET() {
  const sessionUser = getCurrentUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const base = (process.env.CUSTOM_TREND_API_URL || "").replace(/\/+$/, "");
  const key = process.env.CUSTOM_TREND_API_KEY || "";
  const headerName = process.env.CUSTOM_TREND_API_KEY_HEADER || "X-API-Key";

  const config = {
    urlConfigured: Boolean(base),
    url: base || null,
    keyConfigured: Boolean(key),
    keyPrefix: key ? `${key.slice(0, 8)}…(${key.length} chars)` : null,
    headerName,
  };
  if (!base || !key) {
    return NextResponse.json({
      config,
      verdict: "NOT CONFIGURED — CUSTOM_TREND_API_URL / CUSTOM_TREND_API_KEY missing from the environment. If you just edited .env, restart the dev server (env files are only read at startup).",
    });
  }

  const headers: Record<string, string> = {
    [headerName]: headerName.toLowerCase() === "authorization" ? `Bearer ${key}` : key,
  };

  async function probe(path: string) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(`${base}${path}`, { headers, signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      const body: any = await res.json().catch(() => null);
      return {
        path,
        status: res.status,
        total: body?.total ?? null,
        listLength: Array.isArray(body?.list) ? body.list.length : null,
        firstItemKeys: Array.isArray(body?.list) && body.list[0] ? Object.keys(body.list[0]) : null,
        detail: body?.detail ?? null,
      };
    } catch (e: any) {
      return { path, status: null, error: e?.message || String(e) };
    }
  }

  const categories = await probe("/v1/rank/categories");
  const products = await probe("/v1/products/rank?period=week&region=US&category_id=all&page=1&page_size=50&order_by=units_sold");
  const videos = await probe("/v1/videos/rank?period=week&region=US&category_id=all&page=1&page_size=30&order_by=play_count");

  const authFailed = [categories, products, videos].some((p) => p.status === 401 || p.status === 403);
  const verdict = authFailed
    ? "AUTH FAILED — codeX rejected the configured key (invalid/expired). Every trend pull is silently falling back to FastMoss right now. Generate a fresh key in codeX and update CUSTOM_TREND_API_KEY (+ restart)."
    : categories.status === 200 && products.status === 200
    ? `OK — codeX reachable and authorized. products list=${products.listLength}, videos list=${videos.listLength}, categories total=${categories.total}.`
    : "PARTIAL/FAILED — see individual probe results below.";

  return NextResponse.json({ config, verdict, categories, products, videos });
}
