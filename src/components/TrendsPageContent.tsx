"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import { formatCompactNumber, STATUS_KEY } from "@/lib/format";
import type { TrendItem, VideoRecord } from "@/lib/types";
import FavoriteButton from "./FavoriteButton";

interface EnrichedItem extends TrendItem {
  video: VideoRecord | null;
}

// Shared favorites state for both card types on this page (TrendCard's
// video favorites + ProductCard's product favorites). Provided once by the
// top-level TrendsPageContent component and consumed via useContext inside
// TrendCard/ProductCard — avoids threading favorites props through
// TrendSection, which renders both card types and is called from several
// places in this file (the "For You" section plus every per-batch
// views/sales section).
const FavoritesContext = createContext<{
  videoIds: Set<string>;
  productIds: Set<string>;
  toggleVideo: (id: string) => void;
  toggleProduct: (item: EnrichedItem) => void;
} | null>(null);

interface EnrichedBatch {
  id: string;
  category: string;
  date_from: string;
  date_to: string;
  top_by_views: EnrichedItem[];
  top_by_sales: EnrichedItem[];
  created_at: string;
}

// FastMoss category tree node, as returned by /api/trends/fastmoss-categories
// (up to 3 levels deep; leaf nodes omit `sub`).
interface CategoryNode {
  c_code: string;
  c_name: string;
  sub?: CategoryNode[];
}

// Status of the background category-cleanup scan, as returned by
// GET/POST /api/trends/fastmoss-categories/scan.
interface CategoryScanStatus {
  status: "idle" | "running" | "done" | "error";
  total: number;
  tested: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

// Status of the scheduled full-catalog trend refresh (see
// src/lib/fastmossFullRefresh.ts), as returned by GET /api/trends/full-refresh.
interface FullRefreshStatus {
  status: "idle" | "running" | "done" | "error";
  total: number;
  processed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  lastPersistedRun: {
    finishedAt: string;
    categoriesProcessed: number;
    categoriesTotal: number;
    status: "done" | "error";
    error?: string | null;
  } | null;
}

// Response shape of POST /api/trends/analyze-product.
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

type Metric = "views" | "sales";

function selKey(batchId: string, metric: Metric, rank: number) {
  return `${batchId}:${metric}:${rank}`;
}

// Dependency-free inline SVG area chart for the on-demand product sales
// trend (daily GMV) — filled gradient under the line, same accent (brand-400
// #5cc4ee) used for connection lines in StoryboardCanvas.tsx. Redesigned
// (was a bare polyline) to read at a glance the way a real analytics
// dashboard's revenue chart does: a filled area, plus a big total-with-%-
// change header above it, rather than just a thin trend line.
function SalesTrendChart({ points }: { points: { dt: string; units_sold: number; gmv: number }[] }) {
  const { t } = useLocale();
  if (points.length === 0) return null;
  const w = 240;
  const h = 48;
  const values = points.map((p) => p.gmv);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = points.length > 1 ? w / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = h - ((p.gmv - min) / range) * h;
    return { x, y };
  });
  const linePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPoints = `0,${h} ${linePoints} ${w},${h}`;

  const total = values.reduce((sum, v) => sum + v, 0);
  // % change: last week vs. the week before it when there's enough history,
  // otherwise just last point vs. first point — same "is this trending up
  // or down" signal either way, just the sharpest window available.
  let pctChange: number | null = null;
  if (values.length >= 14) {
    const prevWeek = values.slice(-14, -7).reduce((s, v) => s + v, 0);
    const lastWeek = values.slice(-7).reduce((s, v) => s + v, 0);
    if (prevWeek > 0) pctChange = ((lastWeek - prevWeek) / prevWeek) * 100;
  } else if (values.length >= 2 && values[0] > 0) {
    pctChange = ((values[values.length - 1] - values[0]) / values[0]) * 100;
  }

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-semibold text-zinc-900">
          ${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
        {pctChange != null && (
          <span className={`text-[10px] font-medium ${pctChange >= 0 ? "text-green-600" : "text-red-500"}`}>
            {pctChange >= 0 ? "▲" : "▼"} {Math.abs(pctChange).toFixed(1)}%
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="block">
        <defs>
          <linearGradient id="trendRevenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5cc4ee" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#5cc4ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill="url(#trendRevenueFill)" stroke="none" />
        <polyline points={linePoints} fill="none" stroke="#5cc4ee" strokeWidth={1.5} />
      </svg>
      <div className="flex items-center justify-between text-[9px] text-zinc-500 mt-0.5">
        <span>{points[0]?.dt}</span>
        <span>{points[points.length - 1]?.dt}</span>
      </div>
    </div>
  );
}

// Horizontal "how saturated is this product right now" gauge — turns the
// bare saturation7d count (videos posted promoting this product in the last
// 7 days) into a filled bar plus a plain-language low/moderate/high read,
// instead of just a number. Scale is a soft cap at 40 posts/week (rare to
// see more than that even for a very hot product), clamped so an
// exceptionally saturated product still shows a full bar rather than
// overflowing.
function SaturationBar({ count }: { count: number }) {
  const { t } = useLocale();
  const pct = Math.min(100, Math.round((count / 40) * 100));
  const level = count <= 10 ? "low" : count <= 25 ? "medium" : "high";
  const color = level === "low" ? "#22c55e" : level === "medium" ? "#f59e0b" : "#ef4444";
  const levelLabel =
    level === "low" ? t("trendSaturationLow") : level === "medium" ? t("trendSaturationMedium") : t("trendSaturationHigh");
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-semibold text-zinc-900">{count}</span>
        <span className="text-[10px] font-medium" style={{ color }}>
          {levelLabel}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-panel2 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function TrendCard({
  item,
  metric,
  selectMode,
  selected,
  onToggleSelect,
}: {
  item: EnrichedItem;
  metric: Metric;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { t } = useLocale();
  const favorites = useContext(FavoritesContext);

  // On-demand "AI Analysis" panel — deliberately NOT auto-loaded (each fetch
  // spends real FastMoss API credits); only fetched the first time this
  // card's panel is expanded, then cached in local state.
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ProductAnalysis | null>(null);

  // "Add to Creation" — imports this trending video into the user's own
  // default Creation canvas (see /api/creation/import-trend-video). Per-card
  // local state, same pattern as the AI-analysis panel above.
  const [addState, setAddState] = useState<"idle" | "adding" | "added" | "error">("idle");
  const [addedProjectId, setAddedProjectId] = useState<string | null>(null);

  async function handleAddToCreation(e: React.MouseEvent) {
    // Same as toggleAnalysis: the whole card body sits inside a <Link> (or a
    // click-to-select div in select mode) — don't let this button navigate.
    e.preventDefault();
    e.stopPropagation();
    if (!item.video || addState === "adding" || addState === "added") return;
    setAddState("adding");
    try {
      const res = await fetch("/api/creation/import-trend-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoRecordId: item.video.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.projectId) throw new Error(data.error || "Import failed");
      setAddedProjectId(data.projectId);
      setAddState("added");
    } catch {
      setAddState("error");
    }
  }

  async function toggleAnalysis(e: React.MouseEvent) {
    // The whole card body sits inside a <Link> (or a click-to-select div in
    // select mode) — don't let this button navigate/select.
    e.preventDefault();
    e.stopPropagation();
    if (analysisOpen) {
      setAnalysisOpen(false);
      return;
    }
    setAnalysisOpen(true);
    if (analysis || analysisLoading) return; // already loaded or in flight, don't refetch
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const res = await fetch("/api/trends/analyze-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: item.product_id,
          creator_handle: item.creator_handle || undefined,
          days: 28,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setAnalysis(data);
    } catch (err: any) {
      setAnalysisError(err.message || "Analysis failed");
    } finally {
      setAnalysisLoading(false);
    }
  }

  const video = item.video;
  const status = video?.status;
  const isBusy = video ? !["done", "error"].includes(status as string) : false;
  const thumb = video?.thumbnail_path ? `/api/media/${video.thumbnail_path.split(/[\\/]/).pop()}` : null;
  const statusLabel = status ? t(STATUS_KEY[status] as any) : "";

  const views = item.views ?? video?.stats?.play_count ?? null;
  const likes = item.likes ?? video?.stats?.digg_count ?? null;
  const comments = item.comments ?? video?.stats?.comment_count ?? null;
  // GMV row: sales-ranked lists always carry item.gmv for the window; the
  // views-ranked list falls back to the trailing-28-day figure so the row
  // still has something to show. No sparkline — we only ever have a
  // point-in-time snapshot, not daily history (see chat).
  const gmvPrimary = item.gmv ?? item.gmv_28d ?? null;
  // Prefer the real TikTok video link (webpage_url is the yt-dlp-resolved
  // canonical page, source_url whatever was originally pulled in) over
  // FastMoss's own video-detail page, so the "open in new window" icon
  // takes the user to the actual TikTok video, not a FastMoss wrapper page.
  const outboundUrl = video?.webpage_url || video?.source_url || item.fastmoss_url || null;
  const profileUrl = video?.creator?.profile_url || null;

  const body = (
    <div
      className={`group block rounded-xl overflow-hidden bg-panel border transition-colors ${
        selectMode && selected ? "border-brand-500" : "border-edge hover:border-brand-500"
      }`}
    >
      <div className="relative aspect-[9/16] bg-panel2">
        {selectMode && (
          <div
            className={`absolute top-2 right-2 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
              selected ? "bg-brand-500 border-brand-500" : "bg-black/50 border-zinc-400"
            }`}
          >
            {selected && <span className="text-white text-[10px] leading-none">✓</span>}
          </div>
        )}
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={item.fastmoss_title || ""} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-500 text-xs px-3 text-center">
            {video ? (isBusy ? statusLabel : t("noThumbnail")) : t("noThumbnail")}
          </div>
        )}
        {isBusy && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <span className="text-xs text-white bg-black/50 px-3 py-1 rounded-full animate-pulse">
              {statusLabel}
            </span>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 bg-red-950/70 flex items-center justify-center p-3">
            <span className="text-xs text-red-200 text-center">{t("breakdownFailed")}</span>
          </div>
        )}

        {/* top-left: rank badge (fire) + a view-count pill underneath it */}
        <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
          <span className="flex items-center gap-0.5 text-[11px] font-bold text-white bg-black/80 rounded-full px-2 py-1 leading-none">
            🔥 #{item.rank}
          </span>
          {views != null && (
            <span className="text-[10px] font-medium text-white bg-black/70 rounded-full px-2 py-0.5 leading-none whitespace-nowrap">
              +{formatCompactNumber(views)}
            </span>
          )}
        </div>

        {/* top-right: AI breakdown pill + favorite + outbound link (hidden in select mode to avoid clutter) */}
        {!selectMode && (
          <div className="absolute top-2 right-2 flex items-center gap-1">
            {video?.analysis && (
              <span className="text-[10px] font-medium text-white bg-black/70 px-2 py-1 rounded-full leading-none">
                🧠 AI
              </span>
            )}
            {video && favorites && (
              <FavoriteButton
                favorited={favorites.videoIds.has(video.id)}
                onToggle={() => favorites.toggleVideo(video.id)}
                title={favorites.videoIds.has(video.id) ? t("favoriteRemove") : t("favoriteAdd")}
              />
            )}
            {outboundUrl && (
              <a
                href={outboundUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={outboundUrl}
                className="text-[10px] font-medium text-white bg-black/70 hover:bg-black/90 w-6 h-6 rounded-full flex items-center justify-center leading-none"
              >
                ↗
              </a>
            )}
          </div>
        )}

        {/* bottom-right: compact stat overlay */}
        {!isBusy && status !== "error" && (
          <div className="absolute bottom-2 right-2 flex flex-col items-end gap-1">
            <div className="flex items-center gap-2 text-[10px] font-medium text-white bg-black/70 px-2 py-0.5 rounded-full">
              <span>👁 {formatCompactNumber(views)}</span>
              <span>♥ {formatCompactNumber(likes)}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-medium text-white bg-black/70 px-2 py-0.5 rounded-full">
              <span>💬 {formatCompactNumber(comments)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="p-3">
        {video?.author && (
          <div className="flex items-center gap-1.5 mb-1">
            {profileUrl ? (
              <a
                href={profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-zinc-500 hover:text-brand-400 truncate"
              >
                @{video.author} ↗
              </a>
            ) : (
              <p className="text-xs text-zinc-500 truncate">@{video.author}</p>
            )}
          </div>
        )}
        <p className="text-sm text-zinc-900 line-clamp-2 min-h-[2.5rem]">
          {video?.title || item.fastmoss_title || item.product_name || item.fastmoss_url}
        </p>

        {gmvPrimary && (
          <div className="mt-2 pt-2 border-t border-edge">
            <p className="text-[9px] text-zinc-500 uppercase tracking-wide">{t("trendGMV")}</p>
            <p className="text-sm font-semibold text-zinc-900">{gmvPrimary}</p>
          </div>
        )}
        {metric === "sales" && item.sales != null && (
          <p className="text-[11px] text-brand-400 font-medium mt-1">
            {t("trendSales")}: {item.sales}
          </p>
        )}

        {item.product_name && (
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-edge">
            <div className="w-8 h-8 rounded bg-panel2 border border-edge flex items-center justify-center text-xs shrink-0">
              🛍
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-zinc-700 leading-snug line-clamp-1" title={item.product_name}>
                {item.product_name}
              </p>
              {item.sales != null && <p className="text-[10px] text-zinc-500">{item.sales} {t("trendSales").toLowerCase()}</p>}
            </div>
          </div>
        )}

        {item.product_id && (
          <button
            onClick={toggleAnalysis}
            className="mt-2 w-full text-[10px] px-2 py-1.5 rounded border border-dashed border-edge2 text-zinc-500 hover:text-zinc-900 hover:border-brand-500"
          >
            {analysisOpen ? `▲ ${t("trendHideAnalysis")}` : `🔍 ${t("trendShowAnalysis")}`}
          </button>
        )}
        {item.product_id && analysisOpen && (
          <div className="mt-2 pt-2 border-t border-edge space-y-3" onMouseDown={(e) => e.stopPropagation()}>
            {analysisLoading && <p className="text-[11px] text-yellow-600 animate-pulse">{t("trendAnalysisLoading")}</p>}
            {analysisError && <p className="text-[11px] text-red-400">{analysisError}</p>}
            {analysis && (
              <>
                {analysis.creatorStats && analysis.creatorStats.day28_gmv != null && (
                  <div className="pb-2 border-b border-edge">
                    <p className="text-[9px] text-zinc-500 uppercase tracking-wide">{t("trendCreatorGmv28d")}</p>
                    <p className="text-sm font-semibold text-zinc-900">
                      ${analysis.creatorStats.day28_gmv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </p>
                  </div>
                )}

                <p className="text-[9px] font-semibold text-zinc-500 uppercase tracking-wide">
                  {t("trendProductAnalytics")}
                </p>

                <div>
                  <p className="text-[9px] text-zinc-500 uppercase tracking-wide mb-1">
                    {t("trendSaturationLabel")} · {t("trendSaturation7d")}
                  </p>
                  <SaturationBar count={analysis.saturation7d} />
                </div>

                <div>
                  <p className="text-[9px] text-zinc-500 uppercase tracking-wide mb-1">{t("trendRevenueLabel")}</p>
                  <SalesTrendChart points={analysis.salesTrend.list} />
                </div>

                <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[10px] text-zinc-500 pt-1 border-t border-edge">
                  <span>
                    {t("trendRelatedCreators")}
                    <br />
                    <span className="text-zinc-800 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.creator_count)}
                    </span>
                  </span>
                  <span>
                    {t("trendRelatedVideos")}
                    <br />
                    <span className="text-zinc-800 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.aweme_count)}
                    </span>
                  </span>
                  <span>
                    {t("trendRelatedLives")}
                    <br />
                    <span className="text-zinc-800 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.live_count)}
                    </span>
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {video?.source_url && /tiktok\.com/.test(video.source_url) && (
          <>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={handleAddToCreation}
                disabled={addState === "adding"}
                className="flex-1 text-[10px] px-2 py-1.5 rounded border border-dashed border-edge2 text-zinc-500 hover:text-zinc-900 hover:border-brand-500 disabled:opacity-40"
              >
                {addState === "adding"
                  ? t("trendAddingToCreation")
                  : addState === "added"
                  ? `✓ ${t("trendAddedToCreation")}`
                  : `🎬 ${t("trendAddToCreation")}`}
              </button>
              {addState === "added" && addedProjectId && (
                <a
                  href={`/creation/${addedProjectId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-[10px] text-brand-400 hover:text-brand-300 underline underline-offset-2 whitespace-nowrap"
                >
                  {t("trendViewInCreation")}
                </a>
              )}
            </div>
            {addState === "error" && (
              <p className="text-[10px] text-red-400 mt-1">{t("trendAddToCreationError")}</p>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (selectMode) {
    return (
      <div onClick={onToggleSelect} className="cursor-pointer">
        {body}
      </div>
    );
  }
  if (!video) return <div className="opacity-60 cursor-default">{body}</div>;
  return (
    <Link href={`/video/${video.id}`} className="block">
      {body}
    </Link>
  );
}

// A real PRODUCT card (image + name + price + GMV/units-sold), for the "Top
// 20 Viral Products" section — deliberately NOT the video-card layout
// TrendCard above renders (thumbnail/caption/creator), since this section
// is about the PRODUCT, not any one specific video promoting it. Reuses the
// same on-demand "AI Analysis" panel (SalesTrendChart/SaturationBar), just
// with its own copy of the open/loading/error state rather than sharing
// TrendCard's, to keep the two card types independent and simple.
function ProductCard({ item }: { item: EnrichedItem }) {
  const { t } = useLocale();
  const favorites = useContext(FavoritesContext);

  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ProductAnalysis | null>(null);

  const [addState, setAddState] = useState<"idle" | "adding" | "added" | "error">("idle");
  const [addedProjectId, setAddedProjectId] = useState<string | null>(null);
  // A product image straight off FastMoss/TikTok's own CDN, not cached
  // locally like video thumbnails — those links can 404/expire, so this
  // just falls back to a plain placeholder rather than showing a broken
  // image icon.
  const [imgFailed, setImgFailed] = useState(false);

  async function handleAddToCreation() {
    if (!item.video || addState === "adding" || addState === "added") return;
    setAddState("adding");
    try {
      const res = await fetch("/api/creation/import-trend-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoRecordId: item.video.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.projectId) throw new Error(data.error || "Import failed");
      setAddedProjectId(data.projectId);
      setAddState("added");
    } catch {
      setAddState("error");
    }
  }

  async function toggleAnalysis() {
    if (analysisOpen) {
      setAnalysisOpen(false);
      return;
    }
    setAnalysisOpen(true);
    if (analysis || analysisLoading) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const res = await fetch("/api/trends/analyze-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: item.product_id,
          creator_handle: item.creator_handle || undefined,
          days: 28,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setAnalysis(data);
    } catch (err: any) {
      setAnalysisError(err.message || "Analysis failed");
    } finally {
      setAnalysisLoading(false);
    }
  }

  const productTitle = item.product_name || item.fastmoss_title || "Untitled product";

  // Click-through to the dedicated product detail page (src/app/trends/
  // product/[productId]/page.tsx) — that page is entirely client-side with
  // no server-side product lookup, so everything it needs to render
  // immediately (title/image/price/rank/creator/category/score) is passed
  // along as query params rather than re-fetched by product id.
  const detailHref = item.product_id
    ? `/trends/product/${encodeURIComponent(item.product_id)}?${new URLSearchParams({
        title: productTitle,
        ...(item.product_image ? { image: item.product_image } : {}),
        ...(item.product_price ? { price: item.product_price } : {}),
        rank: String(item.rank),
        ...(item.creator_handle ? { creator: item.creator_handle } : {}),
        ...(item.recommendationScore != null ? { score: String(item.recommendationScore) } : {}),
      }).toString()}`
    : null;

  const imageBlock = (
    <div className="relative aspect-square bg-panel2">
      <span className="absolute top-2 left-2 z-10 flex items-center gap-0.5 text-[11px] font-bold text-white bg-black/80 rounded-full px-2 py-1 leading-none">
        🔥 #{item.rank}
      </span>
      {item.product_id && favorites && (
        <div className="absolute top-2 right-2 z-10">
          <FavoriteButton
            favorited={favorites.productIds.has(item.product_id)}
            onToggle={() => favorites.toggleProduct(item)}
            title={favorites.productIds.has(item.product_id) ? t("favoriteRemove") : t("favoriteAdd")}
          />
        </div>
      )}
      {item.product_image && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.product_image}
          alt={productTitle}
          className="w-full h-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-4xl">🛍</div>
      )}
    </div>
  );

  return (
    <div className="rounded-xl overflow-hidden bg-panel border border-edge hover:border-brand-500 transition-colors">
      {detailHref ? <Link href={detailHref}>{imageBlock}</Link> : imageBlock}
      <div className="p-3">
        {detailHref ? (
          <Link href={detailHref} className="hover:text-brand-500">
            <p className="text-sm text-zinc-900 line-clamp-2 min-h-[2.5rem]" title={productTitle}>
              {productTitle}
            </p>
          </Link>
        ) : (
          <p className="text-sm text-zinc-900 line-clamp-2 min-h-[2.5rem]" title={productTitle}>
            {productTitle}
          </p>
        )}
        {item.product_price && <p className="text-sm font-semibold text-brand-400 mt-1">{item.product_price}</p>}

        {item.recommendationScore != null && (
          <div
            className="mt-1.5 flex items-center gap-1.5"
            title={t("trendRecommendationScoreHint")}
          >
            <div className="flex-1 h-1 rounded-full bg-panel2 overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${item.recommendationScore}%` }}
              />
            </div>
            <span className="text-[10px] font-semibold text-zinc-600 whitespace-nowrap">
              {t("trendRecommendationScore", { score: String(item.recommendationScore) })}
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-edge text-[10px] text-zinc-500">
          {(item.gmv ?? item.gmv_28d) && (
            <span>
              {t("trendGMV")}
              <br />
              <span className="text-zinc-800 font-medium">{item.gmv ?? item.gmv_28d}</span>
            </span>
          )}
          {item.sales != null && (
            <span>
              {t("trendSales")}
              <br />
              <span className="text-zinc-800 font-medium">{item.sales}</span>
            </span>
          )}
        </div>

        {item.product_id && (
          <button
            onClick={toggleAnalysis}
            className="mt-2 w-full text-[10px] px-2 py-1.5 rounded border border-dashed border-edge2 text-zinc-500 hover:text-zinc-900 hover:border-brand-500"
          >
            {analysisOpen ? `▲ ${t("trendHideAnalysis")}` : `🔍 ${t("trendShowAnalysis")}`}
          </button>
        )}
        {item.product_id && analysisOpen && (
          <div className="mt-2 pt-2 border-t border-edge space-y-3">
            {analysisLoading && <p className="text-[11px] text-yellow-600 animate-pulse">{t("trendAnalysisLoading")}</p>}
            {analysisError && <p className="text-[11px] text-red-400">{analysisError}</p>}
            {analysis && (
              <>
                {analysis.creatorStats && analysis.creatorStats.day28_gmv != null && (
                  <div className="pb-2 border-b border-edge">
                    <p className="text-[9px] text-zinc-500 uppercase tracking-wide">{t("trendCreatorGmv28d")}</p>
                    <p className="text-sm font-semibold text-zinc-900">
                      ${analysis.creatorStats.day28_gmv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </p>
                  </div>
                )}
                <p className="text-[9px] font-semibold text-zinc-500 uppercase tracking-wide">
                  {t("trendProductAnalytics")}
                </p>
                <div>
                  <p className="text-[9px] text-zinc-500 uppercase tracking-wide mb-1">
                    {t("trendSaturationLabel")} · {t("trendSaturation7d")}
                  </p>
                  <SaturationBar count={analysis.saturation7d} />
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500 uppercase tracking-wide mb-1">{t("trendRevenueLabel")}</p>
                  <SalesTrendChart points={analysis.salesTrend.list} />
                </div>
                <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[10px] text-zinc-500 pt-1 border-t border-edge">
                  <span>
                    {t("trendRelatedCreators")}
                    <br />
                    <span className="text-zinc-800 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.creator_count)}
                    </span>
                  </span>
                  <span>
                    {t("trendRelatedVideos")}
                    <br />
                    <span className="text-zinc-800 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.aweme_count)}
                    </span>
                  </span>
                  <span>
                    {t("trendRelatedLives")}
                    <br />
                    <span className="text-zinc-800 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.live_count)}
                    </span>
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {item.video && (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={handleAddToCreation}
              disabled={addState === "adding"}
              className="flex-1 text-[10px] px-2 py-1.5 rounded border border-dashed border-edge2 text-zinc-500 hover:text-zinc-900 hover:border-brand-500 disabled:opacity-40"
            >
              {addState === "adding"
                ? t("trendAddingToCreation")
                : addState === "added"
                ? `✓ ${t("trendAddedToCreation")}`
                : `🎬 ${t("trendAddToCreation")}`}
            </button>
            {addState === "added" && addedProjectId && (
              <a
                href={`/creation/${addedProjectId}`}
                className="text-[10px] text-brand-400 hover:text-brand-300 underline underline-offset-2 whitespace-nowrap"
              >
                {t("trendViewInCreation")}
              </a>
            )}
          </div>
        )}
        {addState === "error" && <p className="text-[10px] text-red-400 mt-1">{t("trendAddToCreationError")}</p>}
      </div>
    </div>
  );
}

function TrendSection({
  title,
  items,
  metric,
  batchId,
  selectMode,
  selected,
  onToggleSelect,
  variant = "video",
}: {
  title: string;
  items: EnrichedItem[];
  metric: Metric;
  batchId: string;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (key: string) => void;
  // "product" renders ProductCard (image/name/price — for the "Top 20 Viral
  // Products" section) instead of the default video-card layout. Select
  // mode isn't supported for product cards (that section never enables it).
  variant?: "video" | "product";
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {items.map((item) =>
          variant === "product" ? (
            <ProductCard key={`${metric}-${item.rank}-product-${item.product_id || item.fastmoss_url}`} item={item} />
          ) : (
            <TrendCard
              key={`${metric}-${item.rank}-${item.fastmoss_url}`}
              item={item}
              metric={metric}
              selectMode={selectMode}
              selected={selected.has(selKey(batchId, metric, item.rank))}
              onToggleSelect={() => onToggleSelect(selKey(batchId, metric, item.rank))}
            />
          )
        )}
      </div>
    </div>
  );
}

// Response shape of GET /api/trends/personalized (when the user has a saved
// category and data exists for it).
interface PersonalizedData {
  batch: EnrichedBatch;
  topProducts: EnrichedItem[];
  categoryId: string;
  categoryLabel: string;
  // Set by the server when the user's exact saved category had no data and
  // it fell back to showing the broader parent category instead (see
  // /api/trends/personalized) — the name of that broader category, or
  // null/absent if no fallback happened.
  usedFallbackCategory?: string | null;
}

// The personalized "For You" section deliberately doesn't participate in
// select-mode deletion (its cards can also appear in the batch list below,
// where selection/deletion already works) — so it always renders its
// TrendSections with an empty, inert selection.
const EMPTY_SELECTION = new Set<string>();

export default function TrendsPageContent({
  preferredCategory = null,
  role = "member",
}: {
  // The logged-in user's saved registration category, if any — passed down
  // from the server component (src/app/trends/page.tsx). Optional so any
  // other call site without the prop still compiles.
  preferredCategory?: { id: string; label: string } | null;
  // Gates the "Update" button (the manual, any-category, any-date-range
  // FastMoss pull) to admins only — regular members can still see every
  // trend/product view, they just can't trigger a fresh broad pull
  // themselves. Defaults to "member" (most restrictive) if omitted.
  role?: "admin" | "member";
}) {
  const { t } = useLocale();
  // Top-level Video/Product split (see the Product-tab state block below for
  // its own data). Video = everything that already existed on this page
  // (For You video section, manual category/date toolbar, batch lists).
  const [viewMode, setViewMode] = useState<"video" | "product">("video");
  const [batches, setBatches] = useState<EnrichedBatch[] | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Personalized "For You" section — only fetched when the user registered
  // with a saved category (preferredCategory prop). Non-fatal: an error here
  // just shows inline, the rest of the page renders normally.
  const [personalizedData, setPersonalizedData] = useState<PersonalizedData | null>(null);
  const [personalizedLoading, setPersonalizedLoading] = useState(false);
  const [personalizedError, setPersonalizedError] = useState<string | null>(null);

  // "Product" tab — Top 50 Selling Products (see /api/trends/top-products).
  // Defaults to the user's own saved registration category (if any) so a
  // regular member immediately sees a "For You" recommendation, but a
  // dropdown (own state, separate from the Video tab's category picker below)
  // lets ANYONE — including a member — browse another category's top
  // sellers too. Lazily loaded the first time the user switches to this tab
  // or picks a different category, not on initial page load.
  const [topProducts, setTopProducts] = useState<EnrichedItem[] | null>(null);
  const [topProductsLoading, setTopProductsLoading] = useState(false);
  const [topProductsError, setTopProductsError] = useState<string | null>(null);
  const [topProductsFallback, setTopProductsFallback] = useState<string | null>(null);
  const [productCategory, setProductCategory] = useState<{ id: string; label: string } | null>(preferredCategory);
  const [productCategoryQuery, setProductCategoryQuery] = useState("");
  const [productCategoryDropdownOpen, setProductCategoryDropdownOpen] = useState(false);
  const productCategoryDropdownRef = useRef<HTMLDivElement | null>(null);
  // Own day-range window, same 7/28/90 choices as the Video tab's `days`
  // state — kept separate since the two tabs' pulls are independent.
  const [productDays, setProductDays] = useState<7 | 28 | 90>(7);
  // Which "category id : days" combo the current topProducts data was
  // fetched for, so toggling back to this tab without changing anything
  // doesn't re-fetch every time.
  const lastTopProductsKey = useRef<string | null>(null);

  // Category picker + date-range window for the Update pull.
  const [categories, setCategories] = useState<CategoryNode[] | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<{ id: string; label: string } | null>(null);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const [days, setDays] = useState<7 | 28 | 90>(7);
  const categoryDropdownRef = useRef<HTMLDivElement | null>(null);

  // Category-cleanup scan (admin-triggered background job on the server).
  // scanInfo = metadata about the last completed scan (from the categories
  // response); scanStatus = live status of a currently running/finished scan.
  const [scanInfo, setScanInfo] = useState<{
    scannedAt: string;
    totalNodes: number;
    totalTested: number;
    totalBefore: number;
    totalAfterTopLevel: number;
  } | null>(null);
  const [scanStatus, setScanStatus] = useState<CategoryScanStatus | null>(null);
  const [scanTriggerError, setScanTriggerError] = useState<string | null>(null);
  const scanPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // "Trending Now — All Categories" — the merged, sales-sorted feed pulled
  // from every category's latest batch (see /api/trends/top-videos-all).
  // Read-only aggregation, no live FastMoss call of its own — populated by
  // whatever the scheduled full-catalog refresh (or an admin's manual
  // per-category Update) has already ingested.
  const [allCatItems, setAllCatItems] = useState<EnrichedItem[] | null>(null);
  const [allCatLoading, setAllCatLoading] = useState(false);
  const [allCatError, setAllCatError] = useState<string | null>(null);
  const [allCatCount, setAllCatCount] = useState(0);

  // Status of the scheduled full-catalog refresh job itself (last run time,
  // in-progress state) — same polled-status pattern as the category scan
  // above, plus an admin-only manual trigger.
  const [fullRefreshStatus, setFullRefreshStatus] = useState<FullRefreshStatus | null>(null);
  const [fullRefreshTriggerError, setFullRefreshTriggerError] = useState<string | null>(null);
  const fullRefreshPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Favorites — shared across every TrendCard/ProductCard on this page via
  // FavoritesContext (see its doc comment near the top of this file).
  // Fetched once on mount, same one-request-for-the-whole-page pattern as
  // VideoGrid.tsx's favoriteIds.
  const [favoriteVideoIds, setFavoriteVideoIds] = useState<Set<string>>(new Set());
  const [favoriteProductIds, setFavoriteProductIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/favorites/videos", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { videos: [] }))
      .then((data) => setFavoriteVideoIds(new Set((data.videos || []).map((v: any) => v.video.id))))
      .catch(() => {});
    fetch("/api/favorites/products", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { products: [] }))
      .then((data) => setFavoriteProductIds(new Set((data.products || []).map((p: any) => p.productId))))
      .catch(() => {});
  }, []);

  async function toggleFavoriteVideo(videoId: string) {
    const wasFavorited = favoriteVideoIds.has(videoId);
    setFavoriteVideoIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
    try {
      const res = await fetch(wasFavorited ? `/api/favorites/videos/${videoId}` : "/api/favorites/videos", {
        method: wasFavorited ? "DELETE" : "POST",
        headers: wasFavorited ? undefined : { "Content-Type": "application/json" },
        body: wasFavorited ? undefined : JSON.stringify({ videoId }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      setFavoriteVideoIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(videoId);
        else next.delete(videoId);
        return next;
      });
    }
  }

  async function toggleFavoriteProduct(item: EnrichedItem) {
    const productId = item.product_id;
    if (!productId) return;
    const wasFavorited = favoriteProductIds.has(productId);
    setFavoriteProductIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(productId);
      else next.add(productId);
      return next;
    });
    try {
      const res = await fetch(wasFavorited ? `/api/favorites/products/${productId}` : "/api/favorites/products", {
        method: wasFavorited ? "DELETE" : "POST",
        headers: wasFavorited ? undefined : { "Content-Type": "application/json" },
        body: wasFavorited
          ? undefined
          : JSON.stringify({
              productId,
              title: item.product_name || item.fastmoss_title || "Untitled product",
              imageUrl: item.product_image || null,
              price: item.product_price || null,
            }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      setFavoriteProductIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(productId);
        else next.delete(productId);
        return next;
      });
    }
  }

  async function load() {
    const res = await fetch("/api/trends", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setBatches(data.batches);
  }

  async function loadPersonalized(refresh = false) {
    setPersonalizedLoading(true);
    setPersonalizedError(null);
    try {
      const res = await fetch(`/api/trends/personalized${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load personalized trends");
      if (data.batch) setPersonalizedData(data as PersonalizedData);
    } catch (err: any) {
      setPersonalizedError(err.message || "Failed to load personalized trends");
    } finally {
      setPersonalizedLoading(false);
    }
  }

  async function loadTopProducts(category: { id: string; label: string }, days: 7 | 28 | 90) {
    setTopProductsLoading(true);
    setTopProductsError(null);
    lastTopProductsKey.current = `${category.id}:${days}`;
    try {
      const qs = new URLSearchParams({ categoryId: category.id, categoryLabel: category.label, days: String(days) });
      const res = await fetch(`/api/trends/top-products?${qs.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load top products");
      setTopProducts(data.products || []);
      setTopProductsFallback(data.usedFallbackCategory || null);
    } catch (err: any) {
      setTopProductsError(err.message || "Failed to load top products");
    } finally {
      setTopProductsLoading(false);
    }
  }

  useEffect(() => {
    load();
    if (preferredCategory) loadPersonalized();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the Product tab's data the first time the user actually switches
  // to it (or when they pick a different category/day-range) — this is its
  // own live FastMoss pull, no need to pay that cost for someone who never
  // opens the tab, or to re-pull every time they just toggle back.
  useEffect(() => {
    if (viewMode !== "product" || !productCategory) return;
    const key = `${productCategory.id}:${productDays}`;
    if (lastTopProductsKey.current === key) return;
    loadTopProducts(productCategory, productDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, productCategory, productDays]);

  // Close the Product tab's category dropdown on any click outside it —
  // mirrors the Video tab's categoryDropdownOpen effect below.
  useEffect(() => {
    if (!productCategoryDropdownOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!productCategoryDropdownRef.current?.contains(e.target as Node)) {
        setProductCategoryDropdownOpen(false);
      }
    }
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [productCategoryDropdownOpen]);

  // Fetch the FastMoss category tree once on mount (cheap, cached server-side).
  // Also do a single status poll (GET only — never triggers a scan) so that a
  // scan already running from a previous page load / another admin session
  // shows live progress after a refresh.
  useEffect(() => {
    fetch("/api/trends/fastmoss-categories")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setCategoriesError(data.error);
          return;
        }
        setCategories(data.categories || []);
        setScanInfo(data.scan || null);
      })
      .catch(() => setCategoriesError("Failed to load categories"));
    pollScanStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Make sure the scan-status poll timer never leaks past unmount.
  useEffect(() => {
    return () => {
      if (scanPollTimer.current) clearInterval(scanPollTimer.current);
    };
  }, []);

  // Load the merged "All Categories" trending feed + full-refresh job status
  // once on mount — same pattern as the category-tree fetch above.
  useEffect(() => {
    loadAllCategoriesTop();
    pollFullRefreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Make sure the full-refresh poll timer never leaks past unmount.
  useEffect(() => {
    return () => {
      if (fullRefreshPollTimer.current) clearInterval(fullRefreshPollTimer.current);
    };
  }, []);

  // Close the category dropdown on any click outside it.
  useEffect(() => {
    if (!categoryDropdownOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!categoryDropdownRef.current?.contains(e.target as Node)) {
        setCategoryDropdownOpen(false);
      }
    }
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [categoryDropdownOpen]);

  // Flatten the (up to 3-level) tree into a searchable flat list, with each
  // entry labeled by its full breadcrumb path so nested leaves stay findable.
  const flatCategories = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    function walk(nodes: CategoryNode[], pathLabels: string[]) {
      for (const n of nodes) {
        const path = [...pathLabels, n.c_name];
        out.push({ id: n.c_code, label: path.join(" › ") });
        if (n.sub && n.sub.length > 0) walk(n.sub, path);
      }
    }
    if (categories) walk(categories, []);
    return out;
  }, [categories]);

  const filteredCategories = useMemo(() => {
    const q = categoryQuery.trim().toLowerCase();
    if (!q) return flatCategories.slice(0, 50); // cap the no-query list so it isn't 1000s of DOM nodes
    return flatCategories.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 50);
  }, [flatCategories, categoryQuery]);

  // Same flatCategories list, own query state — the Product tab's category
  // dropdown is independent from the Video tab's (different open/closed
  // state, different search text, different selection).
  const productFilteredCategories = useMemo(() => {
    const q = productCategoryQuery.trim().toLowerCase();
    if (!q) return flatCategories.slice(0, 50);
    return flatCategories.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 50);
  }, [flatCategories, productCategoryQuery]);

  useEffect(() => {
    const hasBusy = (batches || []).some((b) =>
      [...b.top_by_views, ...b.top_by_sales].some((it) => it.video && !["done", "error"].includes(it.video.status))
    );
    if (hasBusy) {
      timerRef.current = setInterval(load, 4000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches]);

  // Poll the background category-scan status. While the scan is running we
  // keep a 3s interval alive; once it leaves "running" (done OR error) the
  // interval is cleared. On "done" we re-fetch the category list so the
  // dropdown reflects the freshly pruned tree.
  function pollScanStatus() {
    fetch("/api/trends/fastmoss-categories/scan")
      .then((res) => res.json())
      .then((data) => {
        setScanStatus(data.status);
        if (data.status?.status === "running") {
          if (!scanPollTimer.current) scanPollTimer.current = setInterval(pollScanStatus, 3000);
        } else {
          if (scanPollTimer.current) {
            clearInterval(scanPollTimer.current);
            scanPollTimer.current = null;
          }
          if (data.status?.status === "done") {
            fetch("/api/trends/fastmoss-categories")
              .then((res) => res.json())
              .then((catData) => {
                if (!catData.error) {
                  setCategories(catData.categories || []);
                  setScanInfo(catData.scan || null);
                }
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {
        if (scanPollTimer.current) {
          clearInterval(scanPollTimer.current);
          scanPollTimer.current = null;
        }
      });
  }

  // Kick off a category-cleanup scan. Admin-only server-side: non-admins get
  // a 403 whose error message is surfaced inline (we deliberately don't try
  // to know the role client-side just to hide the button).
  async function triggerScan() {
    setScanTriggerError(null);
    try {
      const res = await fetch("/api/trends/fastmoss-categories/scan", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start scan");
      setScanStatus(data.status);
      pollScanStatus();
    } catch (err: any) {
      setScanTriggerError(err.message || "Failed to start scan");
    }
  }

  // Loads the merged "All Categories" feed — a pure read, no FastMoss call
  // of its own (see /api/trends/top-videos-all's doc comment).
  function loadAllCategoriesTop() {
    setAllCatLoading(true);
    setAllCatError(null);
    fetch("/api/trends/top-videos-all?limit=40", { cache: "no-store" })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Failed to load trending videos");
        setAllCatItems(data.items || []);
        setAllCatCount(data.categoriesCount || 0);
      })
      .catch((err: any) => setAllCatError(err.message || "Failed to load trending videos"))
      .finally(() => setAllCatLoading(false));
  }

  // Poll the background full-catalog refresh job's status — same
  // running/done/error pattern as pollScanStatus above. On "done", also
  // reload the merged feed so newly-ingested categories show up without a
  // manual page refresh.
  function pollFullRefreshStatus() {
    fetch("/api/trends/full-refresh", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        setFullRefreshStatus(data.status);
        if (data.status?.status === "running") {
          if (!fullRefreshPollTimer.current) {
            fullRefreshPollTimer.current = setInterval(pollFullRefreshStatus, 15000);
          }
        } else {
          if (fullRefreshPollTimer.current) {
            clearInterval(fullRefreshPollTimer.current);
            fullRefreshPollTimer.current = null;
          }
          if (data.status?.status === "done") loadAllCategoriesTop();
        }
      })
      .catch(() => {
        if (fullRefreshPollTimer.current) {
          clearInterval(fullRefreshPollTimer.current);
          fullRefreshPollTimer.current = null;
        }
      });
  }

  // Admin-only manual override — the scheduler already runs this
  // automatically every few days (see src/lib/fastmossFullRefresh.ts).
  async function triggerFullRefresh() {
    setFullRefreshTriggerError(null);
    try {
      const res = await fetch("/api/trends/full-refresh", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start refresh");
      setFullRefreshStatus(data.status);
      pollFullRefreshStatus();
    } catch (err: any) {
      setFullRefreshTriggerError(err.message || "Failed to start refresh");
    }
  }

  // Directly calls FastMoss's own API server-side (see /api/trends/update) —
  // no more "go ask Claude to live-scrape in a logged-in Chrome tab".
  async function handleUpdate() {
    setUpdating(true);
    setUpdateError(null);
    try {
      // No category selected => categoryId/categoryLabel are undefined and the
      // backend falls back to the legacy default (pet category).
      const res = await fetch("/api/trends/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: selectedCategory?.id,
          categoryLabel: selectedCategory?.label,
          days,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Update failed");
      await load();
    } catch (e: any) {
      setUpdateError(e.message || "Update failed");
    } finally {
      setUpdating(false);
    }
  }

  async function handleDelete(batchId: string) {
    if (!confirm(t("trendDeleteConfirm"))) return;
    const res = await fetch(`/api/trends?id=${batchId}`, { method: "DELETE" });
    if (res.ok) load();
  }

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(t("deleteSelectedConfirm", { count: selected.size }))) return;
    setDeleting(true);
    try {
      const byBatch = new Map<string, { metric: Metric; rank: number }[]>();
      for (const key of selected) {
        const [batchId, metric, rankStr] = key.split(":");
        const arr = byBatch.get(batchId) || [];
        arr.push({ metric: metric as Metric, rank: Number(rankStr) });
        byBatch.set(batchId, arr);
      }
      await Promise.all(
        Array.from(byBatch.entries()).map(([batchId, items]) =>
          fetch(`/api/trends/${batchId}/items`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
          })
        )
      );
      await load();
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }

  const totalItems = useMemo(
    () => (batches || []).reduce((sum, b) => sum + b.top_by_views.length + b.top_by_sales.length, 0),
    [batches]
  );

  return (
    <FavoritesContext.Provider
      value={{
        videoIds: favoriteVideoIds,
        productIds: favoriteProductIds,
        toggleVideo: toggleFavoriteVideo,
        toggleProduct: toggleFavoriteProduct,
      }}
    >
    <div className="space-y-10">
      {/* Top-level Video/Product split. Video = everything that already
          existed here (For You video section, manual category/date toolbar,
          batch lists). Product = a dedicated Top 50 Selling Products view
          for the user's own saved registration category (see
          /api/trends/top-products), lazily fetched on first switch. */}
      <div className="flex items-center rounded-lg border border-edge overflow-hidden w-fit">
        {(["video", "product"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setViewMode(m)}
            className={`text-sm px-4 py-2 whitespace-nowrap ${
              viewMode === m ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-900"
            }`}
          >
            {m === "video" ? t("trendTabVideo") : t("trendTabProduct")}
          </button>
        ))}
      </div>

      {viewMode === "product" ? (
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              {/* A member's DEFAULT selection (their own saved registration
                  category) is framed as "For You" so they know this is the
                  system recommending it, not a generic list — switches to a
                  plain "Top 50 Selling Products" heading the moment they (or
                  an admin with no saved category) pick something else via
                  the dropdown below. */}
              <h2 className="text-xl font-semibold text-zinc-900 mb-1">
                {preferredCategory && productCategory?.id === preferredCategory.id
                  ? t("trendForYou")
                  : t("trendTopSellingProducts")}
              </h2>
              {productCategory && (
                <p className="text-sm text-zinc-500">
                  {preferredCategory && productCategory.id === preferredCategory.id
                    ? t("trendForYouSubtitle", { category: productCategory.label })
                    : t("trendTopSellingProductsSubtitle", { category: productCategory.label })}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {/* Own dropdown (separate open/search state from the Video
                  tab's, see productCategoryDropdownOpen above) — lets
                  anyone, member or admin, browse any category's top sellers,
                  not just their own saved one. */}
              <div className="relative" ref={productCategoryDropdownRef}>
                <button
                  onClick={() => setProductCategoryDropdownOpen((v) => !v)}
                  className="text-xs rounded-lg px-3 py-1.5 border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2 whitespace-nowrap max-w-[180px] truncate"
                  title={productCategory?.label || t("trendCategoryPlaceholder")}
                >
                  {productCategory ? productCategory.label : t("trendCategoryPlaceholder")}
                </button>
                {productCategoryDropdownOpen && (
                  <div className="absolute z-20 top-full right-0 mt-1 w-72 rounded-lg border border-edge bg-panel shadow-xl p-2">
                    <input
                      autoFocus
                      value={productCategoryQuery}
                      onChange={(e) => setProductCategoryQuery(e.target.value)}
                      placeholder={t("trendCategorySearchPlaceholder")}
                      className="w-full px-2 py-1.5 rounded bg-panel2 border border-edge text-xs text-zinc-900 outline-none focus:border-brand-500 mb-2"
                    />
                    {categoriesError && <p className="text-[11px] text-red-400 px-1 pb-1">{categoriesError}</p>}
                    <div className="max-h-64 overflow-y-auto space-y-0.5">
                      {productFilteredCategories.length === 0 && (
                        <p className="text-[11px] text-zinc-500 px-1 py-2">{t("trendCategoryNoMatches")}</p>
                      )}
                      {productFilteredCategories.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => {
                            setProductCategory(c);
                            setProductCategoryDropdownOpen(false);
                            setProductCategoryQuery("");
                          }}
                          className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-600 hover:bg-panel2 hover:text-zinc-900 truncate"
                          title={c.label}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {/* Same 7D/28D/90D window the Video tab offers — everyone can
                  change it, it's just a filter on their own/browsed
                  category, not the broad admin-only pull below. */}
              <div className="flex items-center rounded-lg border border-edge overflow-hidden">
                {([7, 28, 90] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setProductDays(d)}
                    className={`text-xs px-2.5 py-1.5 whitespace-nowrap ${
                      productDays === d ? "bg-brand-500 text-white" : "text-zinc-500 hover:text-zinc-900"
                    }`}
                  >
                    {d}D
                  </button>
                ))}
              </div>
              {/* Admin-only manual re-pull, same gating/label convention as
                  the Video tab's Update button — regular members still get
                  their view auto-loaded (see the effect above), they just
                  don't get a manual override button. */}
              {role === "admin" && (
                <button
                  onClick={() => productCategory && loadTopProducts(productCategory, productDays)}
                  disabled={topProductsLoading || !productCategory}
                  className="px-4 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium whitespace-nowrap"
                >
                  {topProductsLoading ? t("trendUpdating") : t("trendUpdateButton")}
                </button>
              )}
            </div>
          </div>
          {!productCategory && (
            <p className="text-sm text-zinc-500">{t("trendNoCategoryForProducts")}</p>
          )}
          {topProductsLoading && !topProducts && (
            <p className="text-sm text-yellow-600 animate-pulse">{t("trendUpdating")}</p>
          )}
          {topProductsError && <p className="text-sm text-red-400">{topProductsError}</p>}
          {productCategory && topProductsFallback && (
            <p className="text-xs text-zinc-500">
              No data yet for "{productCategory.label}" specifically — showing the broader category "{topProductsFallback}" instead.
            </p>
          )}
          {productCategory && topProducts && (
            <TrendSection
              title={t("trendTopSellingProducts")}
              items={topProducts}
              metric="sales"
              batchId="top-products"
              selectMode={false}
              selected={EMPTY_SELECTION}
              onToggleSelect={() => {}}
              variant="product"
            />
          )}
        </div>
      ) : (
        <>
      {/* Personalized "For You" section — shown above the manual category/
          update toolbar whenever the user registered with a saved category. */}
      {preferredCategory && (
        <div className="space-y-6 pb-8 border-b border-edge">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-xl font-semibold text-zinc-900 mb-1">{t("trendForYou")}</h2>
              <p className="text-sm text-zinc-500">
                {t("trendForYouSubtitle", { category: preferredCategory.label })}
              </p>
            </div>
            <button
              onClick={() => loadPersonalized(true)}
              disabled={personalizedLoading}
              className="text-xs rounded-lg px-3 py-1.5 border border-edge text-zinc-500 hover:text-zinc-900 hover:border-edge2 disabled:opacity-40 whitespace-nowrap"
            >
              {personalizedLoading ? t("trendUpdating") : t("trendRefresh")}
            </button>
          </div>
          {personalizedLoading && !personalizedData && (
            <p className="text-sm text-yellow-600 animate-pulse">{t("trendUpdating")}</p>
          )}
          {personalizedError && <p className="text-sm text-red-400">{personalizedError}</p>}
          {personalizedData?.usedFallbackCategory && (
            <p className="text-xs text-zinc-500">
              No data yet for "{preferredCategory.label}" specifically — showing the broader category "{personalizedData.usedFallbackCategory}" instead.
            </p>
          )}
          {personalizedData && (
            <TrendSection
              title={t("trendTopByViews")}
              items={personalizedData.batch.top_by_views}
              metric="views"
              batchId={`foryou-views-${personalizedData.batch.id}`}
              selectMode={false}
              selected={EMPTY_SELECTION}
              onToggleSelect={() => {}}
            />
          )}
        </div>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 mb-1">{t("trendPageHeading")}</h2>
          <p className="text-sm text-zinc-500">{t("trendPageSubheading")}</p>
        </div>
        <div className="flex items-center gap-2">
          {selectMode && selected.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              disabled={deleting}
              className="text-xs text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg px-3 py-1.5"
            >
              {deleting ? "..." : t("deleteSelected")}
            </button>
          )}
          {selectMode && <span className="text-xs text-zinc-500">{t("selectedCount", { count: selected.size })}</span>}
          {totalItems > 0 && (
            <button
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`text-xs rounded-lg px-3 py-1.5 border whitespace-nowrap ${
                selectMode ? "bg-zinc-900 text-white border-zinc-900" : "text-zinc-500 hover:text-zinc-900 border-edge"
              }`}
            >
              {selectMode ? t("selectModeExit") : t("selectMode")}
            </button>
          )}
          <div className="relative" ref={categoryDropdownRef}>
            <button
              onClick={() => setCategoryDropdownOpen((v) => !v)}
              className="text-xs rounded-lg px-3 py-1.5 border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2 whitespace-nowrap max-w-[180px] truncate"
              title={selectedCategory?.label || t("trendCategoryPlaceholder")}
            >
              {selectedCategory ? selectedCategory.label : t("trendCategoryPlaceholder")}
            </button>
            {categoryDropdownOpen && (
              <div className="absolute z-20 top-full left-0 mt-1 w-72 rounded-lg border border-edge bg-panel shadow-xl p-2">
                <input
                  autoFocus
                  value={categoryQuery}
                  onChange={(e) => setCategoryQuery(e.target.value)}
                  placeholder={t("trendCategorySearchPlaceholder")}
                  className="w-full px-2 py-1.5 rounded bg-panel2 border border-edge text-xs text-zinc-900 outline-none focus:border-brand-500 mb-2"
                />
                {categoriesError && <p className="text-[11px] text-red-400 px-1 pb-1">{categoriesError}</p>}
                <div className="max-h-64 overflow-y-auto space-y-0.5">
                  {filteredCategories.length === 0 && (
                    <p className="text-[11px] text-zinc-500 px-1 py-2">{t("trendCategoryNoMatches")}</p>
                  )}
                  {filteredCategories.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setSelectedCategory(c);
                        setCategoryDropdownOpen(false);
                        setCategoryQuery("");
                      }}
                      className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-600 hover:bg-panel2 hover:text-zinc-900 truncate"
                      title={c.label}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center rounded-lg border border-edge overflow-hidden">
            {([7, 28, 90] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`text-xs px-2.5 py-1.5 whitespace-nowrap ${
                  days === d ? "bg-brand-500 text-white" : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                {d}D
              </button>
            ))}
          </div>
          {/* Manual, any-category, any-date-range pull — admin-only. Regular
              members still see every trend/product view on this page, they
              just can't trigger a fresh broad FastMoss pull themselves. */}
          {role === "admin" && (
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium whitespace-nowrap"
            >
              {updating ? t("trendUpdating") : t("trendUpdateButton")}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1">
        {categories && !selectedCategory && (
          <p className="text-[11px] text-zinc-500">{t("trendCategoryHint")}</p>
        )}
        {/* Category-cleanup scan status + admin trigger. The button is shown to
            everyone; non-admins just get the server's 403 error inline. */}
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-zinc-500">
          {scanStatus?.status === "running" ? (
            <span className="text-yellow-600 animate-pulse">
              {t("trendCategoryScanRunning", { tested: scanStatus.tested, total: scanStatus.total || "?" })}
            </span>
          ) : (
            <>
              {scanInfo ? (
                <span>
                  {t("trendCategoryScanLastRun", {
                    date: new Date(scanInfo.scannedAt).toISOString().slice(0, 16).replace("T", " "),
                  })}
                </span>
              ) : (
                <span>{t("trendCategoryScanNeverRun")}</span>
              )}
              <button
                onClick={triggerScan}
                className="text-brand-400 hover:text-brand-300 underline underline-offset-2"
              >
                {scanInfo ? t("trendCategoryScanRerun") : t("trendCategoryScanRun")}
              </button>
            </>
          )}
          {scanStatus?.status === "error" && <span className="text-red-400">{scanStatus.error}</span>}
          {scanTriggerError && <span className="text-red-400">{scanTriggerError}</span>}
        </div>
      </div>

      {/* "Trending Now — All Categories": every category's latest pull
          merged into one feed and sorted by sales, so this leads with the
          catalog-wide top sellers instead of one category at a time. Kept
          fresh by the scheduled full-catalog refresh (see
          src/lib/fastmossFullRefresh.ts) — the per-category batch list
          further down still lets an admin browse/pull one category at a
          time if they want to. */}
      <div className="space-y-3 pb-8 border-b border-edge">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-semibold text-zinc-900">{t("trendAllCategoriesHeading")}</h3>
            <p className="text-xs text-zinc-500">
              {allCatCount > 0
                ? t("trendAllCategoriesSubtitle", { count: String(allCatCount) })
                : t("trendAllCategoriesSubtitleEmpty")}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-zinc-500">
            {fullRefreshStatus?.status === "running" ? (
              <span className="text-yellow-600 animate-pulse">
                {t("trendFullRefreshRunning", {
                  processed: String(fullRefreshStatus.processed),
                  total: String(fullRefreshStatus.total || "?"),
                })}
              </span>
            ) : fullRefreshStatus?.lastPersistedRun?.finishedAt ? (
              <span>
                {t("trendFullRefreshLastRun", {
                  date: new Date(fullRefreshStatus.lastPersistedRun.finishedAt).toISOString().slice(0, 16).replace("T", " "),
                })}
              </span>
            ) : (
              <span>{t("trendFullRefreshNeverRun")}</span>
            )}
            {role === "admin" && fullRefreshStatus?.status !== "running" && (
              <button onClick={triggerFullRefresh} className="text-brand-400 hover:text-brand-300 underline underline-offset-2">
                {t("trendFullRefreshRunNow")}
              </button>
            )}
            {fullRefreshStatus?.status === "error" && fullRefreshStatus.error && (
              <span className="text-red-400">{fullRefreshStatus.error}</span>
            )}
            {fullRefreshTriggerError && <span className="text-red-400">{fullRefreshTriggerError}</span>}
          </div>
        </div>
        {allCatLoading && !allCatItems && <p className="text-sm text-yellow-600 animate-pulse">{t("trendUpdating")}</p>}
        {allCatError && <p className="text-sm text-red-400">{allCatError}</p>}
        {allCatItems && allCatItems.length === 0 && (
          <p className="text-sm text-zinc-500">{t("trendAllCategoriesEmpty")}</p>
        )}
        {allCatItems && allCatItems.length > 0 && (
          <TrendSection
            title={t("trendTopBySales")}
            items={allCatItems}
            metric="sales"
            batchId="all-categories"
            selectMode={false}
            selected={EMPTY_SELECTION}
            onToggleSelect={() => {}}
          />
        )}
      </div>

      {updateError && (
        <div className="flex items-start justify-between gap-3 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
          <p className="text-sm text-red-600 leading-relaxed">{updateError}</p>
          <button onClick={() => setUpdateError(null)} className="text-red-500 hover:text-red-700 text-sm shrink-0">
            ✕
          </button>
        </div>
      )}

      {batches && batches.length === 0 && (
        <div className="text-center py-24 text-zinc-500 text-sm">{t("trendEmptyState")}</div>
      )}

      {batches?.map((batch) => (
        <div key={batch.id} className="space-y-6 pb-8 border-b border-edge last:border-b-0">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h3 className="text-zinc-900 font-medium">
                {t("trendCategory")}: {batch.category}
              </h3>
              <span className="text-xs text-zinc-500">
                {t("trendWeekOf")}: {batch.date_from} {"→"} {batch.date_to}
              </span>
            </div>
            {!selectMode && (
              <button
                onClick={() => handleDelete(batch.id)}
                className="text-xs text-zinc-500 hover:text-red-400"
              >
                {t("trendDeleteBatch")}
              </button>
            )}
          </div>
          <TrendSection
            title={t("trendTopByViews")}
            items={batch.top_by_views}
            metric="views"
            batchId={batch.id}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={toggleSelect}
          />
          <TrendSection
            title={t("trendTopBySales")}
            items={batch.top_by_sales}
            metric="sales"
            batchId={batch.id}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={toggleSelect}
          />
        </div>
      ))}
        </>
      )}
    </div>
    </FavoritesContext.Provider>
  );
}
