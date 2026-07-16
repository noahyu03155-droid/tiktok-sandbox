"use client";

import Link from "next/link";
import { formatCompactNumber, STATUS_KEY } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import type { VideoRecord } from "@/lib/types";

export default function VideoCard({
  video,
  selectMode,
  selected,
  onToggleSelect,
}: {
  video: VideoRecord;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { t } = useLocale();
  const isBusy = !["done", "error"].includes(video.status);
  const thumb = video.thumbnail_path ? `/api/media/${video.thumbnail_path.split(/[\\/]/).pop()}` : null;
  const statusLabel = t(STATUS_KEY[video.status] as any);
  const creator = video.creator;
  const profileUrl = creator?.profile_url || (video.author_id ? `https://www.tiktok.com/@${video.author_id}` : null);

  const body = (
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
        <img src={thumb} alt={video.title} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-zinc-500 text-sm px-4 text-center">
          {isBusy ? statusLabel : t("noThumbnail")}
        </div>
      )}
      {isBusy && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
          <span className="text-xs text-white bg-black/50 px-3 py-1 rounded-full animate-pulse">
            {statusLabel}
          </span>
        </div>
      )}
      {video.status === "error" && (
        <div className="absolute inset-0 bg-red-950/70 flex items-center justify-center p-3">
          <span className="text-xs text-red-200 text-center">{t("breakdownFailed")}</span>
        </div>
      )}

      {/* top-left: reference badge, or a view-count pill when we have stats */}
      {video.is_reference ? (
        <span className="absolute top-2 left-2 text-[10px] font-medium text-white bg-brand-500/90 px-2 py-0.5 rounded-full">
          {t("referenceBadge")}
        </span>
      ) : (
        video.stats?.play_count != null && (
          <span className="absolute top-2 left-2 flex items-center gap-1 text-[10px] font-semibold text-white bg-black/70 px-2 py-1 rounded-full">
            🔥 {formatCompactNumber(video.stats.play_count)}
          </span>
        )
      )}

      {/* top-right: AI breakdown pill, once analysis has actually run */}
      {video.analysis && (
        <span className="absolute top-2 right-2 flex items-center gap-1 text-[10px] font-medium text-white bg-black/70 px-2 py-1 rounded-full">
          🧠 AI
        </span>
      )}

      {/* bottom-right: compact stat overlay, Daily-Virals style */}
      {!isBusy && video.status !== "error" && (
        <div className="absolute bottom-2 right-2 flex flex-col items-end gap-1">
          <div className="flex items-center gap-2 text-[10px] font-medium text-white bg-black/70 px-2 py-0.5 rounded-full">
            <span>👁 {formatCompactNumber(video.stats?.play_count)}</span>
            <span>♥ {formatCompactNumber(video.stats?.digg_count)}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-medium text-white bg-black/70 px-2 py-0.5 rounded-full">
            <span>💬 {formatCompactNumber(video.stats?.comment_count)}</span>
          </div>
        </div>
      )}
    </div>
  );

  const details = (
    <div className="p-3">
      <p className="text-sm text-zinc-900 line-clamp-2 min-h-[2.5rem]">{video.title || video.source_url}</p>
      <div className="flex items-center gap-1.5 mt-1">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-zinc-500 hover:text-brand-400 truncate"
          >
            @{video.author || t("unknownAuthor")} ↗
          </a>
        ) : (
          <p className="text-xs text-zinc-500 truncate">@{video.author || t("unknownAuthor")}</p>
        )}
      </div>
      {creator && (creator.followers != null || creator.avg_views != null) && (
        <div className="flex items-center gap-3 mt-2 pt-2 border-t border-edge text-[11px] text-zinc-500">
          {creator.followers != null && (
            <span>
              {t("creatorFollowers")}: <span className="text-zinc-700 font-medium">{formatCompactNumber(creator.followers)}</span>
            </span>
          )}
          {creator.avg_views != null && (
            <span>
              {t("creatorAvgViews")}: <span className="text-zinc-700 font-medium">{formatCompactNumber(creator.avg_views)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );

  const className = `group block rounded-xl overflow-hidden bg-panel border transition-colors ${
    selectMode && selected ? "border-brand-500" : "border-edge hover:border-brand-500"
  }`;

  if (selectMode) {
    return (
      <div className={`${className} cursor-pointer`} onClick={() => onToggleSelect?.(video.id)}>
        {body}
        {details}
      </div>
    );
  }

  return (
    <Link href={`/video/${video.id}`} className={className}>
      {body}
      {details}
    </Link>
  );
}
