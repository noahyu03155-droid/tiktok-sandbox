"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import { formatCompactNumber, STATUS_KEY } from "@/lib/format";
import type { TrendItem, VideoRecord } from "@/lib/types";

interface EnrichedItem extends TrendItem {
  video: VideoRecord | null;
}

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

// Dependency-free inline SVG sparkline for the on-demand product sales trend
// (daily GMV). Stroke color = brand-400 (#5cc4ee), same accent used for
// connection lines in StoryboardCanvas.tsx.
function SalesTrendChart({ points }: { points: { dt: string; units_sold: number; gmv: number }[] }) {
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
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="block">
        <polyline points={coords.join(" ")} fill="none" stroke="#5cc4ee" strokeWidth={1.5} />
      </svg>
      <div className="flex items-center justify-between text-[9px] text-zinc-500 mt-0.5">
        <span>{points[0]?.dt}</span>
        <span>{points[points.length - 1]?.dt}</span>
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
  const outboundUrl = item.fastmoss_url || video?.source_url || null;
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

        {/* top-right: AI breakdown pill + outbound link (hidden in select mode to avoid clutter) */}
        {!selectMode && (
          <div className="absolute top-2 right-2 flex items-center gap-1">
            {video?.analysis && (
              <span className="text-[10px] font-medium text-white bg-black/70 px-2 py-1 rounded-full leading-none">
                🧠 AI
              </span>
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
        <p className="text-sm text-zinc-100 line-clamp-2 min-h-[2.5rem]">
          {video?.title || item.fastmoss_title || item.product_name || item.fastmoss_url}
        </p>

        {gmvPrimary && (
          <div className="mt-2 pt-2 border-t border-edge">
            <p className="text-[9px] text-zinc-500 uppercase tracking-wide">{t("trendGMV")}</p>
            <p className="text-sm font-semibold text-zinc-100">{gmvPrimary}</p>
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
              <p className="text-[11px] text-zinc-300 leading-snug line-clamp-1" title={item.product_name}>
                {item.product_name}
              </p>
              {item.sales != null && <p className="text-[10px] text-zinc-500">{item.sales} {t("trendSales").toLowerCase()}</p>}
            </div>
          </div>
        )}

        {item.product_id && (
          <button
            onClick={toggleAnalysis}
            className="mt-2 w-full text-[10px] px-2 py-1.5 rounded border border-dashed border-edge2 text-zinc-400 hover:text-white hover:border-brand-500"
          >
            {analysisOpen ? `▲ ${t("trendHideAnalysis")}` : `🔍 ${t("trendShowAnalysis")}`}
          </button>
        )}
        {item.product_id && analysisOpen && (
          <div className="mt-2 pt-2 border-t border-edge space-y-2" onMouseDown={(e) => e.stopPropagation()}>
            {analysisLoading && <p className="text-[11px] text-yellow-400 animate-pulse">{t("trendAnalysisLoading")}</p>}
            {analysisError && <p className="text-[11px] text-red-400">{analysisError}</p>}
            {analysis && (
              <>
                <SalesTrendChart points={analysis.salesTrend.list} />
                <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-zinc-400">
                  <span>
                    {t("trendSaturation7d")}: <span className="text-zinc-200 font-medium">{analysis.saturation7d}</span>
                  </span>
                  <span>
                    {t("trendRelatedCreators")}:{" "}
                    <span className="text-zinc-200 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.creator_count)}
                    </span>
                  </span>
                  <span>
                    {t("trendRelatedVideos")}:{" "}
                    <span className="text-zinc-200 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.aweme_count)}
                    </span>
                  </span>
                  <span>
                    {t("trendRelatedLives")}:{" "}
                    <span className="text-zinc-200 font-medium">
                      {formatCompactNumber(analysis.salesTrend.overview.live_count)}
                    </span>
                  </span>
                </div>
                {analysis.creatorStats && analysis.creatorStats.day28_gmv != null && (
                  <p className="text-[10px] text-zinc-400">
                    {t("trendCreatorGmv28d")}:{" "}
                    <span className="text-brand-400 font-medium">
                      ${analysis.creatorStats.day28_gmv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </p>
                )}
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
                className="flex-1 text-[10px] px-2 py-1.5 rounded border border-dashed border-edge2 text-zinc-400 hover:text-white hover:border-brand-500 disabled:opacity-40"
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

function TrendSection({
  title,
  items,
  metric,
  batchId,
  selectMode,
  selected,
  onToggleSelect,
}: {
  title: string;
  items: EnrichedItem[];
  metric: Metric;
  batchId: string;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {items.map((item) => {
          const key = selKey(batchId, metric, item.rank);
          return (
            <TrendCard
              key={`${metric}-${item.rank}-${item.fastmoss_url}`}
              item={item}
              metric={metric}
              selectMode={selectMode}
              selected={selected.has(key)}
              onToggleSelect={() => onToggleSelect(key)}
            />
          );
        })}
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
}

// The personalized "For You" section deliberately doesn't participate in
// select-mode deletion (its cards can also appear in the batch list below,
// where selection/deletion already works) — so it always renders its
// TrendSections with an empty, inert selection.
const EMPTY_SELECTION = new Set<string>();

export default function TrendsPageContent({
  preferredCategory = null,
}: {
  // The logged-in user's saved registration category, if any — passed down
  // from the server component (src/app/trends/page.tsx). Optional so any
  // other call site without the prop still compiles.
  preferredCategory?: { id: string; label: string } | null;
}) {
  const { t } = useLocale();
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

  useEffect(() => {
    load();
    if (preferredCategory) loadPersonalized();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div className="space-y-10">
      {/* Personalized "For You" section — shown above the manual category/
          update toolbar whenever the user registered with a saved category. */}
      {preferredCategory && (
        <div className="space-y-6 pb-8 border-b border-edge">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-xl font-semibold text-white mb-1">{t("trendForYou")}</h2>
              <p className="text-sm text-zinc-400">
                {t("trendForYouSubtitle", { category: preferredCategory.label })}
              </p>
            </div>
            <button
              onClick={() => loadPersonalized(true)}
              disabled={personalizedLoading}
              className="text-xs rounded-lg px-3 py-1.5 border border-edge text-zinc-400 hover:text-white hover:border-edge2 disabled:opacity-40 whitespace-nowrap"
            >
              {personalizedLoading ? t("trendUpdating") : t("trendRefresh")}
            </button>
          </div>
          {personalizedLoading && !personalizedData && (
            <p className="text-sm text-yellow-400 animate-pulse">{t("trendUpdating")}</p>
          )}
          {personalizedError && <p className="text-sm text-red-400">{personalizedError}</p>}
          {personalizedData && (
            <>
              <TrendSection
                title={t("trendTopProducts")}
                items={personalizedData.topProducts}
                metric="views"
                batchId={`foryou-products-${personalizedData.batch.id}`}
                selectMode={false}
                selected={EMPTY_SELECTION}
                onToggleSelect={() => {}}
              />
              <TrendSection
                title={t("trendTopByViews")}
                items={personalizedData.batch.top_by_views}
                metric="views"
                batchId={`foryou-views-${personalizedData.batch.id}`}
                selectMode={false}
                selected={EMPTY_SELECTION}
                onToggleSelect={() => {}}
              />
            </>
          )}
        </div>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-white mb-1">{t("trendPageHeading")}</h2>
          <p className="text-sm text-zinc-400">{t("trendPageSubheading")}</p>
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
          {selectMode && <span className="text-xs text-zinc-400">{t("selectedCount", { count: selected.size })}</span>}
          {totalItems > 0 && (
            <button
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`text-xs rounded-lg px-3 py-1.5 border whitespace-nowrap ${
                selectMode ? "bg-zinc-700 text-white border-zinc-700" : "text-zinc-400 hover:text-white border-edge"
              }`}
            >
              {selectMode ? t("selectModeExit") : t("selectMode")}
            </button>
          )}
          <div className="relative" ref={categoryDropdownRef}>
            <button
              onClick={() => setCategoryDropdownOpen((v) => !v)}
              className="text-xs rounded-lg px-3 py-1.5 border border-edge text-zinc-300 hover:text-white hover:border-edge2 whitespace-nowrap max-w-[180px] truncate"
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
                  className="w-full px-2 py-1.5 rounded bg-panel2 border border-edge text-xs text-zinc-100 outline-none focus:border-brand-500 mb-2"
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
                      className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-300 hover:bg-panel2 hover:text-white truncate"
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
                  days === d ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                {d}D
              </button>
            ))}
          </div>
          <button
            onClick={handleUpdate}
            disabled={updating}
            className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium whitespace-nowrap"
          >
            {updating ? t("trendUpdating") : t("trendUpdateButton")}
          </button>
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
            <span className="text-yellow-400 animate-pulse">
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

      {updateError && (
        <div className="flex items-start justify-between gap-3 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
          <p className="text-sm text-red-300 leading-relaxed">{updateError}</p>
          <button onClick={() => setUpdateError(null)} className="text-red-400 hover:text-red-200 text-sm shrink-0">
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
              <h3 className="text-white font-medium">
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
    </div>
  );
}
