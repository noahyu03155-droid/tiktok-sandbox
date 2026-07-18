"use client";

import { useEffect, useRef, useState } from "react";
import VideoCard from "./VideoCard";
import { useLocale } from "@/lib/i18n";
import type { VideoRecord } from "@/lib/types";

export default function VideoGrid({ initialVideos }: { initialVideos: VideoRecord[] }) {
  const [videos, setVideos] = useState<VideoRecord[]>(initialVideos);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { t } = useLocale();

  // Favorited video ids — fetched once (not per-card) so the whole board
  // shares one request; see src/components/FavoriteButton.tsx for why the
  // toggle state lives up here instead of inside each VideoCard.
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch("/api/favorites/videos", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { videos: [] }))
      .then((data) => setFavoriteIds(new Set((data.videos || []).map((v: any) => v.video.id))))
      .catch(() => {});
  }, []);

  async function toggleFavorite(videoId: string) {
    const wasFavorited = favoriteIds.has(videoId);
    setFavoriteIds((prev) => {
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
      // Revert on failure.
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(videoId);
        else next.delete(videoId);
        return next;
      });
    }
  }

  useEffect(() => {
    setVideos(initialVideos);
  }, [initialVideos]);

  useEffect(() => {
    async function poll() {
      const res = await fetch("/api/videos", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setVideos(
        (data.videos as VideoRecord[]).filter((v) => !v.is_reference && v.source !== "trend" && v.source !== "creator")
      );
    }

    const hasBusy = videos.some((v) => !["done", "error"].includes(v.status));
    if (hasBusy) {
      poll();
      timerRef.current = setInterval(poll, 3000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos.map((v) => `${v.id}:${v.status}`).join(",")]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === videos.length ? new Set() : new Set(videos.map((v) => v.id))));
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
      const res = await fetch("/api/videos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (res.ok) {
        setVideos((prev) => prev.filter((v) => !selected.has(v.id)));
        exitSelectMode();
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      {videos.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="flex items-center gap-2">
            {selectMode && (
              <>
                <button onClick={toggleSelectAll} className="text-xs text-zinc-500 hover:text-zinc-900 border border-edge rounded-lg px-3 py-1.5">
                  {t("selectAll")}
                </button>
                <span className="text-xs text-zinc-500">{t("selectedCount", { count: selected.size })}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {selectMode && selected.size > 0 && (
              <button
                onClick={handleDeleteSelected}
                disabled={deleting}
                className="text-xs text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg px-3 py-1.5"
              >
                {deleting ? "..." : t("deleteSelected")}
              </button>
            )}
            <button
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`text-xs rounded-lg px-3 py-1.5 border ${
                selectMode ? "bg-zinc-900 text-white border-zinc-900" : "text-zinc-500 hover:text-zinc-900 border-edge"
              }`}
            >
              {selectMode ? t("selectModeExit") : t("selectMode")}
            </button>
          </div>
        </div>
      )}

      {videos.length === 0 ? (
        <div className="text-center py-24 text-zinc-500 text-sm">{t("emptyBoardMessage")}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {videos.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              selectMode={selectMode}
              selected={selected.has(v.id)}
              onToggleSelect={toggleSelect}
              favorited={favoriteIds.has(v.id)}
              onToggleFavorite={() => toggleFavorite(v.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
