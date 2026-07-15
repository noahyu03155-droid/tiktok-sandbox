"use client";

import { useEffect, useMemo, useState } from "react";
import type { VideoRecord } from "@/lib/types";

export interface LibraryClipChoice {
  videoId: string;
  title: string;
  // Prefer the thumbnail for the storyboard box preview — the full video
  // itself is left in place (source="library" never copies the file), the
  // user can still open the original from the node.
  thumbUrl: string | null;
  videoUrl: string | null;
}

// Lets a storyboard node point at a clip already sitting in the team's own
// analyzed-video library (Video Analysis / Trend Analysis / Creator
// Tracker) instead of uploading something new. Patterned after
// ProductPicker.tsx (plain English strings, no translation system — the
// whole Script Generator tab this hangs off of is English-only), filters
// client-side since /api/videos has no search param and the library is
// small enough for that to be fine.
export default function StoryboardLibraryPicker({
  onSelect,
  onClose,
}: {
  onSelect: (choice: LibraryClipChoice) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [videos, setVideos] = useState<VideoRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/videos", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setVideos(data.videos || []))
      .catch(() => setError("Failed to load your video library."));
  }, []);

  const results = useMemo(() => {
    if (!videos) return [];
    const q = query.trim().toLowerCase();
    const withMedia = videos.filter((v) => v.thumbnail_path || v.video_path);
    if (!q) return withMedia.slice(0, 60);
    return withMedia
      .filter((v) => (v.title || "").toLowerCase().includes(q) || (v.author || "").toLowerCase().includes(q))
      .slice(0, 60);
  }, [videos, query]);

  function pick(v: VideoRecord) {
    onSelect({
      videoId: v.id,
      title: v.title || v.author || v.id,
      thumbUrl: v.thumbnail_path ? `/api/media/${v.thumbnail_path.split(/[\\/]/).pop()}` : null,
      videoUrl: v.video_path ? `/api/media/${v.video_path.split(/[\\/]/).pop()}` : null,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] px-4">
      <div className="bg-panel rounded-xl border border-edge max-w-lg w-full p-5 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-semibold">Pick from your video library</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-white text-sm">
            ✕
          </button>
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title or creator..."
          className="w-full mb-3 px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-100 outline-none focus:border-brand-500"
        />
        <div className="overflow-y-auto flex-1 space-y-1">
          {error && <p className="text-sm text-red-400">{error}</p>}
          {!error && videos === null && <p className="text-sm text-zinc-400">Loading...</p>}
          {!error && videos !== null && results.length === 0 && (
            <p className="text-sm text-zinc-400">No videos found.</p>
          )}
          {results.map((v) => {
            const thumb = v.thumbnail_path ? `/api/media/${v.thumbnail_path.split(/[\\/]/).pop()}` : null;
            return (
              <button
                key={v.id}
                onClick={() => pick(v)}
                className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-panel2 text-left"
              >
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb} alt="" className="w-10 h-14 object-cover rounded shrink-0" />
                ) : (
                  <div className="w-10 h-14 rounded bg-panel2 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-sm text-zinc-100 truncate">{v.title || v.id}</p>
                  {v.author && <p className="text-xs text-zinc-500 truncate">@{v.author}</p>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
