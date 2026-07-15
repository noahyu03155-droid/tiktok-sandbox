"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import { formatCompactNumber } from "@/lib/format";
import type { CreatorVideoStub, TrackedCreator } from "@/lib/types";

type RangeKey = "7d" | "14d" | "30d" | "60d";
const RANGE_DAYS: Record<RangeKey, number> = { "7d": 7, "14d": 14, "30d": 30, "60d": 60 };
const RANGE_LABEL_KEY: Record<RangeKey, "creatorRange7d" | "creatorRange14d" | "creatorRange30d" | "creatorRange60d"> = {
  "7d": "creatorRange7d",
  "14d": "creatorRange14d",
  "30d": "creatorRange30d",
  "60d": "creatorRange60d",
};
type ProductSort = "videos" | "views";

function withinRange(v: CreatorVideoStub, days: number): boolean {
  if (!v.create_timestamp) return false;
  const cutoff = Date.now() / 1000 - days * 86400;
  return v.create_timestamp >= cutoff;
}

function formatDateShort(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function CreatorDetailClient({ initialCreator }: { initialCreator: TrackedCreator }) {
  const { t } = useLocale();
  const router = useRouter();
  const [creator, setCreator] = useState<TrackedCreator>(initialCreator);
  const [range, setRange] = useState<RangeKey>("30d");
  const [productSort, setProductSort] = useState<ProductSort>("videos");
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [showRescanModal, setShowRescanModal] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const [tagsInput, setTagsInput] = useState(creator.tags.join(", "));
  const [savingTags, setSavingTags] = useState(false);
  const [openingVideoId, setOpeningVideoId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [deletingVideos, setDeletingVideos] = useState(false);

  const videosInRange = useMemo(
    () => creator.videos.filter((v) => withinRange(v, RANGE_DAYS[range])),
    [creator.videos, range]
  );

  const stats = useMemo(() => {
    const totalViews = videosInRange.reduce((sum, v) => sum + (v.stats.play_count ?? 0), 0);
    const topVideo = videosInRange.reduce((max, v) => Math.max(max, v.stats.play_count ?? 0), 0);
    const uniqueProducts = new Set(videosInRange.map((v) => v.product_name).filter(Boolean));
    return {
      videos: videosInRange.length,
      uniqueProducts: uniqueProducts.size,
      totalViews,
      topVideo,
    };
  }, [videosInRange]);

  const products = useMemo(() => {
    const byProduct = new Map<string, { name: string; count: number; views: number; thumb: string | null }>();
    for (const v of videosInRange) {
      const name = v.product_name || "—";
      const entry = byProduct.get(name) || { name, count: 0, views: 0, thumb: v.thumbnail_url };
      entry.count += 1;
      entry.views += v.stats.play_count ?? 0;
      if (!entry.thumb) entry.thumb = v.thumbnail_url;
      byProduct.set(name, entry);
    }
    const arr = Array.from(byProduct.values());
    arr.sort((a, b) => (productSort === "videos" ? b.count - a.count : b.views - a.views));
    return arr;
  }, [videosInRange, productSort]);

  const displayedVideos = useMemo(() => {
    const filtered = selectedProduct ? videosInRange.filter((v) => (v.product_name || "—") === selectedProduct) : videosInRange;
    return [...filtered].sort((a, b) => (b.create_timestamp ?? 0) - (a.create_timestamp ?? 0));
  }, [videosInRange, selectedProduct]);

  async function handleOpenVideo(stub: CreatorVideoStub) {
    setOpeningVideoId(stub.id);
    try {
      const res = await fetch(`/api/creators/${creator.id}/open-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoStubId: stub.id }),
      });
      const data = await res.json();
      if (res.ok && data.videoId) {
        router.push(`/video/${data.videoId}`);
      }
    } finally {
      setOpeningVideoId(null);
    }
  }

  function toggleSelectVideo(id: string) {
    setSelectedVideos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedVideos(new Set());
  }

  function handleSelectAllVideos() {
    setSelectedVideos(new Set(displayedVideos.map((v) => v.id)));
  }

  async function handleDeleteSelectedVideos() {
    if (selectedVideos.size === 0) return;
    if (!confirm(t("deleteSelectedConfirm", { count: selectedVideos.size }))) return;
    setDeletingVideos(true);
    try {
      const res = await fetch(`/api/creators/${creator.id}/videos`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds: Array.from(selectedVideos) }),
      });
      if (res.ok) {
        setCreator((prev) => ({
          ...prev,
          videos: prev.videos.filter((v) => !selectedVideos.has(v.id)),
        }));
        exitSelectMode();
      }
    } finally {
      setDeletingVideos(false);
    }
  }

  function handleExportCsv() {
    const header = ["product", "title", "views", "likes", "comments", "shares", "date", "url"];
    const rows = displayedVideos.map((v) => [
      v.product_name || "",
      v.title || "",
      String(v.stats.play_count ?? ""),
      String(v.stats.digg_count ?? ""),
      String(v.stats.comment_count ?? ""),
      String(v.stats.share_count ?? ""),
      formatDateShort(v.create_timestamp),
      v.url,
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => csvEscape(c)).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${creator.handle}-videos.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSaveTags() {
    setSavingTags(true);
    try {
      const tags = tagsInput.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await fetch(`/api/creators/${creator.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      const data = await res.json();
      if (res.ok) {
        setCreator(data.creator);
        setEditingTags(false);
      }
    } finally {
      setSavingTags(false);
    }
  }

  const RANGES: RangeKey[] = ["7d", "14d", "30d", "60d"];

  return (
    <div>
      <Link href="/creators" className="text-sm text-zinc-400 hover:text-white">
        {t("creatorDetailBackToList")}
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          {creator.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={creator.avatar_url} alt={creator.handle} className="w-12 h-12 rounded-full object-cover border border-edge" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-panel2" />
          )}
          <div>
            <h2 className="text-2xl font-semibold text-white">@{creator.handle}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {t("creatorDataAsOf", { date: creator.last_scanned_at ? creator.last_scanned_at.slice(0, 16).replace("T", " ") : "—", count: creator.videos.length })}
            </p>
            <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
              <span>{t("creatorTagsLabel")}:</span>
              {!editingTags ? (
                <>
                  <span>{creator.tags.length > 0 ? creator.tags.join(", ") : "—"}</span>
                  <button onClick={() => setEditingTags(true)} className="text-brand-400 hover:underline">
                    {t("creatorTagsEdit")}
                  </button>
                </>
              ) : (
                <>
                  <input
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    placeholder={t("creatorTagsPlaceholder")}
                    className="bg-panel2 border border-edge rounded px-2 py-0.5 text-xs w-48 text-zinc-100"
                  />
                  <button onClick={handleSaveTags} disabled={savingTags} className="text-brand-400 hover:underline disabled:opacity-40">
                    {t("creatorTagsSave")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowRescanModal(true)}
            className="text-xs text-zinc-400 hover:text-white border border-edge rounded-lg px-3 py-1.5"
          >
            {t("creatorRescanButton")}
          </button>
          <div className="flex items-center gap-1 bg-panel border border-edge rounded-lg p-1">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                  range === r ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                {t(RANGE_LABEL_KEY[r])}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
        <div className="bg-panel border border-edge rounded-xl p-4">
          <p className="text-xs text-zinc-500">{t("creatorStatVideos")}</p>
          <p className="text-2xl font-semibold text-white mt-1">{stats.videos}</p>
        </div>
        <div className="bg-panel border border-edge rounded-xl p-4">
          <p className="text-xs text-zinc-500">{t("creatorStatUniqueProducts")}</p>
          <p className="text-2xl font-semibold text-white mt-1">{stats.uniqueProducts}</p>
        </div>
        <div className="bg-panel border border-edge rounded-xl p-4">
          <p className="text-xs text-zinc-500">{t("creatorStatTotalViews")}</p>
          <p className="text-2xl font-semibold text-white mt-1">{formatCompactNumber(stats.totalViews)}</p>
        </div>
        <div className="bg-panel border border-edge rounded-xl p-4">
          <p className="text-xs text-zinc-500">{t("creatorStatTopVideo")}</p>
          <p className="text-2xl font-semibold text-white mt-1">{formatCompactNumber(stats.topVideo)}</p>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-white mb-3">{t("creatorAffiliateTitle")}</h3>
        {creator.affiliate ? (
          <div className="bg-panel border border-edge rounded-xl p-4 space-y-4">
            {(creator.affiliate.window_from || creator.affiliate.window_to) && (
              <p className="text-xs text-zinc-500">
                {t("creatorAffiliateWindow", { from: creator.affiliate.window_from || "?", to: creator.affiliate.window_to || "?" })}
              </p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <AffiliateStat label={t("creatorPpsScore")} value={creator.affiliate.pps_score !== null ? `${creator.affiliate.pps_score.toFixed(1)}/5.0` : null} />
              <AffiliateStat label={t("creatorGmv")} value={creator.affiliate.gmv !== null ? `$${formatCompactNumber(creator.affiliate.gmv)}` : null} />
              <AffiliateStat label={t("creatorItemsSold")} value={formatCompactNumber(creator.affiliate.items_sold)} />
              <AffiliateStat label={t("creatorGpm")} value={creator.affiliate.gpm !== null ? `$${creator.affiliate.gpm}` : null} />
              <AffiliateStat label={t("creatorVideoGpm")} value={creator.affiliate.video_gpm !== null ? `$${creator.affiliate.video_gpm}` : null} />
              <AffiliateStat label={t("creatorVideosCount")} value={formatCompactNumber(creator.affiliate.videos_count)} />
              <AffiliateStat label={t("creatorAvgVideoViews")} value={formatCompactNumber(creator.affiliate.avg_video_views)} />
              <AffiliateStat label={t("creatorAvgEngagement")} value={creator.affiliate.avg_engagement_rate !== null ? `${creator.affiliate.avg_engagement_rate}%` : null} />
              <AffiliateStat label={t("creatorEstPostRate")} value={creator.affiliate.est_post_rate !== null ? `${creator.affiliate.est_post_rate}%` : null} />
              <AffiliateStat label={t("creatorAvgCommission")} value={creator.affiliate.avg_commission_rate !== null ? `${creator.affiliate.avg_commission_rate}%` : null} />
              <AffiliateStat label={t("creatorProductsCount")} value={formatCompactNumber(creator.affiliate.products_count)} />
              <AffiliateStat label={t("creatorBrandCollabs")} value={formatCompactNumber(creator.affiliate.brand_collaborations)} />
            </div>

            {creator.affiliate.demographics && (
              <div className="border-t border-edge pt-4">
                <p className="text-xs font-medium text-zinc-300 mb-2">{t("creatorDemographicsTitle")}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] text-zinc-500 mb-1">{t("creatorGenderLabel")}</p>
                    <DemographicBar
                      segments={[
                        { label: t("creatorFemale"), pct: creator.affiliate.demographics.female_pct, color: "#fe2c55" },
                        { label: t("creatorMale"), pct: creator.affiliate.demographics.male_pct, color: "#3b82f6" },
                      ]}
                    />
                  </div>
                  <div>
                    <p className="text-[11px] text-zinc-500 mb-1">{t("creatorAgeLabel")}</p>
                    <DemographicBar
                      segments={[
                        { label: "18-24", pct: creator.affiliate.demographics.age_18_24_pct, color: "#fe2c55" },
                        { label: "25-34", pct: creator.affiliate.demographics.age_25_34_pct, color: "#f59e0b" },
                        { label: "35-44", pct: creator.affiliate.demographics.age_35_44_pct, color: "#22c55e" },
                        { label: "45-54", pct: creator.affiliate.demographics.age_45_54_pct, color: "#3b82f6" },
                        { label: "55+", pct: creator.affiliate.demographics.age_55_plus_pct, color: "#a855f7" },
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">{t("creatorAffiliateEmpty")}</p>
        )}
      </div>

      {products.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mt-4">
          {products.slice(0, 11).map((p) => (
            <button
              key={p.name}
              onClick={() => setSelectedProduct(selectedProduct === p.name ? null : p.name)}
              className={`flex items-center gap-2 border rounded-lg px-2 py-2 text-left transition-colors ${
                selectedProduct === p.name ? "border-brand-500 bg-brand-500/10" : "border-edge bg-panel hover:border-edge2"
              }`}
            >
              {p.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumb} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded bg-panel2 shrink-0" />
              )}
              <p className="text-xs text-zinc-300 leading-snug line-clamp-2">
                <span className="font-semibold text-white">×{p.count}</span> {p.name}
              </p>
            </button>
          ))}
          {products.length > 11 && (
            <div className="flex items-center justify-center border border-dashed border-edge rounded-lg text-xs text-zinc-500">
              {t("creatorMoreProducts", { n: products.length - 11 })}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap mt-8 border-t border-edge pt-4">
        <h3 className="text-sm font-semibold text-white">
          {t("creatorProductsSectionTitle")}
          {selectedProduct && (
            <span className="ml-2 text-xs font-normal text-zinc-500">
              {selectedProduct} · <button onClick={() => setSelectedProduct(null)} className="text-brand-400 hover:underline">×</button>
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-panel border border-edge rounded-lg p-1">
            <button
              onClick={() => setProductSort("videos")}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                productSort === "videos" ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              {t("creatorSortByVideos")}
            </button>
            <button
              onClick={() => setProductSort("views")}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                productSort === "views" ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              {t("creatorSortByViews")}
            </button>
          </div>
          <button onClick={() => setShowRescanModal(true)} className="text-xs text-zinc-400 hover:text-white border border-edge rounded-lg px-3 py-1.5">
            {t("creatorRefresh")}
          </button>
          <button onClick={handleExportCsv} className="text-xs text-zinc-400 hover:text-white border border-edge rounded-lg px-3 py-1.5">
            {t("creatorExportCsv")}
          </button>
          {selectMode && (
            <>
              <button onClick={handleSelectAllVideos} className="text-xs text-zinc-400 hover:text-white rounded-lg px-2 py-1.5">
                {t("selectAll")}
              </button>
              <span className="text-xs text-zinc-400">{t("selectedCount", { count: selectedVideos.size })}</span>
              {selectedVideos.size > 0 && (
                <button
                  onClick={handleDeleteSelectedVideos}
                  disabled={deletingVideos}
                  className="text-xs text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg px-3 py-1.5"
                >
                  {deletingVideos ? "..." : t("deleteSelected")}
                </button>
              )}
            </>
          )}
          {displayedVideos.length > 0 && (
            <button
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`text-xs rounded-lg px-3 py-1.5 border whitespace-nowrap ${
                selectMode ? "bg-zinc-700 text-white border-zinc-700" : "text-zinc-400 hover:text-white border-edge"
              }`}
            >
              {selectMode ? t("selectModeExit") : t("selectMode")}
            </button>
          )}
        </div>
      </div>

      {displayedVideos.length === 0 && <p className="text-sm text-zinc-400 mt-4">{t("creatorVideoListEmpty")}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mt-4">
        {displayedVideos.map((v) => {
          const isSelected = selectedVideos.has(v.id);
          const card = (
            <>
              <div className="relative aspect-[9/16] bg-panel2">
                {selectMode && (
                  <div
                    className={`absolute top-2 right-2 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                      isSelected ? "bg-brand-500 border-brand-500" : "bg-black/50 border-zinc-400"
                    }`}
                  >
                    {isSelected && <span className="text-white text-[10px] leading-none">✓</span>}
                  </div>
                )}
                {v.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.thumbnail_url} alt={v.title} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-500 text-[10px]">{t("noThumbnail")}</div>
                )}
                {!selectMode && openingVideoId === v.id && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <span className="text-[10px] text-white text-center px-2">{t("creatorOpenBreakdown")}</span>
                  </div>
                )}
                <span className="absolute bottom-1 left-1 text-[10px] font-medium text-white bg-black/70 px-1.5 py-0.5 rounded">
                  {formatCompactNumber(v.stats.play_count)} {t("creatorViewsLabel")}
                </span>
              </div>
              <div className="p-2">
                <p className="text-[11px] text-zinc-300 line-clamp-2 min-h-[2rem]">{v.title || v.url}</p>
                <p className="text-[10px] text-zinc-500 mt-1">{formatDateShort(v.create_timestamp)}</p>
              </div>
            </>
          );
          const className = `text-left rounded-lg overflow-hidden bg-panel border transition-colors disabled:opacity-60 ${
            selectMode && isSelected ? "border-brand-500" : "border-edge hover:border-brand-500"
          }`;
          return (
            <button
              key={v.id}
              onClick={() => (selectMode ? toggleSelectVideo(v.id) : handleOpenVideo(v))}
              disabled={!selectMode && openingVideoId === v.id}
              className={className}
            >
              {card}
            </button>
          );
        })}
      </div>

      {showRescanModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-panel rounded-xl border border-edge max-w-md w-full p-6">
            <h3 className="text-white font-semibold mb-2">{t("creatorRescanModalTitle")}</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">{t("creatorRescanModalBody")}</p>
            <button
              onClick={() => setShowRescanModal(false)}
              className="mt-5 w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
            >
              {t("creatorRescanModalClose")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function AffiliateStat({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-white mt-0.5">{value ?? "—"}</p>
    </div>
  );
}

function DemographicBar({ segments }: { segments: { label: string; pct: number | null; color: string }[] }) {
  const valid = segments.filter((s) => s.pct !== null && s.pct > 0);
  if (valid.length === 0) return <p className="text-xs text-zinc-500">—</p>;
  return (
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-panel2">
        {valid.map((s) => (
          <div key={s.label} style={{ width: `${s.pct}%`, backgroundColor: s.color }} title={`${s.label}: ${s.pct}%`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {valid.map((s) => (
          <span key={s.label} className="text-[10px] text-zinc-500 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: s.color }} />
            {s.label} {s.pct}%
          </span>
        ))}
      </div>
    </div>
  );
}
