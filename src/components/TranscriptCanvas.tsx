"use client";

import { useEffect, useRef, useState } from "react";
import SingleVideoCanvas from "./SingleVideoCanvas";
import { STATUS_KEY } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import type { VideoRecord } from "@/lib/types";

function clampPct(n: number) {
  return Math.max(20, Math.min(80, n));
}

export default function TranscriptCanvas({ video }: { video: VideoRecord }) {
  const { t } = useLocale();
  const [referenceVideo, setReferenceVideo] = useState<VideoRecord | null>(null);
  const [initialScanDone, setInitialScanDone] = useState(false);
  const [refUrl, setRefUrl] = useState("");
  const [refLoading, setRefLoading] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Does this video already have a linked reference video from a previous session?
  useEffect(() => {
    let cancelled = false;
    fetch("/api/videos", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const candidates = (data.videos as VideoRecord[])
          .filter((v) => v.reference_of === video.id)
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        if (candidates[0]) setReferenceVideo(candidates[0]);
      })
      .finally(() => !cancelled && setInitialScanDone(true));
    return () => {
      cancelled = true;
    };
  }, [video.id]);

  // Poll while the reference video is still processing.
  useEffect(() => {
    if (!referenceVideo || ["done", "error"].includes(referenceVideo.status)) return;
    pollTimer.current = setInterval(async () => {
      const res = await fetch(`/api/videos/${referenceVideo.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setReferenceVideo(data.video);
    }, 2500);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [referenceVideo]);

  async function handleImportReference(e: React.FormEvent) {
    e.preventDefault();
    if (!refUrl.trim()) return;
    setRefLoading(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: refUrl.trim(), referenceOf: video.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setRefUrl("");
        const full = await fetch(`/api/videos/${data.id}`, { cache: "no-store" }).then((r) => r.json());
        if (full.video) setReferenceVideo(full.video);
      }
    } finally {
      setRefLoading(false);
    }
  }

  // ---- resizable split (desktop only — below the xl breakpoint the two
  // panels stack vertically and a percentage width would just shrink them
  // for no reason, so the divider only renders/applies once matchMedia says
  // we're wide enough for the side-by-side layout). Most of the time only
  // one side is actually being presented off of, so letting the team drag
  // the divider to hand one panel more room beats a fixed 50/50 split.
  const [leftPct, setLeftPct] = useState(50);
  const [isDesktop, setIsDesktop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  function onDividerPointerDown(e: React.PointerEvent) {
    draggingRef.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onDividerPointerMove(e: React.PointerEvent) {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(clampPct(pct));
  }
  function onDividerPointerUp() {
    draggingRef.current = false;
  }

  return (
    <div ref={containerRef} className="flex flex-col xl:flex-row gap-6 xl:gap-0">
      <div style={isDesktop ? { width: `calc(${leftPct}% - 6px)` } : undefined} className="min-w-0">
        <SingleVideoCanvas video={video} />
      </div>

      {isDesktop && (
        <div
          onPointerDown={onDividerPointerDown}
          onPointerMove={onDividerPointerMove}
          onPointerUp={onDividerPointerUp}
          onDoubleClick={() => setLeftPct(50)}
          title="Drag to resize · double-click to reset"
          className="w-3 shrink-0 flex items-center justify-center cursor-col-resize touch-none group"
        >
          <div className="w-1 h-16 rounded-full bg-edge group-hover:bg-brand-400 group-active:bg-brand-500 transition-colors" />
        </div>
      )}

      <div
        style={isDesktop ? { width: `calc(${100 - leftPct}% - 6px)` } : undefined}
        className="min-w-0 border-t xl:border-t-0 xl:border-l border-edge pt-6 xl:pt-0 xl:pl-3"
      >
        <p className="text-xs text-zinc-500 mb-2 font-medium">{t("referenceSectionTitle")}</p>

        {!referenceVideo && initialScanDone && (
          <>
            <form onSubmit={handleImportReference} className="flex gap-2 mb-3">
              <input
                value={refUrl}
                onChange={(e) => setRefUrl(e.target.value)}
                placeholder={t("referenceImportPlaceholder")}
                className="flex-1 bg-panel border border-edge rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-brand-500"
              />
              <button
                type="submit"
                disabled={refLoading || !refUrl.trim()}
                className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium whitespace-nowrap"
              >
                {refLoading ? "..." : t("referenceImportButton")}
              </button>
            </form>
            <p className="text-xs text-zinc-500">{t("referenceNotLinkedYet")}</p>
          </>
        )}

        {referenceVideo && !["done", "error"].includes(referenceVideo.status) && (
          <p className="text-xs text-brand-400 animate-pulse">
            {t(STATUS_KEY[referenceVideo.status] as any)}...
          </p>
        )}

        {referenceVideo && referenceVideo.status === "error" && (
          <p className="text-xs text-red-400">
            {t("referenceFailedWithReason", { reason: referenceVideo.error_message || "" })}
          </p>
        )}

        {referenceVideo && referenceVideo.status === "done" && (
          <div>
            <p className="text-xs text-zinc-500 mb-2 truncate">
              {referenceVideo.title || referenceVideo.source_url}
            </p>
            <SingleVideoCanvas video={referenceVideo} />
          </div>
        )}
      </div>
    </div>
  );
}
