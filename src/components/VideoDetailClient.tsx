"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AnalysisTabs from "./AnalysisTabs";
import TranscriptCanvas from "./TranscriptCanvas";
import { formatCompactNumber, STATUS_KEY } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import type { VideoRecord } from "@/lib/types";

export default function VideoDetailClient({ initialVideo }: { initialVideo: VideoRecord }) {
  const [video, setVideo] = useState<VideoRecord>(initialVideo);
  const [viewMode, setViewMode] = useState<"tabs" | "canvas">("tabs");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { t } = useLocale();

  useEffect(() => {
    if (["done", "error"].includes(video.status)) return;
    timerRef.current = setInterval(async () => {
      const res = await fetch(`/api/videos/${video.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setVideo(data.video);
      if (["done", "error"].includes(data.video.status) && timerRef.current) {
        clearInterval(timerRef.current);
      }
    }, 2500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.status]);

  const videoSrc = video.video_path ? `/api/media/${video.id}.mp4` : null;
  const isBusy = !["done", "error"].includes(video.status);
  const statusLabel = t(STATUS_KEY[video.status] as any);
  const [forceRetrying, setForceRetrying] = useState(false);

  // If the dev server restarted (or an old build without a Claude-call
  // timeout hung indefinitely) while a video was mid-pipeline, its status
  // field is permanently stuck — nothing will ever come back to update it,
  // since the in-flight request that owned it is gone. Give the user a way
  // to manually break out rather than staring at "AI analyzing..." forever.
  async function forceRetry() {
    setForceRetrying(true);
    const url =
      video.status === "analyzing"
        ? `/api/videos/${video.id}/analyze?force=1`
        : `/api/videos/${video.id}/retry`;
    await fetch(url, { method: "POST" }).catch(() => {});
    setForceRetrying(false);
  }

  // Prefer an explicit creator profile link (set when we scraped FastMoss
  // creator info at import time); fall back to constructing one from
  // yt-dlp's author_id, which for TikTok is the @handle.
  const creator = video.creator;
  const profileUrl = creator?.profile_url || (video.author_id ? `https://www.tiktok.com/@${video.author_id}` : null);
  const handle = creator?.handle || video.author_id || video.author;

  const s = video.stats;
  const engagementRate =
    s?.play_count && s.play_count > 0
      ? (((s.digg_count ?? 0) + (s.comment_count ?? 0) + (s.share_count ?? 0)) / s.play_count) * 100
      : null;

  const ModeToggle = (
    <div className="flex items-center gap-1 bg-panel border border-edge rounded-lg p-1 w-fit">
      <button
        onClick={() => setViewMode("tabs")}
        className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
          viewMode === "tabs" ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-white"
        }`}
      >
        {t("viewModeTabs")}
      </button>
      <button
        onClick={() => setViewMode("canvas")}
        className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
          viewMode === "canvas" ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-white"
        }`}
      >
        {t("viewModeCanvas")}
      </button>
    </div>
  );

  if (viewMode === "canvas") {
    // Canvas mode pulls the video itself into the board (draggable, with a
    // frame-capture button), so the fixed side panel goes away and the
    // canvas gets the full width to work with.
    return (
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Link href="/" className="text-sm text-zinc-400 hover:text-white">{t("backToBoard")}</Link>
          {ModeToggle}
        </div>
        {video.status === "error" && (
          <p className="mt-3 text-xs text-red-400">
            {t("breakdownFailedWithReason", { reason: video.error_message || "" })}
          </p>
        )}
        <div className="mt-4">
          <TranscriptCanvas video={video} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link href="/" className="text-sm text-zinc-400 hover:text-white">{t("backToBoard")}</Link>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6">
        <div>
          <div className="rounded-xl overflow-hidden bg-panel border border-edge aspect-[9/16] flex items-center justify-center">
            {videoSrc ? (
              <video src={videoSrc} controls className="w-full h-full object-contain bg-black" />
            ) : (
              <span className="text-sm text-zinc-400 px-4 text-center">
                {isBusy ? statusLabel : t("videoUnavailable")}
              </span>
            )}
          </div>
          <div className="mt-3">
            <p className="text-zinc-100 text-sm font-medium leading-snug">{video.title || video.source_url}</p>
            {profileUrl ? (
              <a
                href={profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-brand-400 hover:underline mt-1 inline-block"
              >
                @{handle || t("unknownAuthor")}
              </a>
            ) : (
              <p className="text-xs text-zinc-500 mt-1">@{handle || t("unknownAuthor")}</p>
            )}
            <div className="flex items-center gap-4 mt-3 text-xs text-zinc-400">
              <span>▶ {t("statsPlay")} {formatCompactNumber(video.stats?.play_count)}</span>
              <span>♥ {t("statsLike")} {formatCompactNumber(video.stats?.digg_count)}</span>
            </div>
            <div className="flex items-center gap-4 mt-1 text-xs text-zinc-400">
              <span>💬 {t("statsComment")} {formatCompactNumber(video.stats?.comment_count)}</span>
              <span>↗ {t("statsShare")} {formatCompactNumber(video.stats?.share_count)}</span>
            </div>
            {engagementRate !== null && (
              <div className="mt-1 text-xs text-zinc-400">
                <span>{t("statsEngagementRate")} {engagementRate.toFixed(2)}%</span>
              </div>
            )}
            {creator && (
              <div className="mt-4 pt-4 border-t border-edge">
                <div className="flex items-center gap-3">
                  {creator.avatar_url ? (
                    <a href={profileUrl || undefined} target="_blank" rel="noopener noreferrer" className="shrink-0">
                      <img
                        src={creator.avatar_url}
                        alt={creator.name || handle || ""}
                        className="w-11 h-11 rounded-full object-cover border border-edge"
                      />
                    </a>
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-panel2 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100 truncate">{creator.name || handle}</p>
                    {profileUrl && (
                      <a
                        href={profileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-brand-400 hover:underline"
                      >
                        {t("viewTikTokProfile")}
                      </a>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                  <div className="bg-panel2 rounded-lg py-2">
                    <p className="text-sm font-semibold text-zinc-100">{formatCompactNumber(creator.followers)}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{t("creatorFollowers")}</p>
                  </div>
                  <div className="bg-panel2 rounded-lg py-2">
                    <p className="text-sm font-semibold text-zinc-100">{formatCompactNumber(creator.avg_views)}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{t("creatorAvgViews")}</p>
                  </div>
                  <div className="bg-panel2 rounded-lg py-2">
                    <p className="text-sm font-semibold text-zinc-100">{formatCompactNumber(creator.avg_likes)}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{t("creatorAvgLikes")}</p>
                  </div>
                </div>
              </div>
            )}
            {video.hashtags?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {video.hashtags.slice(0, 8).map((h, i) => (
                  <span key={i} className="text-xs text-zinc-400 bg-panel border border-edge rounded-full px-2 py-0.5">
                    #{h}
                  </span>
                ))}
              </div>
            )}
            {isBusy && (
              <div className="mt-3">
                <p className="text-xs text-brand-400 animate-pulse">{statusLabel}...</p>
                <button
                  onClick={forceRetry}
                  disabled={forceRetrying}
                  className="text-xs text-zinc-500 hover:text-zinc-300 underline mt-1 disabled:opacity-40"
                >
                  {forceRetrying ? "..." : t("stuckRetry")}
                </button>
              </div>
            )}
            {video.status === "error" && (
              <p className="mt-3 text-xs text-red-400">
                {t("breakdownFailedWithReason", { reason: video.error_message || "" })}
              </p>
            )}
          </div>
        </div>

        <div>
          {ModeToggle}
          <div className="mt-4">
            <AnalysisTabs video={video} onVideoUpdate={setVideo} />
          </div>
        </div>
      </div>
    </div>
  );
}
