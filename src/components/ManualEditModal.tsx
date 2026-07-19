"use client";

// A simplified, in-website timeline editor — the "✂️ Manual Edit" button next
// to Regenerate on a render result card opens this. NOT a CapCut/Premiere
// replacement (there's no public way to embed either of those in a
// webpage) — this is an honestly-scoped alternative for a user who wants
// more precise, hands-on control than the AI render gives them: a real
// horizontal timeline where clips are laid out proportionally to their
// trimmed length, dragged to reorder, trimmed by dragging their edges, split
// at the playhead, and captioned with simple text overlays — plus a combined
// play-through preview across the whole sequence. No transitions library, no
// stickers, no AI features, no thumbnails — just the fundamentals of an
// actual timeline instead of a flat list with sliders.
//
// Auto-imports the current chain's already-edited shots as the starting
// timeline (see StoryboardCanvas.tsx's openManualEdit), and lets the user
// pull in any other clip already uploaded anywhere on the board via
// boardClips.

import { useEffect, useMemo, useRef, useState } from "react";

export interface ManualEditSourceClip {
  nodeId: string;
  url: string;
  kind: "video" | "image";
  label: string;
}

interface TimelineItem {
  id: string; // unique per timeline block — NOT the same as nodeId, since splitting a clip produces two blocks sharing one source
  nodeId: string;
  url: string;
  kind: "video" | "image";
  label: string;
  duration: number; // full source duration; 0 until probed for video, fixed for images
  trimStart: number;
  trimEnd: number;
}

interface TextOverlay {
  id: string;
  itemId: string; // tracks the timeline block by its unique id, not nodeId (a split clip needs its two halves addressable separately)
  text: string;
  startSec: number; // relative to the block's own trimmed timeline (0 = the moment this block starts playing)
  endSec: number;
}

const DEFAULT_IMAGE_DURATION = 4;
const MIN_ZOOM = 15;
const MAX_ZOOM = 140;
const DEFAULT_ZOOM = 46; // pixels per second

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function itemDur(it: TimelineItem): number {
  return it.kind === "video" ? Math.max(0.1, it.trimEnd - it.trimStart) : Math.max(0.1, it.trimEnd);
}

// Given a global position along the whole sequence, finds which item it
// falls in and the offset within that item's OWN trimmed timeline.
function locate(items: TimelineItem[], atSec: number): { index: number; offset: number } | null {
  if (items.length === 0) return null;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const d = itemDur(items[i]);
    if (atSec < acc + d || i === items.length - 1) {
      return { index: i, offset: Math.max(0, Math.min(d, atSec - acc)) };
    }
    acc += d;
  }
  return { index: items.length - 1, offset: itemDur(items[items.length - 1]) };
}

function offsetOfItem(items: TimelineItem[], index: number): number {
  let acc = 0;
  for (let i = 0; i < index; i++) acc += itemDur(items[i]);
  return acc;
}

function totalDur(items: TimelineItem[]): number {
  return items.reduce((sum, it) => sum + itemDur(it), 0);
}

export default function ManualEditModal({
  apiBase,
  initialClips,
  boardClips,
  onClose,
}: {
  apiBase: string;
  initialClips: ManualEditSourceClip[];
  boardClips: ManualEditSourceClip[];
  onClose: () => void;
}) {
  const [items, setItems] = useState<TimelineItem[]>(() =>
    initialClips.map((c) => ({
      id: uid(),
      ...c,
      duration: c.kind === "image" ? DEFAULT_IMAGE_DURATION : 0,
      trimStart: 0,
      trimEnd: c.kind === "image" ? DEFAULT_IMAGE_DURATION : 0,
    }))
  );
  const [overlays, setOverlays] = useState<TextOverlay[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [addPickerOpen, setAddPickerOpen] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ url: string } | null>(null);
  const [exportProgress, setExportProgress] = useState<{ completedShots: number; totalShots: number; step: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const exportPollTimer = pollTimer; // alias for clarity at call sites below

  const trackRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const dragFromIndex = useRef<number | null>(null);
  const playTickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageElapsedRef = useRef(0);

  useEffect(() => stopPoll, []);
  useEffect(() => stopPlayback, []);

  const total = useMemo(() => totalDur(items), [items]);

  function updateItem(id: string, patch: Partial<TimelineItem>) {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function onVideoMeta(id: string, dur: number) {
    if (!Number.isFinite(dur) || dur <= 0) return;
    setItems((cur) => cur.map((it) => (it.id === id && it.duration === 0 ? { ...it, duration: dur, trimEnd: dur } : it)));
  }

  function removeItem(id: string) {
    setItems((cur) => cur.filter((it) => it.id !== id));
    setOverlays((cur) => cur.filter((o) => o.itemId !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  function addFromBoard(clip: ManualEditSourceClip) {
    const existingWithSameUrl = items.find((it) => it.url === clip.url && it.duration > 0);
    const newItem: TimelineItem = {
      id: uid(),
      nodeId: clip.nodeId,
      url: clip.url,
      kind: clip.kind,
      label: clip.label,
      duration: clip.kind === "image" ? DEFAULT_IMAGE_DURATION : existingWithSameUrl?.duration || 0,
      trimStart: 0,
      trimEnd:
        clip.kind === "image" ? DEFAULT_IMAGE_DURATION : existingWithSameUrl ? existingWithSameUrl.duration : 0,
    };
    setItems((cur) => [...cur, newItem]);
    setAddPickerOpen(false);
  }

  // ---- reordering (native HTML5 drag and drop) ----
  function onBlockDragStart(index: number) {
    return () => {
      dragFromIndex.current = index;
    };
  }
  function onBlockDragOver(e: React.DragEvent) {
    e.preventDefault();
  }
  function onBlockDrop(index: number) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragFromIndex.current;
      dragFromIndex.current = null;
      if (from === null || from === index) return;
      setItems((cur) => {
        const next = [...cur];
        const [moved] = next.splice(from, 1);
        next.splice(index, 0, moved);
        return next;
      });
    };
  }

  // ---- trimming (drag the block's own left/right edge) ----
  function beginTrimDrag(item: TimelineItem, which: "start" | "end") {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startTrimStart = item.trimStart;
      const startTrimEnd = item.trimEnd;
      function onMove(ev: MouseEvent) {
        const deltaSec = (ev.clientX - startX) / zoom;
        if (which === "start" && item.kind === "video") {
          const next = Math.max(0, Math.min(startTrimEnd - 0.2, startTrimStart + deltaSec));
          updateItem(item.id, { trimStart: next });
        } else {
          const maxEnd = item.kind === "video" ? item.duration || startTrimEnd + 999 : 600;
          const minEnd = item.kind === "video" ? startTrimStart + 0.2 : 0.5;
          const next = Math.max(minEnd, Math.min(maxEnd, startTrimEnd + deltaSec));
          updateItem(item.id, { trimEnd: next });
        }
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  // ---- split at playhead ----
  function canSplit(): boolean {
    const loc = locate(items, playheadSec);
    if (!loc) return false;
    const it = items[loc.index];
    if (it.kind !== "video") return false;
    return loc.offset > 0.15 && loc.offset < itemDur(it) - 0.15;
  }
  function splitAtPlayhead() {
    const loc = locate(items, playheadSec);
    if (!loc) return;
    const it = items[loc.index];
    if (it.kind !== "video") return;
    const splitPointInSource = it.trimStart + loc.offset;
    if (splitPointInSource <= it.trimStart + 0.1 || splitPointInSource >= it.trimEnd - 0.1) return;
    const left: TimelineItem = { ...it, id: uid(), trimEnd: splitPointInSource };
    const right: TimelineItem = { ...it, id: uid(), trimStart: splitPointInSource };
    setItems((cur) => {
      const next = [...cur];
      next.splice(loc.index, 1, left, right);
      return next;
    });
    // Overlays on the original clip stay attached to whichever half they
    // still temporally fall within; anything spanning the cut point just
    // stays on the left half rather than being duplicated or dropped.
    setOverlays((cur) =>
      cur.map((o) => {
        if (o.itemId !== it.id) return o;
        const cutOffsetInItem = splitPointInSource - it.trimStart;
        if (o.startSec < cutOffsetInItem) return o; // stays on left half (same id kept below)
        return { ...o, itemId: right.id, startSec: o.startSec - cutOffsetInItem, endSec: o.endSec - cutOffsetInItem };
      })
    );
    setOverlays((cur) => cur.map((o) => (o.itemId === it.id ? { ...o, itemId: left.id } : o)));
  }

  // ---- text overlays ----
  function addOverlay(itemId: string, clipTrimmedDur: number) {
    setOverlays((cur) => [...cur, { id: uid(), itemId, text: "", startSec: 0, endSec: Math.max(0.5, Math.min(3, clipTrimmedDur)) }]);
  }
  function updateOverlay(id: string, patch: Partial<TextOverlay>) {
    setOverlays((cur) => cur.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }
  function removeOverlay(id: string) {
    setOverlays((cur) => cur.filter((o) => o.id !== id));
  }

  // ---- combined play-through preview ----
  function stopPlayback() {
    if (playTickTimer.current) {
      clearInterval(playTickTimer.current);
      playTickTimer.current = null;
    }
    previewVideoRef.current?.pause();
  }

  function cueItem(index: number, offsetWithin: number) {
    const it = items[index];
    if (!it) return;
    if (it.kind === "video") {
      const v = previewVideoRef.current;
      if (!v) return;
      if (v.src !== it.url) v.src = it.url;
      v.currentTime = it.trimStart + offsetWithin;
    } else {
      imageElapsedRef.current = offsetWithin;
    }
  }

  function seekTo(sec: number) {
    const clamped = Math.max(0, Math.min(total, sec));
    setPlayheadSec(clamped);
    const loc = locate(items, clamped);
    if (loc) cueItem(loc.index, loc.offset);
  }

  function togglePlay() {
    if (playing) {
      stopPlayback();
      setPlaying(false);
      return;
    }
    if (items.length === 0) return;
    const startAt = playheadSec >= total - 0.05 ? 0 : playheadSec;
    const loc = locate(items, startAt);
    if (!loc) return;
    setPlayheadSec(startAt);
    cueItem(loc.index, loc.offset);
    const it = items[loc.index];
    if (it.kind === "video") previewVideoRef.current?.play().catch(() => {});
    setPlaying(true);

    playTickTimer.current = setInterval(() => {
      setItems((curItems) => {
        // Re-locate every tick off the LATEST items (in case of a mid-play
        // edit — unlikely mid-playback but keeps this from ever indexing a
        // stale/removed item).
        const v = previewVideoRef.current;
        setPlayheadSec((curHead) => {
          const curLoc = locate(curItems, curHead);
          if (!curLoc) return curHead;
          const curItem = curItems[curLoc.index];
          let withinItem: number;
          if (curItem.kind === "video") {
            withinItem = v ? Math.max(0, v.currentTime - curItem.trimStart) : curLoc.offset;
          } else {
            imageElapsedRef.current += 0.1;
            withinItem = imageElapsedRef.current;
          }
          const finishedItem = withinItem >= itemDur(curItem) - 0.05;
          if (!finishedItem) {
            return offsetOfItem(curItems, curLoc.index) + withinItem;
          }
          const nextIndex = curLoc.index + 1;
          if (nextIndex >= curItems.length) {
            stopPlayback();
            setPlaying(false);
            return totalDur(curItems);
          }
          const nextItem = curItems[nextIndex];
          if (nextItem.kind === "video" && v) {
            v.src = nextItem.url;
            v.currentTime = nextItem.trimStart;
            v.play().catch(() => {});
          } else {
            v?.pause();
            imageElapsedRef.current = 0;
          }
          return offsetOfItem(curItems, nextIndex);
        });
        return curItems;
      });
    }, 100);
  }

  function stopPoll() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function applyJob(job: any) {
    if (!job) return;
    setExportProgress({ completedShots: job.completedShots, totalShots: job.totalShots, step: job.step });
    if (job.status === "done") {
      setExportResult(job.result ? { url: `${job.result.url}?t=${Date.now()}` } : null);
      stopPoll();
      setExporting(false);
    } else if (job.status === "error") {
      setExportError(job.error || "Export failed");
      stopPoll();
      setExporting(false);
    }
  }

  async function pollStatus() {
    try {
      const res = await fetch(`${apiBase}/manual-render`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      applyJob(data.job);
    } catch {
      // A single poll failing isn't fatal — next tick retries.
    }
  }

  async function handleExport() {
    if (items.length === 0) {
      setExportError("Add at least one clip to the timeline first.");
      return;
    }
    stopPlayback();
    setPlaying(false);
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    setExportProgress(null);
    stopPoll();
    try {
      const clips = items.map((it) => ({
        nodeId: it.nodeId,
        url: it.url,
        kind: it.kind,
        trimStart: it.kind === "video" ? it.trimStart : 0,
        trimEnd: it.trimEnd,
        label: it.label,
      }));
      const textOverlays = overlays
        .map((o) => {
          const clipIndex = items.findIndex((it) => it.id === o.itemId);
          return clipIndex === -1 || !o.text.trim() ? null : { clipIndex, text: o.text, startSec: o.startSec, endSec: o.endSec };
        })
        .filter((o): o is { clipIndex: number; text: string; startSec: number; endSec: number } => o !== null);

      const res = await fetch(`${apiBase}/manual-render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips, textOverlays }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Export failed");
      applyJob(data.job);
      if (data.job?.status === "running") {
        exportPollTimer.current = setInterval(pollStatus, 2000);
      }
    } catch (err: any) {
      setExportError(err.message || "Export failed");
      setExporting(false);
    }
  }

  function onTrackClick(e: React.MouseEvent) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sec = (e.clientX - rect.left + (trackRef.current?.scrollLeft || 0)) / zoom;
    seekTo(sec);
  }

  const selected = items.find((it) => it.id === selectedId) || null;
  const selectedOverlays = selected ? overlays.filter((o) => o.itemId === selected.id) : [];
  const uniqueUrls = useMemo(() => Array.from(new Set(items.filter((it) => it.kind === "video").map((it) => it.url))), [items]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4 py-6">
      <div className="bg-panel border border-edge rounded-xl w-full max-w-4xl max-h-full shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge shrink-0">
          <div>
            <h3 className="text-zinc-900 font-semibold text-sm">✂️ Manual Edit</h3>
            <p className="text-[11px] text-zinc-500">
              Drag to trim/reorder/split, add text, then export. Not a full editor like CapCut — just the fundamentals.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900 text-lg leading-none">
            ✕
          </button>
        </div>

        {/* Hidden probes — one per unique video url currently in use, just to read real duration client-side (no backend probe needed). */}
        {uniqueUrls.map((url) => (
          <video
            key={url}
            src={url}
            preload="metadata"
            muted
            style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            onLoadedMetadata={(e) => {
              const dur = e.currentTarget.duration;
              setItems((cur) => cur.map((it) => (it.url === url && it.duration === 0 ? { ...it, duration: dur, trimEnd: dur } : it)));
            }}
          />
        ))}

        <div className="px-5 pt-3 flex flex-col gap-2 shrink-0">
          <div className="rounded-lg border border-edge bg-black flex items-center justify-center" style={{ height: 200 }}>
            <video ref={previewVideoRef} className="max-h-full max-w-full" onEnded={() => {}} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={togglePlay}
              disabled={items.length === 0}
              className="w-8 h-8 rounded-full bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs flex items-center justify-center shrink-0"
            >
              {playing ? "⏸" : "▶"}
            </button>
            <span className="text-[11px] text-zinc-500 tabular-nums shrink-0">
              {fmtTime(playheadSec)} / {fmtTime(total)}
            </span>
            <button
              onClick={splitAtPlayhead}
              disabled={!canSplit()}
              className="text-[11px] px-2 py-1 rounded border border-edge text-zinc-600 hover:text-zinc-900 disabled:opacity-30 shrink-0"
              title="Split the clip at the playhead"
            >
              ✂ Split
            </button>
            <div className="flex-1" />
            <span className="text-[10px] text-zinc-500">Zoom</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-24"
            />
          </div>
        </div>

        {/* ---- horizontal timeline ---- */}
        <div className="px-5 py-3 border-b border-edge shrink-0">
          <div ref={trackRef} onClick={onTrackClick} className="relative overflow-x-auto rounded-lg border border-edge bg-panel2" style={{ height: 84 }}>
            <div className="relative h-full" style={{ width: Math.max(200, total * zoom + 40) }}>
              {items.length === 0 && (
                <p className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
                  Timeline is empty — use "+ Add clip" below.
                </p>
              )}
              {items.map((it, i) => {
                const left = offsetOfItem(items, i) * zoom;
                const width = Math.max(6, itemDur(it) * zoom);
                const isSelected = it.id === selectedId;
                return (
                  <div
                    key={it.id}
                    draggable
                    onDragStart={onBlockDragStart(i)}
                    onDragOver={onBlockDragOver}
                    onDrop={onBlockDrop(i)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(it.id);
                    }}
                    className={`absolute top-2 bottom-2 rounded-md overflow-hidden cursor-grab active:cursor-grabbing border-2 ${
                      isSelected ? "border-brand-500" : "border-transparent"
                    }`}
                    style={{ left, width }}
                  >
                    <div className={`w-full h-full flex flex-col justify-between px-1.5 py-1 text-white text-[10px] ${it.kind === "video" ? "bg-indigo-500/80" : "bg-teal-500/80"}`}>
                      <span className="truncate font-medium">{it.label}</span>
                      <span className="tabular-nums opacity-80">{itemDur(it).toFixed(1)}s</span>
                    </div>
                    {it.kind === "video" && (
                      <div
                        onMouseDown={beginTrimDrag(it, "start")}
                        className="absolute top-0 bottom-0 left-0 w-2 bg-white/40 hover:bg-white/70 cursor-ew-resize"
                      />
                    )}
                    <div
                      onMouseDown={beginTrimDrag(it, "end")}
                      className="absolute top-0 bottom-0 right-0 w-2 bg-white/40 hover:bg-white/70 cursor-ew-resize"
                    />
                  </div>
                );
              })}
              <div className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none" style={{ left: playheadSec * zoom }} />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <div className="relative">
              <button
                onClick={() => setAddPickerOpen((v) => !v)}
                className="text-[11px] px-2.5 py-1.5 rounded border border-dashed border-edge2 text-zinc-600 hover:text-zinc-900 hover:border-brand-500"
              >
                + Add clip
              </button>
              {addPickerOpen && (
                <div className="absolute z-10 top-full left-0 mt-1 w-64 max-h-56 overflow-y-auto rounded-lg border border-edge bg-panel shadow-2xl">
                  {boardClips.length === 0 ? (
                    <p className="p-3 text-[11px] text-zinc-500">No other clips found on this board.</p>
                  ) : (
                    boardClips.map((c) => (
                      <button
                        key={c.nodeId}
                        onClick={() => addFromBoard(c)}
                        className="w-full text-left px-3 py-2 text-xs text-zinc-700 hover:bg-panel2 truncate"
                      >
                        {c.kind === "video" ? "🎬" : "🖼"} {c.label}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---- selected clip panel ---- */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {!selected ? (
            <p className="text-xs text-zinc-500">Click a clip on the timeline to trim it precisely or add text.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-zinc-900 font-medium truncate">{selected.label}</span>
                <button onClick={() => removeItem(selected.id)} className="text-zinc-400 hover:text-red-400 text-xs shrink-0">
                  🗑 Remove
                </button>
              </div>
              {selected.kind === "video" ? (
                <p className="text-[11px] text-zinc-500">
                  {selected.trimStart.toFixed(1)}s – {selected.trimEnd.toFixed(1)}s of {selected.duration > 0 ? selected.duration.toFixed(1) : "…"}s
                  (drag the block's edges on the timeline to adjust)
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-zinc-500">Show for</label>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={selected.trimEnd}
                    onChange={(e) => updateItem(selected.id, { trimEnd: Math.max(0.5, Number(e.target.value) || 0.5) })}
                    className="w-16 px-2 py-1 rounded border border-edge bg-panel2 text-xs text-zinc-900"
                  />
                  <span className="text-[11px] text-zinc-500">seconds</span>
                </div>
              )}

              {selectedOverlays.map((o) => (
                <div key={o.id} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={o.text}
                    onChange={(e) => updateOverlay(o.id, { text: e.target.value })}
                    placeholder="Caption text..."
                    className="flex-1 min-w-0 px-2 py-1 rounded border border-edge bg-panel2 text-xs text-zinc-900"
                  />
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={o.startSec}
                    onChange={(e) => updateOverlay(o.id, { startSec: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-14 px-1.5 py-1 rounded border border-edge bg-panel2 text-[11px] text-zinc-900"
                    title="Start (s)"
                  />
                  <span className="text-zinc-400 text-[10px]">–</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={o.endSec}
                    onChange={(e) => updateOverlay(o.id, { endSec: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-14 px-1.5 py-1 rounded border border-edge bg-panel2 text-[11px] text-zinc-900"
                    title="End (s)"
                  />
                  <button onClick={() => removeOverlay(o.id)} className="text-zinc-400 hover:text-red-400 text-xs shrink-0">
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => addOverlay(selected.id, itemDur(selected))}
                className="self-start text-[11px] text-brand-500 hover:text-brand-600"
              >
                + Add text
              </button>
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-edge shrink-0 flex flex-col gap-2.5">
          {exportError && <p className="text-xs text-red-400">{exportError}</p>}
          {exportResult && (
            <div className="flex items-center gap-3 flex-wrap">
              <video src={exportResult.url} controls className="h-16 rounded border border-edge" />
              <a href={exportResult.url} download className="px-3 py-1.5 rounded bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium">
                ⬇ Download MP4
              </a>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              disabled={exporting || items.length === 0}
              className="flex-1 py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium"
            >
              {exporting
                ? exportProgress && exportProgress.totalShots > 0
                  ? `Exporting ${exportProgress.completedShots}/${exportProgress.totalShots}...`
                  : "Starting..."
                : "Export"}
            </button>
            <button onClick={onClose} className="py-2.5 px-4 rounded-lg border border-edge text-zinc-700 hover:text-zinc-900 text-sm">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
