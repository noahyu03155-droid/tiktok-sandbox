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

type Metric = "views" | "sales";

function selKey(batchId: string, metric: Metric, rank: number) {
  return `${batchId}:${metric}:${rank}`;
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

export default function TrendsPageContent() {
  const { t } = useLocale();
  const [batches, setBatches] = useState<EnrichedBatch[] | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    const res = await fetch("/api/trends", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setBatches(data.batches);
  }

  useEffect(() => {
    load();
  }, []);

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

  // Directly calls FastMoss's own API server-side (see /api/trends/update) —
  // no more "go ask Claude to live-scrape in a logged-in Chrome tab".
  async function handleUpdate() {
    setUpdating(true);
    setUpdateError(null);
    try {
      const res = await fetch("/api/trends/update", { method: "POST" });
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
          <button
            onClick={handleUpdate}
            disabled={updating}
            className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium whitespace-nowrap"
          >
            {updating ? t("trendUpdating") : t("trendUpdateButton")}
          </button>
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
