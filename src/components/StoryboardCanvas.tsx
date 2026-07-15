"use client";

import { useEffect, useRef, useState } from "react";
import type { FunnelStageKey, GeneratedScriptStage, StoryboardClip, StoryboardNode, StoryboardState, StoryboardStyleProfile } from "@/lib/types";
import { checkStageGate, resolveStoryboardOrder, REQUIRED_STAGE_SEQUENCE, STAGE_TAG_LABELS } from "@/lib/storyboard";
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
// +28 over the original 430 to make room for the "AI dub" row under the
// clip box (reserved for every node, not just ones with a video clip
// attached yet, so a card's height doesn't jump when a clip is added).
const DUB_ROW_H = 28;
const NODE_H = 430 + DUB_ROW_H;
const CLIP_H = 150;
const GAP_X = 70;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

const ACCENTS = ["#5cc4ee", "#f472b6", "#facc15", "#4ade80", "#a78bfa", "#fb923c"];

// Pulls a TikTok URL out of arbitrary pasted text (share links usually come
// with surrounding caption text), or null if there isn't one.
function isTikTokUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S*tiktok\.com\S*/i);
  return match ? match[0] : null;
}

function seedInstruction(script: string, direction: string) {
  return [script, direction ? `🎬 ${direction}` : ""].filter(Boolean).join("\n\n");
}

function defaultStoryboard(stages: GeneratedScriptStage[]): StoryboardState {
  const nodes: StoryboardNode[] = stages.map((stage, i) => ({
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
  apiBase,
  initialStoryboard,
  seedStages,
  onClose,
}: {
  // Base path for every storyboard API call this component makes, e.g.
  // `/api/videos/${videoId}/generate-script/${scriptId}/storyboard` for the
  // original Video Analysis flow, or `/api/creation/projects/${projectId}/storyboard`
  // for a standalone Creation project. All 7 sub-routes (save, upload,
  // generate-image, dub/start, dub/status, render, style/analyze) are
  // resolved as `${apiBase}/...` off of this.
  apiBase: string;
  initialStoryboard: StoryboardState | null;
  seedStages: GeneratedScriptStage[];
  onClose: () => void;
}) {
  const [board, setBoard] = useState<StoryboardState>(() => initialStoryboard || defaultStoryboard(seedStages));
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
  const [renderResult, setRenderResult] = useState<{ url: string; skipped: string[]; styleApplied: { pacing: string; transition: string; notes: string } | null } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // ---- "Learn from a reference video" — analyzes an example clip's cut
  // pacing/transition/caption style and applies it to this storyboard's
  // render instead of the fixed defaults. Profile itself lives on
  // board.styleProfile (part of the normal autosaved state); these two are
  // just local UI status for the upload/analyze call.
  const [analyzingStyle, setAnalyzingStyle] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadNodeIdRef = useRef<string | null>(null);
  const styleFileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- AI dub (lip-sync): new voiceover from the shot's text, resynced to
  // the clip's mouth via Sync.so. A generation takes a few minutes, so the
  // start call just kicks off a job id and this polls a status route every
  // 5s until it resolves — not held open as one long request.
  const dubPollTimers = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({});
  useEffect(
    () => () => {
      Object.values(dubPollTimers.current).forEach((t) => t && clearTimeout(t));
    },
    []
  );
  // Resume polling for any shot that still shows "generating" from a
  // previous visit (job kept running server-side even if the canvas was
  // closed).
  useEffect(() => {
    board.nodes.forEach((n) => {
      if (n.dub?.status === "generating" && n.dub.jobId) pollDubStatus(n.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      fetch(`${apiBase}`, {
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

  function updateNodeStageTag(nodeId: string, stageTag: FunnelStageKey | null) {
    setBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId ? { ...n, stageTag } : n)) }));
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
      const res = await fetch(`${apiBase}/upload`, {
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

  // "Paste a TikTok link anywhere" — creates a fresh card (placed the same
  // way addNode places one) and asks the server to yt-dlp the video into
  // this storyboard's media folder, then attaches it as a playable clip.
  async function importTikTokClip(url: string) {
    const rightmost = board.nodes.reduce((max, n) => Math.max(max, n.x), 0);
    const node: StoryboardNode = {
      id: crypto.randomUUID(),
      label: "TikTok clip",
      instruction: "",
      x: board.nodes.length === 0 ? 60 : rightmost + NODE_W + GAP_X,
      y: 120,
      clip: null,
    };
    setBoard((b) => ({ ...b, nodes: [...b.nodes, node] }));
    setBusyNodeId(node.id);
    try {
      const res = await fetch(`${apiBase}/import-tiktok`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, nodeId: node.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setNodeClip(node.id, { source: "tiktok", url: data.url, kind: "video" });
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [node.id]: err.message || "Import failed" }));
    } finally {
      setBusyNodeId(null);
    }
  }

  // Window-level paste listener for the TikTok import above — active as long
  // as the canvas is mounted, but stands down whenever the user is focused in
  // a text field so normal pasting into a card's label/instruction still
  // works untouched.
  useEffect(() => {
    function onWindowPaste(e: ClipboardEvent) {
      const active = document.activeElement;
      const isEditingText =
        active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable);
      if (isEditingText) return; // let normal paste into a card's text fields happen untouched
      const text = e.clipboardData?.getData("text") || "";
      const url = isTikTokUrl(text);
      if (!url) return;
      e.preventDefault();
      importTikTokClip(url);
    }
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
    // re-bind so addNode-style positioning sees the latest nodes;
    // importTikTokClip mutates via setBoard's updater form so this is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.nodes]);

  async function generateAiImage(node: StoryboardNode) {
    setBusyNodeId(node.id);
    clearNodeError(node.id);
    try {
      const res = await fetch(`${apiBase}/generate-image`, {
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

  function updateNodeDub(nodeId: string, dub: StoryboardNode["dub"]) {
    setBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId ? { ...n, dub } : n)) }));
  }

  async function pollDubStatus(nodeId: string) {
    try {
      const res = await fetch(`${apiBase}/dub/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Status check failed");
      if (data.status === "done") {
        updateNodeDub(nodeId, { status: "done", url: data.url });
        return;
      }
      if (data.status === "error") {
        updateNodeDub(nodeId, { status: "error", error: data.error });
        return;
      }
      dubPollTimers.current[nodeId] = setTimeout(() => pollDubStatus(nodeId), 5000);
    } catch (err: any) {
      updateNodeDub(nodeId, { status: "error", error: err.message || "Status check failed" });
    }
  }

  async function startDub(node: StoryboardNode) {
    clearNodeError(node.id);
    updateNodeDub(node.id, { status: "generating" });
    try {
      const res = await fetch(`${apiBase}/dub/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start AI dub");
      updateNodeDub(node.id, { status: "generating", jobId: data.jobId });
      pollDubStatus(node.id);
    } catch (err: any) {
      updateNodeDub(node.id, { status: "error", error: err.message || "Failed to start AI dub" });
    }
  }

  // "Breakdown into 6 stages" — for a TikTok-imported clip, asks the server
  // to transcribe + run the same 6-stage funnel analysis used by Video
  // Analysis, then swaps this single card out for 6 new stage-tagged cards
  // (one per funnel stage, each trimmed to that stage's time range and
  // pre-filled with the AI's summary/quote as a starting instruction).
  async function startBreakdown(node: StoryboardNode) {
    if (!window.confirm("Break this TikTok clip down into 6 tagged stage cards? The original card will be replaced.")) return;
    setBusyNodeId(node.id);
    clearNodeError(node.id);
    try {
      const res = await fetch(`${apiBase}/breakdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Breakdown failed");
      setBoard((b) => ({
        ...b,
        nodes: [...b.nodes.filter((n) => n.id !== node.id), ...data.newNodes],
        connections: [...b.connections.filter((c) => c.fromId !== node.id && c.toId !== node.id), ...data.newConnections],
      }));
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [node.id]: err.message || "Breakdown failed" }));
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
      const res = await fetch(`${apiBase}/render`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Render failed");
      setRenderResult({ url: data.url, skipped: data.skipped || [], styleApplied: data.styleApplied || null });
    } catch (err: any) {
      setRenderError(err.message || "Render failed");
    } finally {
      setRendering(false);
    }
  }

  function startStyleUpload() {
    styleFileInputRef.current?.click();
  }

  async function handleStyleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAnalyzingStyle(true);
    setStyleError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${apiBase}/style/analyze`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Style analysis failed");
      setBoard((b) => ({ ...b, styleProfile: data.profile as StoryboardStyleProfile }));
    } catch (err: any) {
      setStyleError(err.message || "Style analysis failed");
    } finally {
      setAnalyzingStyle(false);
    }
  }

  function clearStyleProfile() {
    setBoard((b) => ({ ...b, styleProfile: null }));
    setStyleError(null);
  }

  const nodeById = new Map(board.nodes.map((n) => [n.id, n] as const));
  const order = resolveStoryboardOrder(board.nodes, board.connections);
  const orderNumber = new Map(order.map((n, i) => [n.id, i + 1] as const));
  // Gates the anchored "Generate video" button under CTA cards: all 6 funnel
  // stages must be tagged somewhere and appear in funnel order along the
  // resolved shot order (untagged cards are ignored, so extras can be mixed
  // in freely).
  const stageGate = checkStageGate(board.nodes, board.connections);

  // One card can have any number of connections in and out — anchor side
  // (left vs right dot) is picked automatically from which way the other
  // node currently sits, so dragging a card to the opposite side re-routes
  // the line instead of drawing it backwards through the card. Multiple
  // lines leaving/entering the same side of the same card are fanned out
  // vertically a little so they don't sit exactly on top of each other.
  const endpointIndex = new Map<string, number>();
  const endpointCount = new Map<string, number>();
  for (const c of board.connections) {
    const from = nodeById.get(c.fromId);
    const to = nodeById.get(c.toId);
    if (!from || !to) continue;
    const fromKey = `${c.fromId}:${to.x >= from.x ? "r" : "l"}`;
    const toKey = `${c.toId}:${to.x >= from.x ? "l" : "r"}`;
    endpointCount.set(fromKey, (endpointCount.get(fromKey) || 0) + 1);
    endpointCount.set(toKey, (endpointCount.get(toKey) || 0) + 1);
  }
  function nextIndex(key: string) {
    const i = endpointIndex.get(key) || 0;
    endpointIndex.set(key, i + 1);
    return i;
  }
  function fanOffset(key: string) {
    const count = endpointCount.get(key) || 1;
    const i = nextIndex(key);
    return (i - (count - 1) / 2) * 16;
  }

  function connectionGeometry(c: { id: string; fromId: string; toId: string }) {
    const from = nodeById.get(c.fromId);
    const to = nodeById.get(c.toId);
    if (!from || !to) return null;
    const forward = to.x >= from.x;
    const fromKey = `${c.fromId}:${forward ? "r" : "l"}`;
    const toKey = `${c.toId}:${forward ? "l" : "r"}`;
    const x1 = from.x + (forward ? NODE_W : 0);
    const y1 = from.y + NODE_H / 2 + fanOffset(fromKey);
    const x2 = to.x + (forward ? 0 : NODE_W);
    const y2 = to.y + NODE_H / 2 + fanOffset(toKey);
    const dx = x2 - x1;
    const bend = Math.max(50, Math.min(220, Math.abs(dx) * 0.5));
    const c1x = x1 + (forward ? bend : -bend);
    const c1y = y1;
    const c2x = x2 + (forward ? -bend : bend);
    const c2y = y2;
    // Cubic bezier point at t=0.5, for placing the remove button on the
    // actual curve instead of the straight-line midpoint between endpoints.
    const midX = 0.125 * x1 + 0.375 * c1x + 0.375 * c2x + 0.125 * x2;
    const midY = 0.125 * y1 + 0.375 * c1y + 0.375 * c2y + 0.125 * y2;
    return { x1, y1, x2, y2, c1x, c1y, c2x, c2y, midX, midY };
  }

  // Computed once per render (fanOffset mutates counters as it goes, so
  // this must be reused for both the SVG paths and the remove buttons
  // below rather than calling connectionGeometry twice per connection).
  const connectionGeoms = board.connections.map((c) => ({ c, g: connectionGeometry(c) }));

  return (
    <div className="fixed inset-0 bg-black/85 z-50 flex flex-col">
      <input ref={fileInputRef} type="file" accept="video/*,image/*" className="hidden" onChange={handleFileChosen} />
      <input ref={styleFileInputRef} type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" onChange={handleStyleFileChosen} />

      {/* Two rows: the button row never wraps its controls away from the
          Close button (shrink-0 all round), and the stage-gate status text
          — which can get long ("Generate needs: Reaction, Hook, ...") —
          lives on its own full-width line below where it can wrap freely
          without crowding Close out of reach. */}
      <div className="border-b border-edge bg-panel shrink-0">
        <div className="flex items-center justify-between px-5 py-3 flex-wrap gap-2">
          <div>
            <h3 className="text-white font-semibold text-sm">Generate Video — Storyboard</h3>
            <p className="text-xs text-zinc-500">
              Drag cards to arrange · edit any card's text · click a dot, then click another card's dot to connect (Esc to cancel) · numbers show render order · paste a TikTok link anywhere to add it as a new video card.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
            <button onClick={onClose} className="ml-2 text-zinc-400 hover:text-white text-sm shrink-0">
              ✕ Close
            </button>
          </div>
        </div>
        <div className="px-5 pb-2.5">
          {stageGate.ok ? (
            <span className="text-xs text-green-400">✓ Ready — see Generate button under your CTA card</span>
          ) : (
            <span className="text-xs text-zinc-500">
              Generate needs:{" "}
              {stageGate.missing.length > 0
                ? `${stageGate.missing.map((k) => STAGE_TAG_LABELS[k]).join(", ")} tagged`
                : "stages connected in order"}{" "}
              — button appears under your CTA card
            </span>
          )}
        </div>
      </div>

      <div className="px-5 py-2.5 border-b border-edge bg-panel2 shrink-0 flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium text-zinc-400 shrink-0">🎨 Reference video style</span>
        {analyzingStyle ? (
          <span className="text-xs text-yellow-400 animate-pulse">Analyzing cut pacing/transitions...</span>
        ) : board.styleProfile ? (
          <>
            <span className="text-xs text-zinc-300">
              <span className="text-green-400 font-medium">{board.styleProfile.pacing} pacing</span>
              {" · "}
              {board.styleProfile.transition === "hard_cut" ? "hard cuts" : `${board.styleProfile.transition} transitions`}
              {" · "}
              {board.styleProfile.captionStyle} captions
              {" · ~"}
              {board.styleProfile.avgShotSec.toFixed(1)}s/shot from "{board.styleProfile.sourceLabel}"
            </span>
            <span className="text-xs text-zinc-500 italic truncate max-w-md" title={board.styleProfile.notes}>
              {board.styleProfile.notes}
            </span>
            <button onClick={startStyleUpload} className="ml-auto text-xs text-zinc-400 hover:text-white shrink-0">
              ↺ Replace
            </button>
            <button onClick={clearStyleProfile} className="text-xs text-zinc-500 hover:text-red-400 shrink-0">
              ✕ Clear
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-zinc-500">Not set — render uses default pacing/transitions</span>
            <button
              onClick={startStyleUpload}
              className="ml-auto px-2.5 py-1 rounded border border-dashed border-edge2 text-xs text-zinc-300 hover:text-white hover:border-brand-500 shrink-0"
            >
              📎 Upload a reference video to learn its editing style
            </button>
          </>
        )}
        {styleError && <span className="text-xs text-red-400 w-full">{styleError}</span>}
      </div>

      {(renderError || renderResult) && (
        <div className="px-5 py-2.5 border-b border-edge bg-panel2 shrink-0 flex items-center justify-between gap-3 flex-wrap">
          {renderError && <p className="text-sm text-red-400">{renderError}</p>}
          {renderResult && (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-green-400">
                Render done{renderResult.styleApplied ? ` — applied ${renderResult.styleApplied.pacing} reference style` : ""}
                {renderResult.skipped.length > 0 ? ` — skipped (no clip attached): ${renderResult.skipped.join(", ")}` : ""}
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
            {connectionGeoms.map(({ c, g }) => {
              if (!g) return null;
              return (
                <path
                  key={c.id}
                  d={`M ${g.x1} ${g.y1} C ${g.c1x} ${g.c1y}, ${g.c2x} ${g.c2y}, ${g.x2} ${g.y2}`}
                  stroke="#5cc4ee"
                  strokeWidth={2.5}
                  fill="none"
                />
              );
            })}
            {connStart &&
              connDraft &&
              (() => {
                const from = nodeById.get(connStart);
                if (!from) return null;
                const forward = connDraft.x >= from.x + NODE_W / 2;
                const x1 = from.x + (forward ? NODE_W : 0);
                const y1 = from.y + NODE_H / 2;
                const dx = connDraft.x - x1;
                const bend = Math.max(50, Math.min(220, Math.abs(dx) * 0.5));
                const c1x = x1 + (forward ? bend : -bend);
                const c2x = connDraft.x + (forward ? -bend : bend);
                return (
                  <path
                    d={`M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${connDraft.y}, ${connDraft.x} ${connDraft.y}`}
                    stroke="#5cc4ee"
                    strokeDasharray="6 5"
                    strokeWidth={3}
                    fill="none"
                  />
                );
              })()}
          </svg>

          {connectionGeoms.map(({ c, g }) => {
            if (!g) return null;
            return (
              <button
                key={c.id}
                onClick={() => removeConnection(c.id)}
                title="Remove connection"
                className="absolute w-4 h-4 rounded-full bg-ink border border-edge2 text-zinc-400 hover:text-red-400 hover:border-red-400 text-[10px] leading-none flex items-center justify-center"
                style={{ left: g.midX, top: g.midY, transform: "translate(-50%,-50%)" }}
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
                  <select
                    value={node.stageTag || ""}
                    onChange={(e) => updateNodeStageTag(node.id, (e.target.value || null) as FunnelStageKey | null)}
                    onMouseDown={(e) => e.stopPropagation()}
                    title="Funnel stage this card covers (all 6 must be tagged, in order, to unlock Generate)"
                    className="shrink-0 bg-transparent border border-edge rounded text-[9px] text-zinc-400 outline-none px-1 py-0.5"
                  >
                    <option value="">—</option>
                    {REQUIRED_STAGE_SEQUENCE.map((key) => (
                      <option key={key} value={key}>
                        {STAGE_TAG_LABELS[key]}
                      </option>
                    ))}
                  </select>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => deleteNode(node.id)}
                    title="Delete shot"
                    className="text-zinc-500 hover:text-red-400 text-xs shrink-0"
                  >
                    ✕
                  </button>
                </div>

                <div className="px-3 py-2 overflow-y-auto" style={{ height: NODE_H - CLIP_H - 40 - DUB_ROW_H }}>
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
                        <video
                          src={node.dub?.status === "done" && node.dub.url ? node.dub.url : node.clip.url}
                          controls
                          className="w-full h-full object-cover"
                        />
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
                        {node.dub?.status === "done"
                          ? "AI dubbed"
                          : node.clip.source === "upload"
                          ? "Uploaded"
                          : node.clip.source === "ai"
                          ? "AI reference"
                          : node.clip.source === "tiktok"
                          ? "Imported from TikTok"
                          : "Library"}
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

                {node.clip?.kind === "video" && (
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    className="px-2 py-1.5 border-t border-edge bg-panel flex items-center gap-2 text-[10px] shrink-0"
                  >
                    {node.clip?.source === "tiktok" && (
                      <button
                        onClick={() => startBreakdown(node)}
                        className="px-2 py-1 rounded bg-panel2 border border-edge text-zinc-300 hover:text-white hover:border-brand-500"
                      >
                        🔍 Breakdown into 6 stages
                      </button>
                    )}
                    {!node.dub || node.dub.status === "error" ? (
                      <>
                        <button
                          onClick={() => startDub(node)}
                          className="px-2 py-1 rounded bg-panel2 border border-edge text-zinc-300 hover:text-white hover:border-brand-500"
                        >
                          🗣️ AI dub (lip-sync)
                        </button>
                        {node.dub?.status === "error" && (
                          <span className="text-red-400 truncate" title={node.dub.error}>
                            failed: {node.dub.error}
                          </span>
                        )}
                      </>
                    ) : node.dub.status === "generating" ? (
                      <span className="text-yellow-400 animate-pulse">⏳ Dubbing... (can take a few min)</span>
                    ) : (
                      <>
                        <span className="text-green-400">✓ Dubbed — preview above now plays the dub</span>
                        <button onClick={() => startDub(node)} className="ml-auto text-zinc-500 hover:text-white">
                          ↺ Redo
                        </button>
                      </>
                    )}
                  </div>
                )}
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

          {/* "Generate video" now lives anchored under the CTA-tagged card(s)
              (moved out of the top toolbar) — inside the same pan/zoom
              transform so it travels with the cards. Disabled until the
              stage gate passes: all 6 funnel stages tagged and in order. */}
          {board.nodes
            .filter((n) => n.stageTag === "cta")
            .map((n) => (
              <button
                key={`generate-${n.id}`}
                onClick={renderVideo}
                disabled={rendering || !stageGate.ok}
                className="absolute px-3 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium shadow-xl"
                style={{ left: n.x, top: n.y + NODE_H + 16, width: NODE_W }}
              >
                {rendering ? "Rendering..." : "🎬 Generate video"}
              </button>
            ))}
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
