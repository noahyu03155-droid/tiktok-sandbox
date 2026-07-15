"use client";

import { useEffect, useRef, useState } from "react";
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

function TrendCard({ item, metric }: { item: EnrichedItem; metric: "views" | "sales" }) {
  const { t } = useLocale();
  const video = item.video;
  const status = video?.status;
  const isBusy = video ? !["done", "error"].includes(status as string) : false;
  const thumb = video?.thumbnail_path ? `/api/media/${video.thumbnail_path.split(/[\\/]/).pop()}` : null;
  const statusLabel = status ? t(STATUS_KEY[status] as any) : "";

  const views = item.views ?? video?.stats?.play_count ?? null;
  const likes = item.likes ?? video?.stats?.digg_count ?? null;
  const comments = item.comments ?? video?.stats?.comment_count ?? null;

  const body = (
    <div className="group block rounded-xl overflow-hidden bg-white border border-stone-200 hover:border-brand-500 transition-colors">
      <div className="relative aspect-[9/16] bg-stone-100">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={item.fastmoss_title || ""} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-stone-500 text-xs px-3 text-center">
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
        <span className="absolute top-2 left-2 text-[11px] font-medium text-white bg-stone-900/80 px-2 py-0.5 rounded-full">
          #{item.rank}
        </span>
      </div>
      <div className="p-3">
        <p className="text-sm text-stone-900 line-clamp-2 min-h-[2.5rem]">
          {video?.title || item.fastmoss_title || item.product_name || item.fastmoss_url}
        </p>
        {item.product_name && (
          <p className="text-xs text-stone-500 mt-1 line-clamp-1" title={item.product_name}>
            {"\u{1F6CD} "}{item.product_name}
          </p>
        )}
        <div className="flex items-center gap-3 mt-2 text-xs text-stone-500 flex-wrap">
          <span>{"▶"} {formatCompactNumber(views)}</span>
          <span>{"♥"} {formatCompactNumber(likes)}</span>
          <span>{"\u{1F4AC}"} {formatCompactNumber(comments)}</span>
        </div>
        {metric === "sales" && (
          <div className="flex items-center gap-3 mt-1.5 text-xs text-brand-600 font-medium flex-wrap">
            <span>
              {t("trendSales")}: {item.sales ?? "-"}
            </span>
            {item.gmv && <span>{t("trendGMV")}: {item.gmv}</span>}
          </div>
        )}
        {item.gmv_28d && (
          <p className="text-[11px] text-stone-400 mt-1">
            {t("trendGMV28d")}: {item.gmv_28d}
          </p>
        )}
      </div>
    </div>
  );

  if (!video) return <div className="opacity-60 cursor-default">{body}</div>;
  return (
    <Link href={`/video/${video.id}`} className="block">
      {body}
    </Link>
  );
}

function TrendSection({ title, items, metric }: { title: string; items: EnrichedItem[]; metric: "views" | "sales" }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {items.map((item) => (
          <TrendCard key={`${metric}-${item.rank}-${item.fastmoss_url}`} item={item} metric={metric} />
        ))}
      </div>
    </div>
  );
}

export default function TrendsPageContent() {
  const { t } = useLocale();
  const [batches, setBatches] = useState<EnrichedBatch[] | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
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

  async function handleDelete(batchId: string) {
    if (!confirm(t("trendDeleteConfirm"))) return;
    const res = await fetch(`/api/trends?id=${batchId}`, { method: "DELETE" });
    if (res.ok) load();
  }

  return (
    <div className="space-y-10">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-stone-900 mb-1">{t("trendPageHeading")}</h2>
          <p className="text-sm text-stone-500">{t("trendPageSubheading")}</p>
        </div>
        <button
          onClick={() => setShowUpdateModal(true)}
          className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium whitespace-nowrap"
        >
          {t("trendUpdateButton")}
        </button>
      </div>

      {batches && batches.length === 0 && (
        <div className="text-center py-24 text-stone-500 text-sm">{t("trendEmptyState")}</div>
      )}

      {batches?.map((batch) => (
        <div key={batch.id} className="space-y-6 pb-8 border-b border-stone-200 last:border-b-0">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h3 className="text-stone-900 font-medium">
                {t("trendCategory")}: {batch.category}
              </h3>
              <span className="text-xs text-stone-500">
                {t("trendWeekOf")}: {batch.date_from} {"→"} {batch.date_to}
              </span>
            </div>
            <button
              onClick={() => handleDelete(batch.id)}
              className="text-xs text-stone-400 hover:text-red-600"
            >
              {t("trendDeleteBatch")}
            </button>
          </div>
          <TrendSection title={t("trendTopByViews")} items={batch.top_by_views} metric="views" />
          <TrendSection title={t("trendTopBySales")} items={batch.top_by_sales} metric="sales" />
        </div>
      ))}

      {showUpdateModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-xl border border-stone-200 max-w-md w-full p-6">
            <h3 className="text-stone-900 font-semibold mb-2">{t("trendUpdateModalTitle")}</h3>
            <p className="text-sm text-stone-600 leading-relaxed">{t("trendUpdateModalBody")}</p>
            <button
              onClick={() => setShowUpdateModal(false)}
              className="mt-5 w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
            >
              {t("trendUpdateModalClose")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
