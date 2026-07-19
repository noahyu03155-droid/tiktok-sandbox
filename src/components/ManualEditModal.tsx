"use client";

// A simplified, in-website timeline editor — the "✂️ Manual Edit" button next
// to Regenerate on a render result card opens this. NOT a CapCut/Premiere
// replacement (there's no public way to embed either of those in a
// webpage) — this is an honestly-scoped alternative for a user who wants
// more precise, hands-on control than the AI render gives them: trim each
// shot's in/out point by dragging, reorder shots, and drop in simple text
// overlays, then export. No transitions library, no stickers, no AI
// features — just the fundamentals.
//
// Auto-imports the current chain's already-edited shots (whatever clips are
// currently attached to the rendered chain) as the starting timeline, per
// the explicit request that this shouldn't start from an empty project.

import { useEffect, useRef, useState } from "react";

export interface ManualEditSourceClip {
  nodeId: string;
  url: string;
  kind: "video" | "image";
  label: string;
}

interface EditableClip extends ManualEditSourceClip {
  duration: number; // 0 until probed for video (see hidden <video> metadata probe below); a fixed default for images
  trimStart: number;
  trimEnd: number;
}

interface TextOverlay {
  id: string;
  nodeId: string; // tracks the clip by identity, not array index, so reordering clips can't silently misattach an overlay to the wrong one
  text: string;
  startSec: number;
  endSec: number;
}

const DEFAULT_IMAGE_DURATION = 4;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// A lightweight two-handle range slider — drags the left/right handle to set
// trimStart/trimEnd within [0, duration]. Built with plain mouse events
// (same pattern as the resize/drag handles elsewhere on the canvas) rather
// than trying to fake a dual-thumb look out of two overlapping native
// <input type="range">s, which is fiddly to get pointer-events right on.
function TrimSlider({
  duration,
  start,
  end,
  onChange,
}: {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = (v: number) => (duration > 0 ? Math.min(100, Math.max(0, (v / duration) * 100)) : 0);

  function beginDrag(which: "start" | "end") {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      function onMove(ev: MouseEvent) {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        const t = ratio * duration;
        if (which === "start") onChange(Math.min(t, end - 0.2), end);
        else onChange(start, Math.max(t, start + 0.2));
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  return (
    <div className="relative h-6 select-none" ref={trackRef}>
      <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 rounded bg-edge2" />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded bg-brand-500"
        style={{ left: `${pct(start)}%`, width: `${Math.max(0, pct(end) - pct(start))}%` }}
      />
      <div
        onMouseDown={beginDrag("start")}
        title={`Start: ${start.toFixed(1)}s`}
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border-2 border-brand-500 cursor-ew-resize shadow"
        style={{ left: `calc(${pct(start)}% - 8px)` }}
      />
      <div
        onMouseDown={beginDrag("end")}
        title={`End: ${end.toFixed(1)}s`}
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border-2 border-brand-500 cursor-ew-resize shadow"
        style={{ left: `calc(${pct(end)}% - 8px)` }}
      />
    </div>
  );
}

export default function ManualEditModal({
  apiBase,
  initialClips,
  onClose,
}: {
  apiBase: string;
  initialClips: ManualEditSourceClip[];
  onClose: () => void;
}) {
  const [items, setItems] = useState<EditableClip[]>(() =>
    initialClips.map((c) => ({
      ...c,
      duration: c.kind === "image" ? DEFAULT_IMAGE_DURATION : 0,
      trimStart: 0,
      trimEnd: c.kind === "image" ? DEFAULT_IMAGE_DURATION : 0,
    }))
  );
  const [overlays, setOverlays] = useState<TextOverlay[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ url: string } | null>(null);
  const [exportProgress, setExportProgress] = useState<{ completedShots: number; totalShots: number; step: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => stopPoll, []);

  function updateItem(nodeId: string, patch: Partial<EditableClip>) {
    setItems((cur) => cur.map((it) => (it.nodeId === nodeId ? { ...it, ...patch } : it)));
  }

  function onVideoMeta(nodeId: string, dur: number) {
    if (!Number.isFinite(dur) || dur <= 0) return;
    updateItem(nodeId, { duration: dur, trimEnd: dur });
  }

  function moveItem(index: number, dir: -1 | 1) {
    setItems((cur) => {
      const next = [...cur];
      const target = index + dir;
      if (target < 0 || target >= next.length) return cur;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeItem(nodeId: string) {
    setItems((cur) => cur.filter((it) => it.nodeId !== nodeId));
    setOverlays((cur) => cur.filter((o) => o.nodeId !== nodeId));
  }

  function addOverlay(nodeId: string, clipTrimmedDur: number) {
    setOverlays((cur) => [
      ...cur,
      { id: uid(), nodeId, text: "", startSec: 0, endSec: Math.max(0.5, Math.min(3, clipTrimmedDur)) },
    ]);
  }

  function updateOverlay(id: string, patch: Partial<TextOverlay>) {
    setOverlays((cur) => cur.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  function removeOverlay(id: string) {
    setOverlays((cur) => cur.filter((o) => o.id !== id));
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
      // A single poll failing is not fatal — next tick retries.
    }
  }

  async function handleExport() {
    if (items.length === 0) {
      setExportError("Add at least one clip to the timeline first.");
      return;
    }
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
          const clipIndex = items.findIndex((it) => it.nodeId === o.nodeId);
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
        pollTimer.current = setInterval(pollStatus, 2000);
      }
    } catch (err: any) {
      setExportError(err.message || "Export failed");
      setExporting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4 py-6">
      <div className="bg-panel border border-edge rounded-xl w-full max-w-2xl max-h-full shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge shrink-0">
          <div>
            <h3 className="text-zinc-900 font-semibold text-sm">✂️ Manual Edit</h3>
            <p className="text-[11px] text-zinc-500">
              Trim, reorder, and caption your shots yourself. Not a full editor like CapCut — just the basics.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900 text-lg leading-none">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {items.length === 0 && <p className="text-sm text-zinc-500">No clips on the timeline. Nothing was imported from this chain.</p>}

          {items.map((it, i) => {
            const overlaysForClip = overlays.filter((o) => o.nodeId === it.nodeId);
            const trimmedDur = it.kind === "video" ? Math.max(0, it.trimEnd - it.trimStart) : it.trimEnd;
            return (
              <div key={it.nodeId} className="rounded-lg border border-edge p-3 flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <button
                      onClick={() => moveItem(i, -1)}
                      disabled={i === 0}
                      className="w-5 h-5 flex items-center justify-center rounded border border-edge text-[10px] text-zinc-600 disabled:opacity-30 hover:text-zinc-900"
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => moveItem(i, 1)}
                      disabled={i === items.length - 1}
                      className="w-5 h-5 flex items-center justify-center rounded border border-edge text-[10px] text-zinc-600 disabled:opacity-30 hover:text-zinc-900"
                      title="Move down"
                    >
                      ▼
                    </button>
                  </div>
                  <span className="text-xs font-medium text-zinc-500 w-5 shrink-0">{i + 1}</span>
                  <span className="text-sm text-zinc-900 truncate flex-1">{it.label || "Untitled shot"}</span>
                  <button onClick={() => removeItem(it.nodeId)} className="text-zinc-400 hover:text-red-400 text-xs shrink-0" title="Remove from timeline">
                    🗑
                  </button>
                </div>

                <div className="flex gap-3">
                  {it.kind === "video" ? (
                    <video
                      src={it.url}
                      muted
                      controls
                      className="w-24 h-40 rounded border border-edge bg-black object-cover shrink-0"
                      onLoadedMetadata={(e) => onVideoMeta(it.nodeId, e.currentTarget.duration)}
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.url} alt={it.label} className="w-24 h-40 rounded border border-edge object-cover shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 flex flex-col gap-2 justify-center">
                    {it.kind === "video" ? (
                      it.duration > 0 ? (
                        <>
                          <TrimSlider
                            duration={it.duration}
                            start={it.trimStart}
                            end={it.trimEnd}
                            onChange={(s, e) => updateItem(it.nodeId, { trimStart: s, trimEnd: e })}
                          />
                          <p className="text-[11px] text-zinc-500">
                            {it.trimStart.toFixed(1)}s – {it.trimEnd.toFixed(1)}s of {it.duration.toFixed(1)}s ({trimmedDur.toFixed(1)}s used)
                          </p>
                        </>
                      ) : (
                        <p className="text-[11px] text-zinc-500">Loading clip length...</p>
                      )
                    ) : (
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] text-zinc-500">Show for</label>
                        <input
                          type="number"
                          min={0.5}
                          step={0.5}
                          value={it.trimEnd}
                          onChange={(e) => updateItem(it.nodeId, { trimEnd: Math.max(0.5, Number(e.target.value) || 0.5) })}
                          className="w-16 px-2 py-1 rounded border border-edge bg-panel2 text-xs text-zinc-900"
                        />
                        <span className="text-[11px] text-zinc-500">seconds</span>
                      </div>
                    )}

                    {overlaysForClip.map((o) => (
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
                      onClick={() => addOverlay(it.nodeId, trimmedDur)}
                      className="self-start text-[11px] text-brand-500 hover:text-brand-600"
                    >
                      + Add text
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
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
