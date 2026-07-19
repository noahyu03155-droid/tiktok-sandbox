"use client";

// A simplified, in-website timeline editor — the "✂️ Manual Edit" button next
// to Regenerate on a render result card opens this. NOT a CapCut/Premiere
// replacement (there's no public way to embed either of those in a
// webpage) — this is an honestly-scoped alternative for a user who wants
// more precise, hands-on control than the AI render gives them: a real
// horizontal timeline with thumbnails, drag-to-trim/reorder, per-cut
// transitions, a combined play-through preview with a scrubbable playhead,
// split, simple styled text overlays, and one genuine AI feature
// (auto-caption a clip from its real audio via Whisper). Still not
// CapCut-level — no stickers, no effects library, no multi-track
// compositing — but pushed further toward "an actual timeline" than a flat
// list with sliders. Styled as its own dark, glass "editor" surface
// (independent of the app's light theme) since that's the visual language
// people expect from a cutting tool.
//
// Auto-imports the current chain's already-edited shots as the starting
// timeline (see StoryboardCanvas.tsx's openManualEdit), and lets the user
// pull in any other clip already uploaded elsewhere on the board via
// boardClips.

import { useEffect, useMemo, useRef, useState } from "react";

export interface ManualEditSourceClip {
  nodeId: string;
  url: string;
  kind: "video" | "image";
  label: string;
}

type TransitionPreset =
  | "hard_cut"
  | "fade"
  | "dissolve"
  | "wipeleft"
  | "wiperight"
  | "slideleft"
  | "slideright"
  | "slideup"
  | "slidedown"
  | "circleopen"
  | "circleclose";

const TRANSITION_LABELS: Record<TransitionPreset, string> = {
  hard_cut: "Hard cut",
  fade: "Fade",
  dissolve: "Dissolve",
  wipeleft: "Wipe left",
  wiperight: "Wipe right",
  slideleft: "Slide left",
  slideright: "Slide right",
  slideup: "Slide up",
  slidedown: "Slide down",
  circleopen: "Circle open",
  circleclose: "Circle close",
};
const TRANSITION_ORDER: TransitionPreset[] = [
  "hard_cut", "fade", "dissolve", "wipeleft", "wiperight", "slideleft", "slideright", "slideup", "slidedown", "circleopen", "circleclose",
];

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
  position: "top" | "center" | "bottom";
  size: "small" | "medium" | "large";
}

interface BoundaryTransition {
  preset: TransitionPreset;
  sec: number;
}

const DEFAULT_IMAGE_DURATION = 4;
const MIN_ZOOM = 15;
const MAX_ZOOM = 140;
const DEFAULT_ZOOM = 46; // pixels per second
const DEFAULT_TRANSITION: BoundaryTransition = { preset: "fade", sec: 0.25 };

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
  const [transitions, setTransitions] = useState<BoundaryTransition[]>([]);
  const [thumbsByUrl, setThumbsByUrl] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [openTransitionAt, setOpenTransitionAt] = useState<number | null>(null);
  const [autoCaptioning, setAutoCaptioning] = useState(false);
  const [autoCaptionError, setAutoCaptionError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ url: string } | null>(null);
  const [exportProgress, setExportProgress] = useState<{ completedShots: number; totalShots: number; step: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const trackRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const dragFromIndex = useRef<number | null>(null);
  const playTickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageElapsedRef = useRef(0);

  useEffect(() => stopPoll, []);
  useEffect(() => stopPlayback, []);

  // Keep exactly one transition entry per boundary (items.length - 1),
  // defaulting new boundaries to a plain fade — belongs to a BOUNDARY
  // POSITION, not a specific pair of clip identities, so reordering clips
  // reassigns transitions to whatever's now adjacent rather than trying to
  // follow the original pair around. Simple, and matches how most people
  // actually think about "the cut between slot 2 and slot 3."
  useEffect(() => {
    setTransitions((cur) => {
      const needed = Math.max(0, items.length - 1);
      if (cur.length === needed) return cur;
      const next = cur.slice(0, needed);
      while (next.length < needed) next.push({ ...DEFAULT_TRANSITION });
      return next;
    });
  }, [items.length]);

  const total = useMemo(() => totalDur(items), [items]);

  function updateItem(id: string, patch: Partial<TimelineItem>) {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
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

  // ---- thumbnail capture (client-side, no backend probe needed) ----
  function captureThumb(video: HTMLVideoElement, url: string) {
    try {
      const w = 96;
      const h = Math.round(w * ((video.videoHeight || 16) / (video.videoWidth || 9)));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      setThumbsByUrl((cur) => (cur[url] ? cur : { ...cur, [url]: dataUrl }));
    } catch {
      // Frame not ready / decode hiccup — block just stays without a
      // thumbnail, not worth failing anything over.
    }
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

  // ---- draggable/scrubbable playhead ----
  function beginPlayheadDrag(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (playing) {
      stopPlayback();
      setPlaying(false);
    }
    function onMove(ev: MouseEvent) {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sec = (ev.clientX - rect.left + (trackRef.current?.scrollLeft || 0)) / zoom;
      seekTo(sec);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
    // Overlays on the original clip land on whichever half they still
    // temporally fall within; anything spanning the cut point just stays on
    // the left half rather than being duplicated or dropped.
    const cutOffsetInItem = splitPointInSource - it.trimStart;
    setOverlays((cur) =>
      cur.map((o) => {
        if (o.itemId !== it.id) return o;
        if (o.startSec < cutOffsetInItem) return { ...o, itemId: left.id };
        return { ...o, itemId: right.id, startSec: o.startSec - cutOffsetInItem, endSec: o.endSec - cutOffsetInItem };
      })
    );
  }

  // ---- text overlays ----
  function addOverlay(itemId: string, clipTrimmedDur: number) {
    setOverlays((cur) => [
      ...cur,
      { id: uid(), itemId, text: "", startSec: 0, endSec: Math.max(0.5, Math.min(3, clipTrimmedDur)), position: "bottom", size: "medium" },
    ]);
  }
  function updateOverlay(id: string, patch: Partial<TextOverlay>) {
    setOverlays((cur) => cur.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }
  function removeOverlay(id: string) {
    setOverlays((cur) => cur.filter((o) => o.id !== id));
  }

  // ---- AI auto-caption (real speech-to-text on this clip's actual audio) ----
  async function autoCaption(item: TimelineItem) {
    if (item.kind !== "video") return;
    setAutoCaptioning(true);
    setAutoCaptionError(null);
    try {
      const res = await fetch(`${apiBase}/manual-transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: item.url, trimStart: item.trimStart, trimEnd: item.trimEnd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Auto-caption failed");
      const segs: { start: number; end: number; text: string }[] = Array.isArray(data.segments) ? data.segments : [];
      if (segs.length === 0) {
        setAutoCaptionError("No clear speech detected in this clip's trimmed range.");
        return;
      }
      setOverlays((cur) => [
        // Replaces any overlays already on this clip rather than piling
        // AI-generated ones on top of hand-written ones.
        ...cur.filter((o) => o.itemId !== item.id),
        ...segs.map((s) => ({ id: uid(), itemId: item.id, text: s.text, startSec: s.start, endSec: s.end, position: "bottom" as const, size: "medium" as const })),
      ]);
    } catch (err: any) {
      setAutoCaptionError(err.message || "Auto-caption failed");
    } finally {
      setAutoCaptioning(false);
    }
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
      const abs = new URL(it.url, window.location.href).href;
      if (v.src !== abs) v.src = it.url;
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
          return clipIndex === -1 || !o.text.trim()
            ? null
            : { clipIndex, text: o.text, startSec: o.startSec, endSec: o.endSec, position: o.position, size: o.size };
        })
        .filter((o): o is NonNullable<typeof o> => o !== null);

      const res = await fetch(`${apiBase}/manual-render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips, textOverlays, transitions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Export failed");
      applyJob(data.job);
      if (data.job?.status === "running") {
        pollTimer.current = setInterval(pollStatus, 2000);
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
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 px-4 py-6">
      <div
        className="w-full max-w-4xl max-h-full rounded-2xl flex flex-col overflow-hidden border border-white/10"
        style={{
          background: "linear-gradient(160deg, #0c1120 0%, #090c16 55%, #0a0e1a 100%)",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.03), 0 30px 80px -20px rgba(0,0,0,0.7), 0 0 60px -20px rgba(56,189,248,0.25)",
        }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 shrink-0 bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <span
              className="w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0"
              style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)", boxShadow: "0 0 16px -2px rgba(99,102,241,0.7)" }}
            >
              ✂️
            </span>
            <div>
              <h3 className="text-slate-100 font-semibold text-sm tracking-wide">Manual Edit</h3>
              <p className="text-[11px] text-slate-500">Drag to trim/reorder/split, pick per-cut transitions, style your text, then export.</p>
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-200 hover:bg-white/5 text-base leading-none transition-colors">
            ✕
          </button>
        </div>

        {/* Hidden probes — one per unique video url currently in use: reads
            real duration client-side (no backend probe needed) AND grabs a
            representative frame for the timeline block's thumbnail. */}
        {uniqueUrls.map((url) => (
          <video
            key={url}
            src={url}
            preload="metadata"
            muted
            style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setItems((cur) => cur.map((it) => (it.url === url && it.duration === 0 ? { ...it, duration: v.duration, trimEnd: v.duration } : it)));
              try {
                v.currentTime = Math.min(1, (v.duration || 2) / 3);
              } catch {
                // Some codecs/hosts don't like an immediate seek — thumbnail just stays blank.
              }
            }}
            onSeeked={(e) => captureThumb(e.currentTarget, url)}
          />
        ))}

        <div className="px-5 pt-4 flex flex-col gap-2.5 shrink-0">
          <div
            className="rounded-xl flex items-center justify-center relative overflow-hidden"
            style={{ height: 210, background: "#000", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "inset 0 0 40px rgba(0,0,0,0.6)" }}
          >
            <video ref={previewVideoRef} className="max-h-full max-w-full relative z-10" />
            {items.length === 0 && <span className="absolute text-slate-600 text-xs tracking-wide">NO SIGNAL</span>}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={togglePlay}
              disabled={items.length === 0}
              className="w-9 h-9 rounded-full text-white text-xs flex items-center justify-center shrink-0 disabled:opacity-30 transition-transform hover:scale-105"
              style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)", boxShadow: "0 0 14px -3px rgba(99,102,241,0.8)" }}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <span className="text-[11px] text-cyan-300/90 font-mono tabular-nums shrink-0">
              {fmtTime(playheadSec)} <span className="text-slate-600">/ {fmtTime(total)}</span>
            </span>
            <button
              onClick={splitAtPlayhead}
              disabled={!canSplit()}
              className="text-[11px] px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:text-white hover:border-cyan-400/50 hover:bg-white/5 disabled:opacity-30 shrink-0 transition-colors"
              title="Split the clip at the playhead"
            >
              ✂ Split
            </button>
            <div className="flex-1" />
            <span className="text-[10px] text-slate-500 tracking-wide uppercase">Zoom</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-24 accent-cyan-400"
            />
          </div>
        </div>

        {/* ---- horizontal timeline ---- */}
        <div className="px-5 py-3.5 border-b border-white/10 shrink-0">
          <div
            ref={trackRef}
            onClick={onTrackClick}
            className="relative overflow-x-auto overflow-y-visible rounded-xl"
            style={{
              height: 96,
              background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 1px, transparent 1px, transparent 46px), #0b0f1c",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div className="relative h-full" style={{ width: Math.max(200, total * zoom + 40) }}>
              {items.length === 0 && (
                <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-600">
                  Timeline is empty — use "+ Add clip" below.
                </p>
              )}
              {items.map((it, i) => {
                const left = offsetOfItem(items, i) * zoom;
                const width = Math.max(6, itemDur(it) * zoom);
                const isSelected = it.id === selectedId;
                const thumb = it.kind === "video" ? thumbsByUrl[it.url] : it.url;
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
                    className="absolute top-2 bottom-2 rounded-lg overflow-hidden cursor-grab active:cursor-grabbing transition-shadow"
                    style={{
                      left,
                      width,
                      boxShadow: isSelected ? "0 0 0 2px #22d3ee, 0 0 16px -2px rgba(34,211,238,0.7)" : "0 0 0 1px rgba(255,255,255,0.08)",
                    }}
                  >
                    <div
                      className="w-full h-full flex flex-col justify-between px-1.5 py-1 text-white text-[10px] bg-cover bg-center"
                      style={{
                        background: it.kind === "video"
                          ? "linear-gradient(135deg, rgba(99,102,241,0.9), rgba(79,70,229,0.85))"
                          : "linear-gradient(135deg, rgba(20,184,166,0.9), rgba(8,145,178,0.85))",
                        backgroundImage: thumb ? `linear-gradient(to top, rgba(2,6,23,.7), rgba(2,6,23,.15) 55%), url(${thumb})` : undefined,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }}
                    >
                      <span className="truncate font-medium drop-shadow-sm">{it.label}</span>
                      <span className="tabular-nums font-mono opacity-90 drop-shadow-sm">{itemDur(it).toFixed(1)}s</span>
                    </div>
                    {it.kind === "video" && (
                      <div onMouseDown={beginTrimDrag(it, "start")} className="absolute top-0 bottom-0 left-0 w-2 bg-cyan-300/0 hover:bg-cyan-300/60 cursor-ew-resize transition-colors" />
                    )}
                    <div onMouseDown={beginTrimDrag(it, "end")} className="absolute top-0 bottom-0 right-0 w-2 bg-cyan-300/0 hover:bg-cyan-300/60 cursor-ew-resize transition-colors" />
                  </div>
                );
              })}

              {/* Per-boundary transition pickers — one small connector chip
                  between each adjacent pair of blocks. */}
              {items.slice(0, -1).map((_, i) => {
                const x = offsetOfItem(items, i + 1) * zoom;
                const trans = transitions[i] || DEFAULT_TRANSITION;
                return (
                  <div key={`boundary-${i}`} className="absolute top-1/2 -translate-y-1/2 z-20" style={{ left: x - 9 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenTransitionAt((cur) => (cur === i ? null : i));
                      }}
                      title={TRANSITION_LABELS[trans.preset]}
                      className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px] text-cyan-200 transition-colors hover:text-white"
                      style={{ background: "#0f1424", border: "1px solid rgba(34,211,238,0.4)", boxShadow: "0 0 8px -2px rgba(34,211,238,0.5)" }}
                    >
                      ⇄
                    </button>
                    {openTransitionAt === i && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute z-30 top-full mt-1.5 left-1/2 -translate-x-1/2 w-40 p-2 rounded-lg flex flex-col gap-1.5"
                        style={{ background: "#0f1424", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 30px -8px rgba(0,0,0,0.7)" }}
                      >
                        <select
                          value={trans.preset}
                          onChange={(e) =>
                            setTransitions((cur) => cur.map((t, idx) => (idx === i ? { ...t, preset: e.target.value as TransitionPreset } : t)))
                          }
                          className="text-[11px] px-1.5 py-1 rounded border border-white/10 bg-black/40 text-slate-100"
                        >
                          {TRANSITION_ORDER.map((p) => (
                            <option key={p} value={p} className="bg-[#0f1424]">
                              {TRANSITION_LABELS[p]}
                            </option>
                          ))}
                        </select>
                        {trans.preset !== "hard_cut" && (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="range"
                              min={0.1}
                              max={1}
                              step={0.05}
                              value={trans.sec}
                              onChange={(e) =>
                                setTransitions((cur) => cur.map((t, idx) => (idx === i ? { ...t, sec: Number(e.target.value) } : t)))
                              }
                              className="flex-1 accent-cyan-400"
                            />
                            <span className="text-[10px] text-slate-400 font-mono tabular-nums w-8 text-right">{trans.sec.toFixed(2)}s</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div onMouseDown={beginPlayheadDrag} className="absolute top-0 bottom-0 w-3 z-10 cursor-ew-resize group" style={{ left: playheadSec * zoom - 6 }}>
                <div
                  className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45"
                  style={{ background: "#22d3ee", boxShadow: "0 0 8px rgba(34,211,238,0.9)" }}
                />
                <div className="absolute inset-y-0 left-1.5 w-px pointer-events-none" style={{ background: "#22d3ee", boxShadow: "0 0 6px rgba(34,211,238,0.9)" }} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <div className="relative">
              <button
                onClick={() => setAddPickerOpen((v) => !v)}
                className="text-[11px] px-3 py-1.5 rounded-lg border border-dashed border-white/15 text-slate-400 hover:text-cyan-300 hover:border-cyan-400/50 transition-colors"
              >
                + Add clip
              </button>
              {addPickerOpen && (
                <div
                  className="absolute z-10 top-full left-0 mt-1.5 w-64 max-h-56 overflow-y-auto rounded-xl"
                  style={{ background: "#0f1424", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 30px -8px rgba(0,0,0,0.7)" }}
                >
                  {boardClips.length === 0 ? (
                    <p className="p-3 text-[11px] text-slate-500">No other clips found on this board.</p>
                  ) : (
                    boardClips.map((c) => (
                      <button key={c.nodeId} onClick={() => addFromBoard(c)} className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white truncate transition-colors">
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
        <div className="flex-1 overflow-y-auto px-5 py-3.5">
          {!selected ? (
            <p className="text-xs text-slate-500">Click a clip on the timeline to trim it precisely, caption it, or add text.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-100 font-medium truncate">{selected.label}</span>
                <button onClick={() => removeItem(selected.id)} className="text-slate-500 hover:text-rose-400 text-xs shrink-0 transition-colors">
                  🗑 Remove
                </button>
              </div>
              {selected.kind === "video" ? (
                <p className="text-[11px] text-slate-500 font-mono">
                  {selected.trimStart.toFixed(1)}s – {selected.trimEnd.toFixed(1)}s of {selected.duration > 0 ? selected.duration.toFixed(1) : "…"}s
                  <span className="font-sans"> (drag the block's edges on the timeline to adjust)</span>
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-slate-500">Show for</label>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={selected.trimEnd}
                    onChange={(e) => updateItem(selected.id, { trimEnd: Math.max(0.5, Number(e.target.value) || 0.5) })}
                    className="w-16 px-2 py-1 rounded border border-white/10 bg-black/30 text-xs text-slate-100"
                  />
                  <span className="text-[11px] text-slate-500">seconds</span>
                </div>
              )}

              {selected.kind === "video" && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => autoCaption(selected)}
                    disabled={autoCaptioning}
                    className="text-[11px] px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:text-white hover:border-violet-400/50 hover:bg-white/5 disabled:opacity-50 transition-colors"
                    style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(34,211,238,0.08))" }}
                  >
                    {autoCaptioning ? "Transcribing..." : "🎙 Auto-caption (AI)"}
                  </button>
                  {autoCaptionError && <span className="text-[11px] text-rose-400">{autoCaptionError}</span>}
                </div>
              )}

              {selectedOverlays.map((o) => (
                <div key={o.id} className="flex flex-col gap-1.5 rounded-lg p-2.5" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={o.text}
                      onChange={(e) => updateOverlay(o.id, { text: e.target.value })}
                      placeholder="Caption text..."
                      className="flex-1 min-w-0 px-2 py-1 rounded border border-white/10 bg-black/30 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-400/50"
                    />
                    <button onClick={() => removeOverlay(o.id)} className="text-slate-500 hover:text-rose-400 text-xs shrink-0 transition-colors">
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={o.startSec}
                      onChange={(e) => updateOverlay(o.id, { startSec: Math.max(0, Number(e.target.value) || 0) })}
                      className="w-14 px-1.5 py-1 rounded border border-white/10 bg-black/30 text-[11px] text-slate-100 font-mono"
                      title="Start (s)"
                    />
                    <span className="text-slate-600 text-[10px]">–</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={o.endSec}
                      onChange={(e) => updateOverlay(o.id, { endSec: Math.max(0, Number(e.target.value) || 0) })}
                      className="w-14 px-1.5 py-1 rounded border border-white/10 bg-black/30 text-[11px] text-slate-100 font-mono"
                      title="End (s)"
                    />
                    <select
                      value={o.position}
                      onChange={(e) => updateOverlay(o.id, { position: e.target.value as TextOverlay["position"] })}
                      className="text-[11px] px-1.5 py-1 rounded border border-white/10 bg-black/30 text-slate-100"
                    >
                      <option value="top" className="bg-[#0f1424]">Top</option>
                      <option value="center" className="bg-[#0f1424]">Center</option>
                      <option value="bottom" className="bg-[#0f1424]">Bottom</option>
                    </select>
                    <select
                      value={o.size}
                      onChange={(e) => updateOverlay(o.id, { size: e.target.value as TextOverlay["size"] })}
                      className="text-[11px] px-1.5 py-1 rounded border border-white/10 bg-black/30 text-slate-100"
                    >
                      <option value="small" className="bg-[#0f1424]">Small</option>
                      <option value="medium" className="bg-[#0f1424]">Medium</option>
                      <option value="large" className="bg-[#0f1424]">Large</option>
                    </select>
                  </div>
                </div>
              ))}
              <button onClick={() => addOverlay(selected.id, itemDur(selected))} className="self-start text-[11px] text-cyan-400 hover:text-cyan-300 transition-colors">
                + Add text
              </button>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-white/10 shrink-0 flex flex-col gap-2.5 bg-white/[0.015]">
          {exportError && <p className="text-xs text-rose-400">{exportError}</p>}
          {exportResult && (
            <div className="flex items-center gap-3 flex-wrap">
              <video src={exportResult.url} controls className="h-16 rounded-lg" style={{ border: "1px solid rgba(255,255,255,0.1)" }} />
              <a
                href={exportResult.url}
                download
                className="px-3.5 py-1.5 rounded-lg text-white text-xs font-medium transition-transform hover:scale-105"
                style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)", boxShadow: "0 0 14px -3px rgba(99,102,241,0.8)" }}
              >
                ⬇ Download MP4
              </a>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              disabled={exporting || items.length === 0}
              className="flex-1 py-2.5 rounded-xl text-white text-sm font-medium disabled:opacity-40 transition-transform hover:enabled:scale-[1.01]"
              style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)", boxShadow: "0 4px 20px -4px rgba(99,102,241,0.6)" }}
            >
              {exporting ? (exportProgress && exportProgress.totalShots > 0 ? `Exporting ${exportProgress.completedShots}/${exportProgress.totalShots}...` : "Starting...") : "Export"}
            </button>
            <button onClick={onClose} className="py-2.5 px-4 rounded-xl border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 text-sm transition-colors">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
