"use client";

import { useEffect, useRef, useState } from "react";
import type { GeneratedScript, StoryboardClip, StoryboardNode, StoryboardState } from "@/lib/types";
import { resolveStoryboardOrder } from "@/lib/storyboard";
import StoryboardLibraryPicker, { type LibraryClipChoice } from "./StoryboardLibraryPicker";

// Phase 1 (revised): a freeform storyboard canvas. Nodes are NOT locked 1:1
// to the script's stages — they're seeded from the 6 beats on first open,
// but from then on the user can add/split/delete/rewrite them and rewire
// connections into any shape. Each node owns its own editable label +
// instruction text (the prompt a human editor, or the AI reference-image
// generator, works from) plus one attached clip. A "Render video" pass
// walks the connection graph to resolve a single shot order, then stitches
// whatever real clips/reference stills are attached into one downloadable
// MP4 via ffmpeg — hard cuts only, no AI-generated video content (that
// would need a dedicated identity-preserving video-gen API the team hasn't
// picked/paid for yet; explicitly out of scope for this pass).

const NODE_W = 300;
const NODE_H = 430;
const CLIP_H = 150;
const GAP_X = 70;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

const ACCENTS = ["#5cc4ee", "#f472b6", "#facc15", "#4ade80", "#a78bfa", "#fb923c"];

function seedInstruction(script: string, direction: string) {
  return [script, direction ? `🎬 ${direction}` : ""].filter(Boolean).join("\n\n");
}

function defaultStoryboard(script: GeneratedScript): StoryboardState {
  const nodes: StoryboardNode[] = script.stages.map((stage, i) => ({
    id: crypto.randomUUID(),
    label: stage.label,
    instruction: seedInstruction(stage.script, stage.direction),
    x: 60 + i * (NODE_W + GAP_X),
    y: 120,
    clip: null,
  }));
  const connections = nodes.slice(0, -1).map((n, i) => ({
    id: crypto.randomUUID(),
    fromId: n.id,
    toId: nodes[i + 1].id,
  }));
  return { nodes, connections, direction: "", zoom: 1, pan: { x: 40, y: 40 } };
}

export default function StoryboardCanvas({
  videoId,
  script,
  onClose,
}: {
  videoId: string;
  script: GeneratedScript;
  onClose: () => void;
}) {
  const [board, setBoard] = useState<StoryboardState>(() => script.storyboard || defaultStoryboard(script));
  const [pickerForNode, setPickerForNode] = useState<string | null>(null);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  // Click-to-connect (not drag-to-connect — the dots are small and dragging
  // precisely onto another one was fiddly). Click a dot to arm a connection
  // from that node; a dashed line then follows the cursor; click any dot on
  // a different node to complete it (solid line), click the same dot again
  // or press Escape to cancel.
  const [connStart, setConnStart] = useState<string | null>(null);
  const [connDraft, setConnDraft] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!connStart) return;
    function onMove(ev: MouseEvent) {
      setConnDraft(toWorld(ev.clientX, ev.clientY));
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setConnStart(null);
        setConnDraft(null);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connStart]);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<{ url: string; skipped: string[] } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadNodeIdRef = useRef<string | null>(null);

  // ---- autosave (debounced) ----
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(`/api/videos/${videoId}/generate-script/${script.id}/storyboard`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(board),
      })
        .then((res) => setSaveStatus(res.ok ? "saved" : "error"))
        .catch(() => setSaveStatus("error"));
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  function toWorld(clientX: number, clientY: number) {
    const rect = viewportRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: (clientX - left - board.pan.x) / board.zoom,
      y: (clientY - top - board.pan.y) / board.zoom,
    };
  }

  // ---- panning the background ----
  function handleBackgroundMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (connStart) {
      setConnStart(null);
      setConnDraft(null);
      return;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const originPan = board.pan;
    function onMove(ev: MouseEvent) {
      setBoard((b) => ({ ...b, pan: { x: originPan.x + (ev.clientX - startX), y: originPan.y + (ev.clientY - startY) } }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const mouseX = e.clientX - (rect?.left ?? 0);
    const mouseY = e.clientY - (rect?.top ?? 0);
    setBoard((b) => {
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, b.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      const worldX = (mouseX - b.pan.x) / b.zoom;
      const worldY = (mouseY - b.pan.y) / b.zoom;
      return { ...b, zoom: nextZoom, pan: { x: mouseX - worldX * nextZoom, y: mouseY - worldY * nextZoom } };
    });
  }

  function zoomBy(factor: number) {
    setBoard((b) => ({ ...b, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, b.zoom * factor)) }));
  }

  // ---- dragging a node ----
  function handleNodeMouseDown(e: React.MouseEvent, node: StoryboardNode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = node.x;
    const originY = node.y;
    function onMove(ev: MouseEvent) {
      const dx = (ev.clientX - startX) / board.zoom;
      const dy = (ev.clientY - startY) / board.zoom;
      setBoard((b) => ({
        ...b,
        nodes: b.nodes.map((n) => (n.id === node.id ? { ...n, x: originX + dx, y: originY + dy } : n)),
      }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ---- click-to-connect ----
  function handleDotClick(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    if (!connStart) {
      setConnStart(nodeId);
      setConnDraft(toWorld(e.clientX, e.clientY));
      return;
    }
    if (connStart === nodeId) {
      // clicked the node's own dot again — cancel
      setConnStart(null);
      setConnDraft(null);
      return;
    }
    setBoard((b) => {
      const exists = b.connections.some(
        (c) => (c.fromId === connStart && c.toId === nodeId) || (c.fromId === nodeId && c.toId === connStart)
      );
      if (exists) return b;
      return { ...b, connections: [...b.connections, { id: crypto.randomUUID(), fromId: connStart, toId: nodeId }] };
    });
    setConnStart(null);
    setConnDraft(null);
  }

  function removeConnection(id: string) {
    setBoard((b) => ({ ...b, connections: b.connections.filter((c) => c.id !== id) }));
  }

  // ---- node CRUD ----
  function addNode() {
    const rightmost = board.nodes.reduce((max, n) => Math.max(max, n.x), 0);
    const node: StoryboardNode = {
      id: crypto.randomUUID(),
      label: `Shot ${board.nodes.length + 1}`,
      instruction: "",
      x: board.nodes.length === 0 ? 60 : rightmost + NODE_W + GAP_X,
      y: 120,
      clip: null,
    };
    setBoard((b) => ({ ...b, nodes: [...b.nodes, node] }));
  }

  function deleteNode(nodeId: string) {
    setBoard((b) => ({
      ...b,
      nodes: b.nodes.filter((n) => n.id !== nodeId),
      connections: b.connections.filter((c) => c.fromId !== nodeId && c.toId !== nodeId),
    }));
  }

  function updateNodeText(nodeId: string, patch: Partial<Pick<StoryboardNode, "label" | "instruction">>) {
    setBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }));
  }

  // ---- clip attach flows ----
  function setNodeClip(nodeId: string, clip: StoryboardClip | null) {
    setBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId ? { ...n, clip } : n)) }));
  }

  function clearNodeError(nodeId: string) {
    setNodeErrors((prev) => {
      if (!(nodeId in prev)) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
  }

  function startUpload(nodeId: string) {
    uploadNodeIdRef.current = nodeId;
    fileInputRef.current?.click();
  }

  async function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const nodeId = uploadNodeIdRef.current;
    e.target.value = "";
    if (!file || !nodeId) return;
    setBusyNodeId(nodeId);
    clearNodeError(nodeId);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("nodeId", nodeId);
      const res = await fetch(`/api/videos/${videoId}/generate-script/${script.id}/storyboard/upload`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setNodeClip(nodeId, { source: "upload", url: data.url, kind: data.kind });
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [nodeId]: err.message || "Upload failed" }));
    } finally {
      setBusyNodeId(null);
    }
  }

  async function generateAiImage(node: StoryboardNode) {
    setBusyNodeId(node.id);
    clearNodeError(node.id);
    try {
      const res = await fetch(`/api/videos/${videoId}/generate-script/${script.id}/storyboard/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, label: node.label, instruction: node.instruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setNodeClip(node.id, { source: "ai", url: data.url, kind: data.kind });
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [node.id]: err.message || "Generation failed" }));
    } finally {
      setBusyNodeId(null);
    }
  }

  function handleLibraryPick(choice: LibraryClipChoice) {
    const nodeId = pickerForNode;
    setPickerForNode(null);
    if (!nodeId) return;
    if (choice.videoUrl) {
      setNodeClip(nodeId, { source: "library", url: choice.videoUrl, kind: "video", libraryVideoId: choice.videoId });
    } else if (choice.thumbUrl) {
      setNodeClip(nodeId, { source: "library", url: choice.thumbUrl, kind: "image", libraryVideoId: choice.videoId });
    }
  }

  async function renderVideo() {
    setRendering(true);
    setRenderError(null);
    setRenderResult(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/generate-script/${script.id}/storyboard/render`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Render failed");
      setRenderResult({ url: data.url, skipped: data.skipped || [] });
    } catch (err: any) {
      setRenderError(err.message || "Render failed");
    } finally {
      setRendering(false);
    }
  }

  const nodeById = new Map(board.nodes.map((n) => [n.id, n] as const));
  const order = resolveStoryboardOrder(board.nodes, board.connections);
  const orderNumber = new Map(order.map((n, i) => [n.id, i + 1] as const));

  return (
    <div className="fixed inset-0 bg-black/85 z-50 flex flex-col">
      <input ref={fileInputRef} type="file" accept="video/*,image/*" className="hidden" onChange={handleFileChosen} />

      <div className="flex items-center justify-between px-5 py-3 border-b border-edge bg-panel shrink-0 flex-wrap gap-2">
        <div>
          <h3 className="text-white font-semibold text-sm">Generate Video — Storyboard</h3>
          <p className="text-xs text-zinc-500">
            Drag cards to arrange · edit any card's text · click a dot, then click another card's dot to connect (Esc to cancel) · numbers show render order.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs flex items-center gap-1.5 text-zinc-500 mr-1">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                saveStatus === "saving"
                  ? "bg-yellow-400 animate-pulse"
                  : saveStatus === "error"
                  ? "bg-red-400"
                  : saveStatus === "saved"
                  ? "bg-green-400"
                  : "bg-transparent"
              }`}
            />
            {saveStatus === "saving" && "Saving..."}
            {saveStatus === "saved" && "Saved"}
            {saveStatus === "error" && "Save failed"}
          </span>
          <button onClick={addNode} className="px-2.5 h-7 rounded border border-edge text-zinc-300 hover:text-white hover:border-edge2 text-xs">
            + Add shot
          </button>
          <button onClick={() => zoomBy(1.2)} className="w-7 h-7 rounded border border-edge text-zinc-300 hover:text-white hover:border-edge2 text-sm">
            +
          </button>
          <button onClick={() => zoomBy(1 / 1.2)} className="w-7 h-7 rounded border border-edge text-zinc-300 hover:text-white hover:border-edge2 text-sm">
            −
          </button>
          <button
            onClick={() => setBoard((b) => ({ ...b, zoom: 1, pan: { x: 40, y: 40 } }))}
            className="px-2 h-7 rounded border border-edge text-zinc-300 hover:text-white hover:border-edge2 text-xs"
          >
            Reset view
          </button>
          <button
            onClick={renderVideo}
            disabled={rendering || board.nodes.length === 0}
            className="px-3 h-7 rounded bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium"
          >
            {rendering ? "Rendering..." : "🎬 Render video"}
          </button>
          <button onClick={onClose} className="ml-2 text-zinc-400 hover:text-white text-sm">
            ✕ Close
          </button>
        </div>
      </div>

      {(renderError || renderResult) && (
        <div className="px-5 py-2.5 border-b border-edge bg-panel2 shrink-0 flex items-center justify-between gap-3 flex-wrap">
          {renderError && <p className="text-sm text-red-400">{renderError}</p>}
          {renderResult && (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-green-400">
                Render done{renderResult.skipped.length > 0 ? ` — skipped (no clip attached): ${renderResult.skipped.join(", ")}` : ""}
              </p>
              <a
                href={renderResult.url}
                download
                className="px-3 py-1 rounded bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium"
              >
                ⬇ Download MP4
              </a>
              <video src={renderResult.url} controls className="h-16 rounded border border-edge" />
            </div>
          )}
          <button
            onClick={() => {
              setRenderError(null);
              setRenderResult(null);
            }}
            className="text-zinc-500 hover:text-white text-xs"
          >
            ✕
          </button>
        </div>
      )}

      <div
        ref={viewportRef}
        onMouseDown={handleBackgroundMouseDown}
        onWheel={handleWheel}
        className="relative flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        style={{
          backgroundImage: "radial-gradient(circle, #28282c 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          backgroundPosition: `${board.pan.x}px ${board.pan.y}px`,
        }}
      >
        <div
          className="absolute top-0 left-0"
          style={{ transform: `translate(${board.pan.x}px, ${board.pan.y}px) scale(${board.zoom})`, transformOrigin: "0 0" }}
        >
          <svg className="absolute top-0 left-0 overflow-visible pointer-events-none" width={1} height={1}>
            {board.connections.map((c) => {
              const from = nodeById.get(c.fromId);
              const to = nodeById.get(c.toId);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const midX = (x1 + x2) / 2;
              return (
                <path
                  key={c.id}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  stroke="#5cc4ee"
                  strokeWidth={2}
                  fill="none"
                />
              );
            })}
            {connStart &&
              connDraft &&
              (() => {
                const from = nodeById.get(connStart);
                if (!from) return null;
                return (
                  <line
                    x1={from.x + NODE_W / 2}
                    y1={from.y + NODE_H / 2}
                    x2={connDraft.x}
                    y2={connDraft.y}
                    stroke="#5cc4ee"
                    strokeDasharray="6 5"
                    strokeWidth={3}
                  />
                );
              })()}
          </svg>

          {board.connections.map((c) => {
            const from = nodeById.get(c.fromId);
            const to = nodeById.get(c.toId);
            if (!from || !to) return null;
            const midX = (from.x + NODE_W + to.x) / 2;
            const midY = (from.y + NODE_H / 2 + to.y + NODE_H / 2) / 2;
            return (
              <button
                key={c.id}
                onClick={() => removeConnection(c.id)}
                title="Remove connection"
                className="absolute w-4 h-4 rounded-full bg-ink border border-edge2 text-zinc-400 hover:text-red-400 hover:border-red-400 text-[10px] leading-none flex items-center justify-center"
                style={{ left: midX, top: midY, transform: "translate(-50%,-50%)" }}
              >
                ✕
              </button>
            );
          })}

          {board.nodes.map((node, i) => {
            const accent = ACCENTS[i % ACCENTS.length];
            const busy = busyNodeId === node.id;
            const err = nodeErrors[node.id];
            return (
              <div
                key={node.id}
                className="absolute bg-panel border border-edge rounded-xl shadow-xl flex flex-col overflow-hidden"
                style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
              >
                <div
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  className="px-3 py-2 border-b border-edge cursor-move flex items-center gap-2 shrink-0"
                  style={{ borderLeft: `3px solid ${accent}` }}
                >
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold text-ink shrink-0"
                    style={{ background: accent }}
                  >
                    {orderNumber.get(node.id) ?? "?"}
                  </span>
                  <input
                    value={node.label}
                    onChange={(e) => updateNodeText(node.id, { label: e.target.value })}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-transparent text-xs font-semibold text-white outline-none"
                  />
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => deleteNode(node.id)}
                    title="Delete shot"
                    className="text-zinc-500 hover:text-red-400 text-xs shrink-0"
                  >
                    ✕
                  </button>
                </div>

                <div className="px-3 py-2 overflow-y-auto" style={{ height: NODE_H - CLIP_H - 40 }}>
                  <textarea
                    value={node.instruction}
                    onChange={(e) => updateNodeText(node.id, { instruction: e.target.value })}
                    onMouseDown={(e) => e.stopPropagation()}
                    placeholder="What happens in this shot? Dialogue, action, camera direction..."
                    className="w-full h-full bg-transparent text-xs text-zinc-200 leading-relaxed outline-none resize-none placeholder:text-zinc-600"
                  />
                </div>

                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  className="relative border-t border-edge shrink-0 bg-panel2"
                  style={{ height: CLIP_H }}
                >
                  {busy && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
                      <span className="text-[11px] text-white animate-pulse">Working...</span>
                    </div>
                  )}
                  {node.clip ? (
                    <div className="relative w-full h-full group">
                      {node.clip.kind === "video" ? (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video src={node.clip.url} controls className="w-full h-full object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={node.clip.url} alt="" className="w-full h-full object-cover" />
                      )}
                      <button
                        onClick={() => setNodeClip(node.id, null)}
                        title="Remove clip"
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100"
                      >
                        ✕
                      </button>
                      <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-zinc-300">
                        {node.clip.source === "upload" ? "Uploaded" : node.clip.source === "ai" ? "AI reference" : "Library"}
                      </span>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center gap-1.5 px-2">
                      <button
                        onClick={() => startUpload(node.id)}
                        className="flex-1 h-8 rounded bg-panel border border-edge text-[10px] text-zinc-300 hover:text-white hover:border-edge2"
                      >
                        📤 Upload
                      </button>
                      <button
                        onClick={() => setPickerForNode(node.id)}
                        className="flex-1 h-8 rounded bg-panel border border-edge text-[10px] text-zinc-300 hover:text-white hover:border-edge2"
                      >
                        📚 Library
                      </button>
                      <button
                        onClick={() => generateAiImage(node)}
                        className="flex-1 h-8 rounded bg-panel border border-edge text-[10px] text-zinc-300 hover:text-white hover:border-edge2"
                      >
                        ✨ AI
                      </button>
                    </div>
                  )}
                </div>
                {err && <p className="px-2 py-1 text-[10px] text-red-400 bg-panel border-t border-edge">{err}</p>}

                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => handleDotClick(e, node.id)}
                  title={connStart === node.id ? "Click to cancel" : connStart ? "Click to connect here" : "Click to start a connection"}
                  className={`absolute w-6 h-6 rounded-full border-[3px] cursor-pointer transition-transform hover:scale-125 ${
                    connStart === node.id ? "border-white animate-pulse" : "border-ink"
                  }`}
                  style={{ left: NODE_W, top: NODE_H / 2, transform: "translate(-50%,-50%)", background: accent }}
                />
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => handleDotClick(e, node.id)}
                  title={connStart === node.id ? "Click to cancel" : connStart ? "Click to connect here" : "Click to start a connection"}
                  className={`absolute w-6 h-6 rounded-full border-[3px] cursor-pointer transition-transform hover:scale-125 ${
                    connStart === node.id ? "border-white animate-pulse" : "border-ink"
                  }`}
                  style={{ left: 0, top: NODE_H / 2, transform: "translate(-50%,-50%)", background: accent }}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-edge bg-panel px-5 py-3 shrink-0">
        <label className="text-xs text-zinc-500 mb-1 block">Overall editing direction (pacing, music, transitions, anything that applies to the whole cut)</label>
        <textarea
          value={board.direction}
          onChange={(e) => setBoard((b) => ({ ...b, direction: e.target.value }))}
          placeholder="e.g. fast cuts on the beat, quick zoom-ins on reactions, upbeat trending audio, keep total runtime under 45s..."
          rows={2}
          className="w-full px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-100 outline-none focus:border-brand-500 resize-none"
        />
      </div>

      {pickerForNode && (
        <StoryboardLibraryPicker onSelect={handleLibraryPick} onClose={() => setPickerForNode(null)} />
      )}
    </div>
  );
}
