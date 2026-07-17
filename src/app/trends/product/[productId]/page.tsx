"use client";

// A dedicated "click into a product" detail page, in the spirit of
// FastMoss's own product analytics page (stat cards, a sales/GMV trend
// chart, tabbed sections, a date-range selector). Reuses the same
// /api/trends/analyze-product endpoint ProductCard's inline "AI Analysis"
// panel already calls (fetchProductSalesTrend/fetchProductVideoCount/
// fetchCreatorStats in fastmoss.ts) — this page just gives that same data a
// full page instead of a cramped card, plus a real two-line chart instead of
// a single-metric sparkline.
//
// Deliberately does NOT try to fake the deeper FastMoss-only breakdowns the
// reference screenshots showed (SKU analysis, ad/organic traffic split,
// VOC consumer insights, similar products, reviews) — FastMoss's public
// Open API (see fastmoss.ts) has no documented endpoint for any of those,
// only the product-level sales trend / video count / creator stats already
// used here. Those sections are shown as visibly disabled tabs (matching the
// reference's tab-bar layout) with an honest "not available" note, rather
// than displaying invented numbers.
//
// This page is intentionally client-only with no server-side product
// lookup: the click-through from ProductCard passes everything it already
// has (title/image/price/rank/creator handle/category) as query params, so
// there's no need for a new "look up a product by id" persistence layer —
// products only ever exist as line items inside a TrendBatch.

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/translations";
import { formatCompactNumber } from "@/lib/format";

interface ProductAnalysis {
  salesTrend: {
    list: { dt: string; units_sold: number; gmv: number }[];
    overview: {
      units_sold: number;
      gmv: number;
      live_count: number;
      creator_count: number;
      aweme_count: number;
      currency: string;
      region: string;
    };
  };
  saturation7d: number;
  creatorStats: { day28_gmv: number | null; day28_units_sold: number | null; currency: string | null } | null;
}

const DAY_OPTIONS = [7, 14, 28] as const;

// Tabs that would need data FastMoss's public Open API doesn't expose at
// the product level — kept visible-but-disabled so the page's layout still
// reads like the reference (a tab bar), rather than silently omitting them.
const UNAVAILABLE_TABS: { key: string; labelKey: TranslationKey }[] = [
  { key: "sku", labelKey: "trendProductTabSku" },
  { key: "creators", labelKey: "trendProductTabCreators" },
  { key: "ads", labelKey: "trendProductTabAds" },
  { key: "voc", labelKey: "trendProductTabVoc" },
  { key: "similar", labelKey: "trendProductTabSimilar" },
];

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel border border-edge rounded-xl p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-2xl font-semibold text-zinc-900 mt-1">{value}</p>
    </div>
  );
}

// Dependency-free dual-line SVG chart — units_sold (brand blue) and gmv
// (amber) plotted on their own independently-scaled axes so one metric's
// larger magnitude doesn't flatten the other, with a small legend since two
// lines need one (unlike ProductCard's single-metric sparkline).
function DualLineChart({ points }: { points: { dt: string; units_sold: number; gmv: number }[] }) {
  const { t } = useLocale();
  if (points.length === 0) return null;
  const w = 640;
  const h = 200;
  const pad = 8;

  function lineFor(values: number[]) {
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const stepX = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
    return values.map((v, i) => ({
      x: pad + i * stepX,
      y: pad + (h - pad * 2) - ((v - min) / range) * (h - pad * 2),
    }));
  }

  const salesLine = lineFor(points.map((p) => p.units_sold));
  const gmvLine = lineFor(points.map((p) => p.gmv));
  const salesPoints = salesLine.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const gmvPoints = gmvLine.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-[11px]">
        <span className="flex items-center gap-1.5 text-zinc-600">
          <span className="w-2.5 h-2.5 rounded-full bg-brand-500 inline-block" /> {t("trendSales")}
        </span>
        <span className="flex items-center gap-1.5 text-zinc-600">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /> {t("trendGMV")}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="block">
        <polyline points={gmvPoints} fill="none" stroke="#f59e0b" strokeWidth={2} />
        <polyline points={salesPoints} fill="none" stroke="#2fb6ea" strokeWidth={2} />
      </svg>
      <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-1">
        <span>{points[0]?.dt}</span>
        <span>{points[points.length - 1]?.dt}</span>
      </div>
    </div>
  );
}

export default function ProductDetailPage() {
  const { t } = useLocale();
  const params = useParams<{ productId: string }>();
  const searchParams = useSearchParams();
  const productId = decodeURIComponent(String(params.productId || ""));

  const title = searchParams.get("title") || "";
  const image = searchParams.get("image");
  const price = searchParams.get("price");
  const rank = searchParams.get("rank");
  const creatorHandle = searchParams.get("creator") || "";
  const categoryLabel = searchParams.get("category") || "";
  const recommendationScore = searchParams.get("score");
  const initialDaysRaw = Number(searchParams.get("days"));

  const [days, setDays] = useState<number>(
    (DAY_OPTIONS as readonly number[]).includes(initialDaysRaw) ? initialDaysRaw : 28
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ProductAnalysis | null>(null);

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/trends/analyze-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: productId, creator_handle: creatorHandle || undefined, days }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) throw new Error(data.error || "Failed to load product analysis");
        setAnalysis(data);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || "Failed to load product analysis");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, creatorHandle, days]);

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/trends" className="text-sm text-zinc-500 hover:text-zinc-900">
        {t("trendProductBackToList")}
      </Link>

      <div className="flex items-start gap-4 mt-4">
        <div className="w-24 h-24 rounded-xl overflow-hidden bg-panel2 shrink-0 relative">
          {rank && (
            <span className="absolute top-1 left-1 z-10 text-[10px] font-bold text-white bg-black/80 rounded-full px-1.5 py-0.5 leading-none">
              🔥 #{rank}
            </span>
          )}
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-3xl">🛍</div>
          )}
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-zinc-900 leading-snug">{title || t("trendProductUntitled")}</h1>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {price && <p className="text-brand-500 font-semibold text-sm">{price}</p>}
            {categoryLabel && <p className="text-xs text-zinc-500">{categoryLabel}</p>}
          </div>
          {recommendationScore && (
            <p className="text-xs text-zinc-500 mt-1.5">
              {t("trendRecommendationScore", { score: recommendationScore })}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-8 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">{t("trendProductOverviewTab")}</h2>
        <div className="flex items-center gap-1 bg-panel border border-edge rounded-lg p-1">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                days === d ? "bg-brand-500 text-white" : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {d}D
            </button>
          ))}
        </div>
      </div>

      {loading && !analysis && <p className="text-sm text-yellow-600 animate-pulse mt-4">{t("trendAnalysisLoading")}</p>}
      {error && <p className="text-sm text-red-400 mt-4">{error}</p>}

      {analysis && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            <StatCard label={t("trendGMV")} value={`$${formatCompactNumber(analysis.salesTrend.overview.gmv)}`} />
            <StatCard label={t("trendSales")} value={formatCompactNumber(analysis.salesTrend.overview.units_sold)} />
            <StatCard label={t("trendRelatedCreators")} value={formatCompactNumber(analysis.salesTrend.overview.creator_count)} />
            <StatCard label={t("trendRelatedVideos")} value={formatCompactNumber(analysis.salesTrend.overview.aweme_count)} />
            <StatCard label={t("trendRelatedLives")} value={formatCompactNumber(analysis.salesTrend.overview.live_count)} />
            <StatCard label={t("trendSaturation7d")} value={String(analysis.saturation7d)} />
            {analysis.creatorStats?.day28_gmv != null && (
              <StatCard label={t("trendCreatorGmv28d")} value={`$${formatCompactNumber(analysis.creatorStats.day28_gmv)}`} />
            )}
          </div>

          <div className="bg-panel border border-edge rounded-xl p-4 mt-4">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">{t("trendProductTrendChart")}</p>
            <DualLineChart points={analysis.salesTrend.list} />
          </div>
        </>
      )}

      <div className="mt-10 pt-6 border-t border-edge">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">{t("trendProductMoreAnalysis")}</p>
        <div className="flex flex-wrap gap-2">
          {UNAVAILABLE_TABS.map((tab) => (
            <span
              key={tab.key}
              className="text-xs px-3 py-1.5 rounded-lg border border-dashed border-edge2 text-zinc-400 cursor-not-allowed select-none"
            >
              {t(tab.labelKey)}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-zinc-500 mt-2">{t("trendProductTabUnavailable")}</p>
      </div>
    </div>
  );
}
