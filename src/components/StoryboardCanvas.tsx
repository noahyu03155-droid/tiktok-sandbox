"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { FunnelStageKey, GeneratedScriptStage, StoryboardClip, StoryboardNode, StoryboardState, StoryboardStyleProfile } from "@/lib/types";
import { resolveStoryboardOrder, resolveChainTails, resolveConnectedChain, MIN_CHAIN_LENGTH_FOR_GENERATE, REQUIRED_STAGE_SEQUENCE, STAGE_TAG_LABELS } from "@/lib/storyboard";
import StoryboardLibraryPicker, { type LibraryClipChoice } from "./StoryboardLibraryPicker";
import ProductPicker from "./ProductPicker";

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
// Card layout for a "normal" card (everything except the pending-TikTok
// import preview below): header, then a Script box (the node's
// `instruction` — pre-filled from an AI breakdown or typed manually),
// then a separate Editing notes box (`editorNotes` — the user's own
// filming/editing reminders, kept apart from the script on purpose), then
// the clip preview at full natural 9:16 (not cropped down to a small
// landscape strip like before — same aspect-ratio formula the pending-
// TikTok preview already uses, so uploaded footage is fully visible).
const HEADER_H = 40;
const SCRIPT_BOX_H = 110;
const NOTES_BOX_H = 80;
const CLIP_VIDEO_H = Math.round(NODE_W * (16 / 9));
const NODE_H = HEADER_H + SCRIPT_BOX_H + NOTES_BOX_H + CLIP_VIDEO_H;
const GAP_X = 70;
const STYLE_WIDGET_H = 34; // compact reference-style control shown above each chain-tail's Generate button
const STYLE_WIDGET_GAP = 8;
// Layout for a freshly-pasted, not-yet-broken-down TikTok import card (see
// the `isPendingTiktokBreakdown` check below) — no text boxes yet, just the
// video at its natural 9:16 portrait ratio plus the two action buttons,
// since there's nothing to write until the user runs Breakdown.
const TIKTOK_HEADER_H = 34;
// Tall enough for the two stacked full-width actions (Breakdown + Generate
// product script, ~32px each) plus the row's padding and gap — the card is
// overflow-hidden, so an undersized row would clip the second button.
const TIKTOK_BUTTON_ROW_H = 96;
const TIKTOK_PREVIEW_VIDEO_H = Math.round(NODE_W * (16 / 9));
const TIKTOK_PREVIEW_H = TIKTOK_HEADER_H + TIKTOK_PREVIEW_VIDEO_H + TIKTOK_BUTTON_ROW_H;
// Layout for a pasted TikTok PRODUCT-link card (see isPendingProductCard
// below) — header + product image in the same 9:16 box the pending-TikTok
// video preview uses, then a compact editable title/description/price
// fields area. Its "Generate script" button lives BELOW the card (like the
// chain-tail Generate button), not inside it, since it only appears once
// the card is connected to something.
// Sized for title + description + price plus the rating/reviews/store rows
// (all best-effort scraped, all hand-editable) without crushing the
// flex-1 description textarea — the card is overflow-hidden, so an
// undersized fields area would clip the bottom inputs.
const PRODUCT_FIELDS_H = 240;
const PRODUCT_CARD_H = TIKTOK_HEADER_H + TIKTOK_PREVIEW_VIDEO_H + PRODUCT_FIELDS_H;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;
// Free per-card resize (bottom-right grip) clamps — see handleResizeMouseDown.
const MIN_NODE_W = 220;
const MAX_NODE_W = 560;
const MIN_NODE_H = 260;
const MAX_NODE_H = 900;

const ACCENTS = ["#5cc4ee", "#f472b6", "#facc15", "#4ade80", "#a78bfa", "#fb923c"];

// Rough, hand-tuned wait-time estimates (seconds) per async action kind —
// shown next to the busy/spinner state so the user has a sense of how long
// to expect instead of staring at a bare "Working...". Deliberately just
// reasonable guesses based on each action's real cost (a plain file upload
// vs. ffmpeg extraction + Whisper transcription + a Claude call), not
// measured telemetry — see beginBusy/estimateLabel below for how they're
// used.
const ACTION_ESTIMATE_SEC: Record<string, number> = {
  upload: 8,
  aiImage: 15,
  breakdown: 50, // ffmpeg trims + whisper transcript + Claude analysis + shooting guide
  breakdownChain: 55, // same pipeline, plus matching onto an existing chain
  shoppableScript: 20,
  productScript: 50, // same transcribe+analyze pipeline as breakdown, plus one more Claude call
  renderVideo: 30,
  styleAnalyze: 20,
  journalReply: 10,
};

// Pulls a TikTok URL out of arbitrary pasted text (share links usually come
// with surrounding caption text), or null if there isn't one.
function isTikTokUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S*tiktok\.com\S*/i);
  return match ? match[0] : null;
}

// A TikTok Shop / product-page link (best-effort — matches common
// product-page URL shapes; see src/lib/tiktokProduct.ts for the
// (also best-effort) scraper). Checked BEFORE isTikTokUrl in the paste
// handler since a product URL might also loosely match a generic
// tiktok.com pattern.
function isTikTokProductUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S*(?:shop\.tiktok\.com|tiktok\.com\/shop|tiktok\.com\/view\/product)\S*/i);
  return match ? match[0] : null;
}

// A raw TikTok import that hasn't been broken down (or manually tagged)
// yet gets a taller card so its 9:16 video shows at natural size — see
// TIKTOK_PREVIEW_H above. Every other card (including the 6 cards Breakdown
// produces, which always have a stageTag set) uses the normal NODE_H.
function isPendingTiktokBreakdown(node: StoryboardNode): boolean {
  return node.clip?.source === "tiktok" && !node.stageTag;
}
// A card sourced from pasting a TikTok PRODUCT link (node.productRef, see
// src/lib/types.ts) that hasn't been turned into script cards yet —
// rendered as a fixed-size product card (image + editable details) with a
// "Generate script" action below it once it's connected into the graph.
function isPendingProductCard(node: StoryboardNode): boolean {
  return !!node.productRef && !node.stageTag;
}
// ---- per-card custom sizing (node.w/node.h, set by the resize grip) ----
// The NODE_W/SCRIPT_BOX_H/NOTES_BOX_H/CLIP_VIDEO_H constants above stay as
// the defaults; these helpers resolve a specific node's actual dimensions.
// Pending-TikTok-import cards keep the fixed TIKTOK_* sizing and don't get
// a resize handle (out of scope for resize).
function nodeWidth(node: StoryboardNode): number {
  return node.w ?? NODE_W;
}
// Clip preview keeps a 16:9 box scaled to the card's actual width, same
// formula the default already uses (NODE_W * 16/9) just parametrized.
function nodeClipVideoH(node: StoryboardNode): number {
  return Math.round(nodeWidth(node) * (16 / 9));
}
// When the user drags the card taller/shorter than the natural default
// height, the extra/removed height is distributed between the Script and
// Notes boxes (60% to Script, 40% to Notes), each with a floor so neither
// can be squeezed unreadably small. Header height and the clip video
// height are NOT affected by vertical resize (clip height only changes
// with width, via nodeClipVideoH above).
function nodeScriptBoxH(node: StoryboardNode): number {
  if (isPendingTiktokBreakdown(node) || isPendingProductCard(node)) return SCRIPT_BOX_H;
  const totalH = node.h ?? NODE_H;
  const delta = totalH - NODE_H;
  return Math.max(80, SCRIPT_BOX_H + Math.round(delta * 0.6));
}
function nodeNotesBoxH(node: StoryboardNode): number {
  if (isPendingTiktokBreakdown(node) || isPendingProductCard(node)) return NOTES_BOX_H;
  const totalH = node.h ?? NODE_H;
  const delta = totalH - NODE_H;
  return Math.max(60, NOTES_BOX_H + Math.round(delta * 0.4));
}
function cardHeight(node: StoryboardNode): number {
  if (isPendingTiktokBreakdown(node)) return TIKTOK_PREVIEW_H;
  if (isPendingProductCard(node)) return PRODUCT_CARD_H;
  return HEADER_H + nodeScriptBoxH(node) + nodeNotesBoxH(node) + nodeClipVideoH(node);
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
  // for a standalone Creation project. All 5 sub-routes (save, upload,
  // generate-image, render, style/analyze) are
  // resolved as `${apiBase}/...` off of this.
  apiBase: string;
  initialStoryboard: StoryboardState | null;
  seedStages: GeneratedScriptStage[];
  onClose: () => void;
}) {
  const [board, setBoard] = useState<StoryboardState>(() => initialStoryboard || defaultStoryboard(seedStages));
  const [pickerForNode, setPickerForNode] = useState<string | null>(null);
  // Which pending TikTok card the "Generate product script" product picker
  // is currently open for (null = closed).
  const [productPickerNodeId, setProductPickerNodeId] = useState<string | null>(null);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  // ---- "roughly how long will this take" wait-time estimate ----
  // busyKind names which ACTION_ESTIMATE_SEC entry is running right now (set
  // right before any async action's fetch, cleared in its finally — see
  // beginBusy below); busyStartedAtRef timestamps when it began. `tick`
  // exists purely to force a re-render once a second while something is
  // busy, so estimateLabel's elapsed-time math stays current without a
  // second copy of the clock in state.
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const busyStartedAtRef = useRef<number>(0);
  const [tick, setTick] = useState(0);
  // Ref video staged on a chain-head card for "Breakdown chain" — keyed by
  // that card's nodeId. Transient client-only state (not part of `board`,
  // never autosaved): the uploaded file already lives on disk via the
  // normal /upload route, this just remembers its URL long enough for the
  // user to hit the Breakdown button. Cleared once the breakdown succeeds.
  const [refVideoByNode, setRefVideoByNode] = useState<Record<string, { url: string; kind: "video" | "image" }>>({});
  const [refUploadingNodeId, setRefUploadingNodeId] = useState<string | null>(null);
  // Click-to-connect (not drag-to-connect — the dots are small and dragging
  // precisely onto another one was fiddly). Click a dot to arm a connection
  // from that node; a dashed line then follows the cursor; click any dot on
  // a different node to complete it (solid line), click the same dot again
  // or press Escape to cancel.
  const [connStart, setConnStart] = useState<string | null>(null);
  const [connDraft, setConnDraft] = useState<{ x: number; y: number } | null>(null);
  // ---- multi-select ----
  // Shift+drag on empty background draws a rubber-band marquee (world-space
  // coords, same coordinate system as node.x/y); on mouseup every node whose
  // bounding box intersects it becomes selected. Dragging any node that's
  // part of a multi-selection then moves the whole group together (see
  // handleNodeMouseDown). A plain click on empty background clears it.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

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

  // Escape also clears the multi-selection (and any in-progress marquee —
  // the marquee gesture additionally has its own gesture-local Escape
  // handler that tears down its move/up listeners, see
  // handleBackgroundMouseDown). Kept separate from the connStart effect
  // above, which only listens while a connection draft is armed.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setSelectedIds(new Set());
        setMarquee(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<{ url: string; skipped: string[]; styleApplied: { pacing: string; transition: string; notes: string } | null; appliedFeedback: { notes: string } | null } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // ---- "Learn from a reference video" — analyzes an example clip's cut
  // pacing/transition/caption style and applies it to this storyboard's
  // render instead of the fixed defaults. Profile itself lives on
  // board.styleProfile (part of the normal autosaved state); these two are
  // just local UI status for the upload/analyze call.
  const [analyzingStyle, setAnalyzingStyle] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);

  // ---- daily journal chat ("write like a diary, AI replies like a friend").
  // Per-USER, not per-project — always talks to the fixed /api/journal
  // route, never `${apiBase}/...`. Always docked between the header and the
  // canvas viewport (no toggle button anymore) — starts at a compact height
  // that fits the input row plus roughly one line of hint text, and the
  // user drags its bottom-edge handle to resize it taller/shorter.
  const [journalHeight, setJournalHeight] = useState(112);
  const [journalEntries, setJournalEntries] = useState<{ id: string; role: "user" | "ai"; content: string }[]>([]);
  const [journalDraft, setJournalDraft] = useState("");
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalSending, setJournalSending] = useState(false);
  const journalScrollRef = useRef<HTMLDivElement>(null);

  // The panel is always visible now, so load the entries once on mount.
  useEffect(() => {
    setJournalLoading(true);
    fetch("/api/journal")
      .then((r) => r.json())
      .then((data) => setJournalEntries(data.entries || []))
      .catch(() => {})
      .finally(() => setJournalLoading(false));
  }, []);

  useEffect(() => {
    journalScrollRef.current?.scrollTo({ top: journalScrollRef.current.scrollHeight });
  }, [journalEntries, journalSending]);

  async function sendJournalMessage() {
    const text = journalDraft.trim();
    if (!text || journalSending) return;
    setJournalDraft("");
    setJournalEntries((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: text }]);
    setJournalSending(true);
    beginBusy("journalReply");
    try {
      const res = await fetch("/api/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (res.ok && data.entry) {
        setJournalEntries((prev) => [...prev, { id: data.entry.id, role: "ai", content: data.entry.content }]);
      }
    } catch {
      // silent fail is acceptable here — the panel is a lightweight aside,
      // not core workflow (the entry itself is still saved server-side).
    } finally {
      setJournalSending(false);
      setBusyKind(null);
    }
  }

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadNodeIdRef = useRef<string | null>(null);
  const styleFileInputRef = useRef<HTMLInputElement | null>(null);
  const refFileInputRef = useRef<HTMLInputElement | null>(null);
  const refUploadNodeIdRef = useRef<string | null>(null);

  // Marks an async action as "busy" for wait-time-estimate purposes — call
  // right before starting the fetch, alongside whichever specific busy flag
  // (busyNodeId/rendering/analyzingStyle/journalSending) that action already
  // sets. `kind` must be a key of ACTION_ESTIMATE_SEC.
  function beginBusy(kind: string) {
    busyStartedAtRef.current = Date.now();
    setBusyKind(kind);
  }

  // Ticks once a second while any action is busy, purely to force
  // estimateLabel below to re-render with a fresh elapsed time.
  useEffect(() => {
    if (!busyKind) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [busyKind]);

  // `_tick` isn't read — it's just the effect dependency that makes this
  // recompute every second while busy.
  function estimateLabel(fallback: string, _tick: number): string {
    if (!busyKind) return fallback;
    const estimate = ACTION_ESTIMATE_SEC[busyKind] ?? 20;
    const elapsed = Math.max(0, Math.round((Date.now() - busyStartedAtRef.current) / 1000));
    const remaining = estimate - elapsed;
    if (remaining > 2) return `Working... (~${remaining}s left)`;
    return "Almost done...";
  }

  // ---- autosave (debounced) ----
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRun = useRef(true);

  function saveBoardNow() {
    setSaveStatus("saving");
    fetch(`${apiBase}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(board),
    })
      .then((res) => setSaveStatus(res.ok ? "saved" : "error"))
      .catch(() => setSaveStatus("error"));
  }

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveBoardNow, 600);
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

  // ---- panning the background (plain drag) / marquee-select (Shift+drag) ----
  function handleBackgroundMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (connStart) {
      setConnStart(null);
      setConnDraft(null);
      return;
    }

    if (e.shiftKey) {
      // Shift+drag: rubber-band selection instead of panning. Pan/zoom
      // don't change during the gesture, so toWorld (which closes over the
      // current board.pan/board.zoom) stays valid throughout.
      const start = toWorld(e.clientX, e.clientY);
      setMarquee({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
      function onMarqueeMove(ev: MouseEvent) {
        const p = toWorld(ev.clientX, ev.clientY);
        setMarquee({ x0: start.x, y0: start.y, x1: p.x, y1: p.y });
      }
      function teardown() {
        window.removeEventListener("mousemove", onMarqueeMove);
        window.removeEventListener("mouseup", onMarqueeUp);
        window.removeEventListener("keydown", onMarqueeKey);
      }
      function onMarqueeUp(ev: MouseEvent) {
        teardown();
        const p = toWorld(ev.clientX, ev.clientY);
        const minX = Math.min(start.x, p.x);
        const maxX = Math.max(start.x, p.x);
        const minY = Math.min(start.y, p.y);
        const maxY = Math.max(start.y, p.y);
        // Every node whose bounding box intersects the marquee rect.
        const matched = board.nodes
          .filter((n) => n.x < maxX && n.x + nodeWidth(n) > minX && n.y < maxY && n.y + cardHeight(n) > minY)
          .map((n) => n.id);
        setSelectedIds(new Set(matched));
        setMarquee(null);
      }
      function onMarqueeKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") {
          teardown();
          setMarquee(null);
        }
      }
      window.addEventListener("mousemove", onMarqueeMove);
      window.addEventListener("mouseup", onMarqueeUp);
      window.addEventListener("keydown", onMarqueeKey);
      return;
    }

    const startX = e.clientX;
    const startY = e.clientY;
    const originPan = board.pan;
    // Total mouse travel during the gesture — if it stays under ~4px this
    // was a plain click (clear the selection), not a pan (leave the
    // selection alone; the user was just navigating).
    let maxTravel = 0;
    function onMove(ev: MouseEvent) {
      maxTravel = Math.max(maxTravel, Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY));
      setBoard((b) => ({ ...b, pan: { x: originPan.x + (ev.clientX - startX), y: originPan.y + (ev.clientY - startY) } }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (maxTravel < 4) setSelectedIds(new Set());
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleWheel(e: WheelEvent) {
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

  // Bound as a native, non-passive listener rather than via React's
  // onWheel prop. React 17+ registers onWheel (and onTouchMove/onTouchStart)
  // as passive listeners for scroll performance, which silently ignores
  // e.preventDefault() — so a JSX onWheel handler alone can't stop the
  // browser's own pinch-zoom/ctrl+scroll page zoom from also firing.
  // Attaching it manually with { passive: false } is the only way
  // preventDefault() actually takes effect, so a trackpad two-finger pinch
  // (or ctrl+scroll) over the canvas zooms the canvas only, without also
  // zooming the whole page.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function zoomBy(factor: number) {
    setBoard((b) => ({ ...b, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, b.zoom * factor)) }));
  }

  // ---- dragging a node (or a whole multi-selection, or its whole connected
  // chain via Ctrl/Cmd+drag) ----
  function handleNodeMouseDown(e: React.MouseEvent, node: StoryboardNode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = node.x;
    const originY = node.y;
    // Ctrl/Cmd+drag: grab this node's WHOLE connected chain (walking
    // connections in either direction, via the same traversal the
    // product-script "Generate script" flow uses server-side) and move it
    // as one unit — the quick shortcut for "reposition this whole sequence"
    // without having to marquee-select it first. Also lights the chain up
    // via selectedIds so it's visually obvious what's about to move.
    let groupOrigins: Map<string, { x: number; y: number }> | null = null;
    if (e.metaKey || e.ctrlKey) {
      const chainIds = new Set([node.id, ...resolveConnectedChain(node.id, board.nodes, board.connections).map((n) => n.id)]);
      if (chainIds.size > 1) {
        groupOrigins = new Map(board.nodes.filter((n) => chainIds.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }] as const));
        setSelectedIds(chainIds);
      }
    }
    // Otherwise, if the grabbed node is part of an existing multi-selection,
    // capture every selected node's origin so the whole group moves by the
    // same delta. A node outside the selection (or a 1-member selection)
    // keeps the plain single-node drag below.
    if (!groupOrigins) {
      groupOrigins =
        selectedIds.has(node.id) && selectedIds.size > 1
          ? new Map(board.nodes.filter((n) => selectedIds.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }] as const))
          : null;
    }
    function onMove(ev: MouseEvent) {
      const dx = (ev.clientX - startX) / board.zoom;
      const dy = (ev.clientY - startY) / board.zoom;
      if (groupOrigins) {
        setBoard((b) => ({
          ...b,
          nodes: b.nodes.map((n) => {
            const origin = groupOrigins.get(n.id);
            return origin ? { ...n, x: origin.x + dx, y: origin.y + dy } : n;
          }),
        }));
        return;
      }
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

  // ---- resizing a node (bottom-right grip; normal cards only, pending
  // TikTok imports keep their fixed size) ----
  function handleResizeMouseDown(e: React.MouseEvent, node: StoryboardNode) {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = node.w ?? NODE_W;
    const originH = node.h ?? NODE_H;
    function onMove(ev: MouseEvent) {
      const dw = (ev.clientX - startX) / board.zoom;
      const dh = (ev.clientY - startY) / board.zoom;
      const w = Math.round(Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, originW + dw)));
      const h = Math.round(Math.min(MAX_NODE_H, Math.max(MIN_NODE_H, originH + dh)));
      setBoard((b) => ({
        ...b,
        nodes: b.nodes.map((n) => (n.id === node.id ? { ...n, w, h } : n)),
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

  // "Insert template" — instantly drops 6 blank funnel-stage cards (one per
  // REQUIRED_STAGE_SEQUENCE entry, pre-tagged and auto-connected in order),
  // purely client-side: no API call, no AI. Placed as a horizontal row using
  // the same rightmost + NODE_W + GAP_X convention addNode uses, so the row
  // lands next to the existing cards; persists via the normal autosave.
  function insertTemplate() {
    const rightmost = board.nodes.reduce((max, n) => Math.max(max, n.x), 0);
    const startX = board.nodes.length === 0 ? 60 : rightmost + NODE_W + GAP_X;
    const newNodes: StoryboardNode[] = REQUIRED_STAGE_SEQUENCE.map((key, i) => ({
      id: crypto.randomUUID(),
      label: STAGE_TAG_LABELS[key],
      instruction: "",
      editorNotes: "",
      x: startX + i * (NODE_W + GAP_X),
      y: 120,
      clip: null,
      stageTag: key,
    }));
    const newConnections = newNodes.slice(0, -1).map((n, i) => ({
      id: crypto.randomUUID(),
      fromId: n.id,
      toId: newNodes[i + 1].id,
    }));
    setBoard((b) => ({
      ...b,
      nodes: [...b.nodes, ...newNodes],
      connections: [...b.connections, ...newConnections],
    }));
  }

  function deleteNode(nodeId: string) {
    setBoard((b) => ({
      ...b,
      nodes: b.nodes.filter((n) => n.id !== nodeId),
      connections: b.connections.filter((c) => c.fromId !== nodeId && c.toId !== nodeId),
    }));
  }

  function updateNodeText(nodeId: string, patch: Partial<Pick<StoryboardNode, "label" | "instruction" | "editorNotes">>) {
    setBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }));
  }

  function updateNodeStageTag(nodeId: string, stageTag: FunnelStageKey | null) {
    setBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId ? { ...n, stageTag } : n)) }));
  }

  // Same immutable-update pattern as updateNodeText, but merging into the
  // node's productRef (the editable title/description/price fields on a
  // pasted-product-link card). No-op on a node without a productRef.
  function updateNodeProductRef(nodeId: string, patch: Partial<NonNullable<StoryboardNode["productRef"]>>) {
    setBoard((b) => ({
      ...b,
      nodes: b.nodes.map((n) => (n.id === nodeId && n.productRef ? { ...n, productRef: { ...n.productRef, ...patch } } : n)),
    }));
  }

  // Same pattern again, for the Shooting Guide panel's angle/tone/pace
  // fields — starts from an all-empty guide if the node doesn't have one
  // yet (e.g. a hand-made card, or a breakdown from before this feature).
  function updateNodeShootingGuide(nodeId: string, patch: Partial<{ angle: string; tone: string; pace: string }>) {
    setBoard((b) => ({
      ...b,
      nodes: b.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, shootingGuide: { angle: "", tone: "", pace: "", ...(n.shootingGuide || {}), ...patch } }
          : n
      ),
    }));
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
    beginBusy("upload");
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
      setBusyKind(null);
    }
  }

  // "Import original video" on a chain-head card — a SEPARATE upload target
  // from the card's own clip slot above (startUpload/handleFileChosen):
  // reuses the same /upload route, but under a `${nodeId}__ref` filename so
  // it lands as its own file rather than colliding with (or replacing) the
  // card's own attached footage. The returned URL is kept in local state
  // only (refVideoByNode) until the user hits "Breakdown chain".
  function startRefUpload(nodeId: string) {
    refUploadNodeIdRef.current = nodeId;
    refFileInputRef.current?.click();
  }

  async function handleRefFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const nodeId = refUploadNodeIdRef.current;
    e.target.value = "";
    if (!file || !nodeId) return;
    setRefUploadingNodeId(nodeId);
    beginBusy("upload");
    clearNodeError(nodeId);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("nodeId", `${nodeId}__ref`);
      const res = await fetch(`${apiBase}/upload`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      if (data.kind !== "video") throw new Error("The reference file needs to be a video, not a photo.");
      setRefVideoByNode((prev) => ({ ...prev, [nodeId]: { url: data.url, kind: data.kind } }));
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [nodeId]: err.message || "Upload failed" }));
    } finally {
      setRefUploadingNodeId(null);
      setBusyKind(null);
    }
  }

  function removeRefVideo(nodeId: string) {
    setRefVideoByNode((prev) => {
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
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

  // "Paste a TikTok PRODUCT link anywhere" — the product-page sibling of
  // importTikTokClip: creates a placeholder product card immediately (same
  // optimistic pattern), then asks the server to best-effort scrape the
  // page's Open Graph tags and patches the result onto the card. A failed
  // scrape isn't an error state for the card itself — productRef comes back
  // with scrapeFailed: true and the user fills the fields in by hand.
  async function importProductLink(url: string) {
    const rightmost = board.nodes.reduce((max, n) => Math.max(max, n.x), 0);
    const node: StoryboardNode = {
      id: crypto.randomUUID(),
      label: "Product",
      instruction: "",
      x: board.nodes.length === 0 ? 60 : rightmost + NODE_W + GAP_X,
      y: 120,
      clip: null,
      productRef: { sourceUrl: url, title: "", description: "", imageUrl: null, price: null, rating: null, soldOrReviews: null, storeName: null, scrapeFailed: false },
    };
    setBoard((b) => ({ ...b, nodes: [...b.nodes, node] }));
    setBusyNodeId(node.id);
    try {
      const res = await fetch(`${apiBase}/import-product-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, nodeId: node.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setBoard((b) => ({
        ...b,
        nodes: b.nodes.map((n) =>
          n.id === node.id ? { ...n, productRef: data.productRef, label: data.productRef.title || "Product" } : n
        ),
      }));
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
      // Product links first — a TikTok Shop URL also matches the generic
      // isTikTokUrl pattern, so the more specific check has to win.
      const productUrl = isTikTokProductUrl(text);
      if (productUrl) {
        e.preventDefault();
        importProductLink(productUrl);
        return;
      }
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
    beginBusy("aiImage");
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
      setBusyKind(null);
    }
  }

  // "Breakdown into 6 stages" — for a TikTok-imported clip, asks the server
  // to transcribe + run the same 6-stage funnel analysis used by Video
  // Analysis, then swaps this single card out for 6 new stage-tagged cards
  // (one per funnel stage, each trimmed to that stage's time range and
  // pre-filled with the AI's summary/quote as a starting instruction).
  async function startBreakdown(node: StoryboardNode) {
    if (!window.confirm("Break this TikTok clip down into tagged stage cards (only the stages actually found in the video)? The original card will be replaced.")) return;
    setBusyNodeId(node.id);
    beginBusy("breakdown");
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
      setBusyKind(null);
    }
  }

  // "Breakdown chain" — the sibling of startBreakdown above, for a chain
  // whose cards already exist (e.g. from "Insert template" or hand-wired):
  // takes the reference video staged via startRefUpload on this chain-head
  // card and asks the server to distribute the 6-stage analysis onto the
  // EXISTING connected cards (matched by stageTag, positional fallback for
  // untagged ones) instead of creating/replacing any node. See
  // breakdown-chain/route.ts for the matching logic.
  async function startBreakdownChain(node: StoryboardNode) {
    const ref = refVideoByNode[node.id];
    if (!ref) return;
    if (!window.confirm("Break down this reference video and fill in the connected chain's script + shooting guide? Cards with no clip yet may get a reference clip trimmed in.")) return;
    setBusyNodeId(node.id);
    beginBusy("breakdownChain");
    clearNodeError(node.id);
    try {
      const res = await fetch(`${apiBase}/breakdown-chain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, referenceVideoUrl: ref.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chain breakdown failed");
      const updatedById = new Map<string, StoryboardNode>((data.updatedNodes as StoryboardNode[]).map((n) => [n.id, n]));
      setBoard((b) => ({
        ...b,
        nodes: b.nodes.map((n) => updatedById.get(n.id) || n),
      }));
      removeRefVideo(node.id);
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [node.id]: err.message || "Chain breakdown failed" }));
    } finally {
      setBusyNodeId(null);
      setBusyKind(null);
    }
  }

  // "Generate script" on a connected product card — the server reads the
  // chain of already-broken-down cards this product card is wired to (their
  // CURRENT script text, not a fresh re-analysis) and synthesizes a new
  // 6-stage shoppable script for this product, preserving the chain's core
  // viral structure. Adds the 6 new stage-tagged text-only cards; the
  // product card itself SURVIVES but has its connections stripped (mirrors
  // the server route exactly — the local apply must keep the node too, or
  // the next autosave would overwrite the server's kept copy), ending up as
  // a free-floating, reusable card.
  async function generateShoppableScript(node: StoryboardNode) {
    if (!window.confirm("Generate a new 6-stage shoppable script from the connected cards? The product card stays on the board, just disconnected.")) return;
    setBusyNodeId(node.id);
    beginBusy("shoppableScript");
    clearNodeError(node.id);
    try {
      const res = await fetch(`${apiBase}/generate-shoppable-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Script generation failed");
      setBoard((b) => ({
        ...b,
        nodes: [...b.nodes, ...data.newNodes],
        connections: [...b.connections.filter((c) => c.fromId !== node.id && c.toId !== node.id), ...data.newConnections],
      }));
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [node.id]: err.message || "Script generation failed" }));
    } finally {
      setBusyNodeId(null);
      setBusyKind(null);
    }
  }

  // "Generate product script" — for the same pending TikTok card Breakdown
  // works on, but instead of handing back the reference video's own
  // breakdown, the server runs the same transcription+analysis and then one
  // more Claude call (generateScriptForProduct, the same logic as the
  // standalone Video Analysis "Generate script" feature) to write a NEW
  // 6-stage script adapted to the Shopify product the user just picked.
  // Replaces this card with 6 stage-tagged, text-only cards (clip: null).
  async function handleProductPicked(product: { id: string; title: string }) {
    const nodeId = productPickerNodeId;
    setProductPickerNodeId(null);
    if (!nodeId) return;
    setBusyNodeId(nodeId);
    beginBusy("productScript");
    clearNodeError(nodeId);
    try {
      const res = await fetch(`${apiBase}/generate-product-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, shopifyProductId: product.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Script generation failed");
      setBoard((b) => ({
        ...b,
        nodes: [...b.nodes.filter((n) => n.id !== nodeId), ...data.newNodes],
        connections: [...b.connections.filter((c) => c.fromId !== nodeId && c.toId !== nodeId), ...data.newConnections],
      }));
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [nodeId]: err.message || "Script generation failed" }));
    } finally {
      setBusyNodeId(null);
      setBusyKind(null);
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
    beginBusy("renderVideo");
    setRenderError(null);
    setRenderResult(null);
    try {
      const res = await fetch(`${apiBase}/render`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Render failed");
      setRenderResult({ url: data.url, skipped: data.skipped || [], styleApplied: data.styleApplied || null, appliedFeedback: data.appliedFeedback || null });
    } catch (err: any) {
      setRenderError(err.message || "Render failed");
    } finally {
      setRendering(false);
      setBusyKind(null);
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
    beginBusy("styleAnalyze");
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
      setBusyKind(null);
    }
  }

  function clearStyleProfile() {
    setBoard((b) => ({ ...b, styleProfile: null }));
    setStyleError(null);
  }

  async function analyzeStyleFromUrl(url: string) {
    setAnalyzingStyle(true);
    beginBusy("styleAnalyze");
    setStyleError(null);
    try {
      const res = await fetch(`${apiBase}/style/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Style analysis failed");
      setBoard((b) => ({ ...b, styleProfile: data.profile as StoryboardStyleProfile }));
    } catch (err: any) {
      setStyleError(err.message || "Style analysis failed");
    } finally {
      setAnalyzingStyle(false);
      setBusyKind(null);
    }
  }

  function promptForStyleUrl() {
    const url = window.prompt("Paste a TikTok video link to use as the editing-style reference:");
    if (url && url.trim()) analyzeStyleFromUrl(url.trim());
  }

  const nodeById = new Map(board.nodes.map((n) => [n.id, n] as const));
  const order = resolveStoryboardOrder(board.nodes, board.connections);
  const orderNumber = new Map(order.map((n, i) => [n.id, i + 1] as const));
  // Where the "Generate video" button(s) appear: at the end of any
  // connected sequence of 3+ cards, regardless of stage tags — connection
  // topology alone decides this now (previously required all 6 funnel
  // stages tagged in CTA order, which was too rigid for freeform boards).
  const chainTails = resolveChainTails(board.nodes, board.connections).filter(
    (t) => t.chainLength >= MIN_CHAIN_LENGTH_FOR_GENERATE
  );

  // Chain HEADS — the mirror-image anchor point of chainTails above: a node
  // with an outgoing connection but no incoming one, i.e. the start of a
  // connected sequence. Renders the "import a reference video + Breakdown
  // chain" widget below it (see startRefUpload/startBreakdownChain), same
  // anchored-below-the-card placement pattern the tail's Generate button
  // and the product card's Generate script button already use. Excludes the
  // two special pending-card layouts, which already have their own
  // breakdown-ish actions built into the card itself.
  const chainHeads = board.nodes.filter(
    (n) =>
      !isPendingTiktokBreakdown(n) &&
      !isPendingProductCard(n) &&
      board.connections.some((c) => c.fromId === n.id) &&
      !board.connections.some((c) => c.toId === n.id)
  );

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
    const x1 = from.x + (forward ? nodeWidth(from) : 0);
    const y1 = from.y + cardHeight(from) / 2 + fanOffset(fromKey);
    const x2 = to.x + (forward ? 0 : nodeWidth(to));
    const y2 = to.y + cardHeight(to) / 2 + fanOffset(toKey);
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
    <div className="fixed inset-0 bg-panel2 z-50 flex flex-col">
      <input ref={fileInputRef} type="file" accept="video/*,image/*" className="hidden" onChange={handleFileChosen} />
      <input ref={styleFileInputRef} type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" onChange={handleStyleFileChosen} />
      <input ref={refFileInputRef} type="file" accept="video/*" className="hidden" onChange={handleRefFileChosen} />

      {/* Two rows: the button row never wraps its controls away from the
          Close button (shrink-0 all round), and the Generate-readiness
          status text lives on its own full-width line below where it can
          wrap freely without crowding Close out of reach. */}
      <div className="border-b border-edge bg-panel shrink-0 w-full overflow-x-hidden">
        <div className="flex items-center justify-between px-5 py-3 flex-wrap gap-2 w-full">
          <div className="min-w-0 flex-1">
            <h3 className="text-zinc-900 font-semibold text-sm truncate">Generate Video — Storyboard</h3>
            <p className="text-xs text-zinc-500 break-words">
              Drag cards to arrange · edit any card's text · click a dot, then click another card's dot to connect (Esc to cancel) · numbers show render order · paste a TikTok video link anywhere to add it as a new video card, or a TikTok product link to add a product card · Ctrl/Cmd+drag a card to move its whole connected chain together · Shift+drag empty space to box-select multiple cards · the head of any connected chain gets an "Import original video" widget below it — upload a reference video and hit Breakdown chain to auto-fill that chain's script + shooting guide.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
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
            <button onClick={addNode} className="px-2.5 h-7 rounded border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-xs">
              + Add shot
            </button>
            <button
              onClick={insertTemplate}
              title="Drop 6 blank funnel-stage cards (Reaction → CTA), pre-connected in order"
              className="px-2.5 h-7 rounded border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-xs"
            >
              📋 Insert template
            </button>
            <button onClick={() => zoomBy(1.2)} className="w-7 h-7 rounded border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-sm">
              +
            </button>
            <button onClick={() => zoomBy(1 / 1.2)} className="w-7 h-7 rounded border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-sm">
              −
            </button>
            <button
              onClick={() => setBoard((b) => ({ ...b, zoom: 1, pan: { x: 40, y: 40 } }))}
              className="px-2 h-7 rounded border border-edge text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-xs"
            >
              Reset view
            </button>
            <button onClick={onClose} className="ml-2 text-zinc-500 hover:text-zinc-900 text-sm shrink-0">
              ✕ Close
            </button>
          </div>
        </div>
        <div className="px-5 pb-2.5">
          {chainTails.length > 0 ? (
            <span className="text-xs text-green-600">
              ✓ Ready — see the Generate button under the end of your connected card{chainTails.length > 1 ? "s (one per chain)" : ""}
            </span>
          ) : (
            <span className="text-xs text-zinc-500">
              Connect at least {MIN_CHAIN_LENGTH_FOR_GENERATE} cards in a row to unlock Generate — the button appears under the last card in the chain
            </span>
          )}
        </div>
        {saveStatus === "error" && (
          <div className="px-5 py-2 bg-red-500/15 border-t border-red-500/40 flex items-center justify-between gap-3">
            <span className="text-xs text-red-600">
              ⚠ Your last change didn't save — it may only exist in this browser tab right now. Don't close this window until it saves.
            </span>
            <button
              onClick={saveBoardNow}
              className="px-2.5 py-1 rounded bg-red-500/20 border border-red-500/50 text-red-700 text-xs font-medium hover:bg-red-500/30 shrink-0"
            >
              Retry save
            </button>
          </div>
        )}
      </div>

      {/* Always-docked journal panel — compact by default, drag the thin
          handle on its bottom edge to resize (down = taller, up = shorter). */}
      <div className="border-b border-edge bg-panel shrink-0 w-full flex flex-col overflow-hidden" style={{ height: journalHeight }}>
        <div ref={journalScrollRef} className="flex-1 overflow-y-auto px-5 py-3 flex flex-col gap-2.5 min-h-0">
          {journalEntries.length === 0 && !journalLoading && (
            <p className="text-xs text-zinc-500">
              Write like you're journaling to a friend — how's today going, what are you working on, what's on your mind?
            </p>
          )}
          {journalEntries.map((e) => (
            <div
              key={e.id}
              className={`max-w-[75%] px-3 py-2 rounded-2xl text-xs leading-relaxed ${
                e.role === "user" ? "self-end bg-brand-500 text-white" : "self-start bg-panel2 text-zinc-800"
              }`}
            >
              {e.content}
            </div>
          ))}
          {journalSending && <div className="self-start text-xs text-zinc-500 animate-pulse">{estimateLabel("...", tick)}</div>}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendJournalMessage();
          }}
          className="border-t border-edge px-3 py-2 flex items-center gap-2 shrink-0"
        >
          <input
            value={journalDraft}
            onChange={(e) => setJournalDraft(e.target.value)}
            placeholder="Today was..."
            className="flex-1 h-8 px-3 rounded-full bg-panel2 border border-edge text-xs text-zinc-900 outline-none focus:border-brand-500 placeholder:text-zinc-400"
          />
          <button
            type="submit"
            disabled={!journalDraft.trim() || journalSending}
            className="h-8 px-3 rounded-full bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium shrink-0"
          >
            Send
          </button>
        </form>
        {/* bottom-edge drag handle — dragging DOWN increases clientY, which
            makes the panel taller; clamped so it can't collapse below the
            input row or swallow the whole canvas. */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const originH = journalHeight;
            function onMove(ev: MouseEvent) {
              const next = Math.min(420, Math.max(56, originH + (ev.clientY - startY)));
              setJournalHeight(next);
            }
            function onUp() {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            }
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          className="h-1.5 cursor-ns-resize bg-edge hover:bg-brand-500 transition-colors shrink-0"
          title="Drag to resize"
        />
      </div>

      {(renderError || renderResult) && (
        <div className="px-5 py-3 border-b border-edge bg-panel2 shrink-0 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {renderError && <p className="text-sm text-red-400">{renderError}</p>}
            {renderResult && (
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-sm text-green-600">
                  Render done{renderResult.styleApplied ? ` — applied ${renderResult.styleApplied.pacing} reference style` : ""}
                  {renderResult.appliedFeedback ? ` — ${renderResult.appliedFeedback.notes}` : ""}
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
              className="text-zinc-500 hover:text-zinc-900 text-xs"
            >
              ✕
            </button>
          </div>

          {renderResult && (
            <div className="flex items-end gap-2 flex-wrap border-t border-edge pt-2.5">
              <div className="flex-1 min-w-[240px]">
                <label className="text-[10px] text-zinc-500 mb-1 block">Want something changed? Tell the AI what to adjust, then regenerate.</label>
                <textarea
                  value={board.direction}
                  onChange={(e) => setBoard((b) => ({ ...b, direction: e.target.value }))}
                  placeholder="e.g. faster cuts, punchier captions, less text on screen, more product close-ups..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg bg-panel border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500 resize-none"
                />
              </div>
              <button
                onClick={startStyleUpload}
                className="h-9 px-2.5 rounded border border-dashed border-edge2 text-xs text-zinc-600 hover:text-zinc-900 hover:border-brand-500 shrink-0"
              >
                📎 {board.styleProfile ? `Ref: ${board.styleProfile.sourceLabel}` : "Import reference video"}
              </button>
              <button
                onClick={renderVideo}
                disabled={rendering}
                className="h-9 px-3 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium shrink-0"
              >
                {rendering ? "Regenerating..." : "🔁 Regenerate"}
              </button>
            </div>
          )}
        </div>
      )}

      <div
        ref={viewportRef}
        onMouseDown={handleBackgroundMouseDown}
        className="relative flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        style={{
          backgroundImage: "radial-gradient(circle, #d4d4d8 1px, transparent 1px)",
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
                const forward = connDraft.x >= from.x + nodeWidth(from) / 2;
                const x1 = from.x + (forward ? nodeWidth(from) : 0);
                const y1 = from.y + cardHeight(from) / 2;
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
                className="absolute w-6 h-6 rounded-full bg-ink border border-edge2 text-zinc-500 hover:text-red-500 hover:border-red-400 text-xs leading-none flex items-center justify-center"
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
                className={`group absolute bg-panel border rounded-xl shadow-xl flex flex-col overflow-hidden ${
                  selectedIds.has(node.id) ? "border-brand-500 ring-2 ring-brand-500" : "border-edge"
                }`}
                style={{ left: node.x, top: node.y, width: nodeWidth(node), height: cardHeight(node) }}
              >
                {isPendingTiktokBreakdown(node) ? (
                  <>
                    <div
                      onMouseDown={(e) => handleNodeMouseDown(e, node)}
                      className="px-3 py-1.5 border-b border-edge cursor-move flex items-center gap-2 shrink-0"
                      style={{ borderLeft: `3px solid ${accent}` }}
                    >
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold text-ink shrink-0"
                        style={{ background: accent }}
                      >
                        {orderNumber.get(node.id) ?? "?"}
                      </span>
                      <span className="flex-1 min-w-0 text-xs font-semibold text-zinc-900 truncate">TikTok clip</span>
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => deleteNode(node.id)}
                        title="Delete shot"
                        className="text-zinc-500 hover:text-red-400 text-xs shrink-0"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="relative bg-black shrink-0" style={{ height: TIKTOK_PREVIEW_VIDEO_H }}>
                      {busy && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
                          <span className="text-[11px] text-white animate-pulse">{estimateLabel("Working...", tick)}</span>
                        </div>
                      )}
                      {node.clip && (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video src={node.clip.url} controls className="w-full h-full object-contain bg-black" />
                      )}
                    </div>
                    <div className="p-2 flex-1 flex flex-col justify-center gap-1.5">
                      <button
                        onClick={() => startBreakdown(node)}
                        disabled={busy}
                        className="w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium"
                      >
                        🔍 Breakdown into stages
                      </button>
                      <button
                        onClick={() => setProductPickerNodeId(node.id)}
                        disabled={busy}
                        className="w-full py-2 rounded-lg bg-panel2 border border-edge hover:border-brand-500 disabled:opacity-40 text-zinc-800 text-xs font-medium"
                      >
                        🛍️ Generate product script
                      </button>
                      {err && <p className="mt-0.5 text-[10px] text-red-400">{err}</p>}
                    </div>
                  </>
                ) : isPendingProductCard(node) ? (
                  <>
                    <div
                      onMouseDown={(e) => handleNodeMouseDown(e, node)}
                      className="px-3 py-1.5 border-b border-edge cursor-move flex items-center gap-2 shrink-0"
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
                        className="flex-1 min-w-0 bg-transparent text-xs font-semibold text-zinc-900 outline-none"
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
                    <div className="relative bg-black shrink-0" style={{ height: TIKTOK_PREVIEW_VIDEO_H }}>
                      {busy && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
                          <span className="text-[11px] text-white animate-pulse">{estimateLabel("Working...", tick)}</span>
                        </div>
                      )}
                      {node.productRef!.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={node.productRef!.imageUrl} alt="" className="w-full h-full object-contain bg-black" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-panel2">
                          <span className="text-[10px] text-zinc-500">No image</span>
                        </div>
                      )}
                    </div>
                    <div onMouseDown={(e) => e.stopPropagation()} className="p-2 flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
                      {node.productRef!.scrapeFailed && (
                        <p className="text-[10px] text-zinc-500">Couldn't auto-fill from this link — enter the product details yourself.</p>
                      )}
                      <input
                        value={node.productRef!.title}
                        onChange={(e) => updateNodeProductRef(node.id, { title: e.target.value })}
                        placeholder="Product title"
                        className="w-full bg-transparent text-xs font-medium text-zinc-900 outline-none placeholder:text-zinc-400 border-b border-edge focus:border-edge2 pb-0.5"
                      />
                      <textarea
                        value={node.productRef!.description}
                        onChange={(e) => updateNodeProductRef(node.id, { description: e.target.value })}
                        placeholder="Product description / selling points"
                        className="w-full flex-1 min-h-0 bg-transparent text-[11px] text-zinc-700 leading-snug outline-none resize-none placeholder:text-zinc-400"
                      />
                      <input
                        value={node.productRef!.price || ""}
                        onChange={(e) => updateNodeProductRef(node.id, { price: e.target.value || null })}
                        placeholder="Price (e.g. $19.99)"
                        className="w-full bg-transparent text-[11px] text-zinc-700 outline-none placeholder:text-zinc-400 border-t border-edge pt-1"
                      />
                      {/* Rating / reviews / store — best-effort scraped (often
                          empty for TikTok Shop's JS-rendered pages), always
                          freely editable, same as the fields above. */}
                      <input
                        value={node.productRef!.rating || ""}
                        onChange={(e) => updateNodeProductRef(node.id, { rating: e.target.value || null })}
                        placeholder="Rating (e.g. 4.6★)"
                        className="w-full bg-transparent text-[11px] text-zinc-700 outline-none placeholder:text-zinc-400"
                      />
                      <input
                        value={node.productRef!.soldOrReviews || ""}
                        onChange={(e) => updateNodeProductRef(node.id, { soldOrReviews: e.target.value || null })}
                        placeholder="Reviews (e.g. 5.7K reviews)"
                        className="w-full bg-transparent text-[11px] text-zinc-700 outline-none placeholder:text-zinc-400"
                      />
                      <input
                        value={node.productRef!.storeName || ""}
                        onChange={(e) => updateNodeProductRef(node.id, { storeName: e.target.value || null })}
                        placeholder="Store name"
                        className="w-full bg-transparent text-[11px] text-zinc-700 outline-none placeholder:text-zinc-400"
                      />
                      {err && <p className="text-[10px] text-red-400">{err}</p>}
                    </div>
                  </>
                ) : (
                  <>
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
                    className="flex-1 min-w-0 bg-transparent text-xs font-semibold text-zinc-900 outline-none"
                  />
                  <select
                    value={node.stageTag || ""}
                    onChange={(e) => updateNodeStageTag(node.id, (e.target.value || null) as FunnelStageKey | null)}
                    onMouseDown={(e) => e.stopPropagation()}
                    title="Funnel stage this card covers (optional — Breakdown/product-script features set this automatically; not required for Generate)"
                    className="shrink-0 bg-transparent border border-edge rounded text-[9px] text-zinc-500 outline-none px-1 py-0.5"
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

                {/* Script + Shooting Guide, side by side in one row that
                    shares nodeScriptBoxH — the guide is 3 compact
                    angle/tone/pace inputs (auto-filled by Breakdown, freely
                    editable, empty placeholders on hand-made cards). Both
                    halves are min-w-0 so the default 300px card width
                    degrades to truncation instead of overflow. */}
                <div className="flex border-b border-edge shrink-0 min-w-0" style={{ height: nodeScriptBoxH(node) }}>
                  <div className="px-3 py-2 min-w-0" style={{ flex: 3 }}>
                    <label className="text-[9px] uppercase tracking-wide text-zinc-500 mb-1 block">Script</label>
                    <textarea
                      value={node.instruction}
                      onChange={(e) => updateNodeText(node.id, { instruction: e.target.value })}
                      onMouseDown={(e) => e.stopPropagation()}
                      placeholder="What happens in this shot? Dialogue, action, camera direction..."
                      className="w-full bg-transparent text-xs text-zinc-800 leading-relaxed outline-none resize-none placeholder:text-zinc-400"
                      style={{ height: nodeScriptBoxH(node) - 22 }}
                    />
                  </div>
                  <div className="px-2 py-1.5 border-l border-edge flex flex-col gap-1 min-w-0 overflow-hidden" style={{ flex: 2 }}>
                    <label className="text-[9px] uppercase tracking-wide text-zinc-500 leading-none">Shooting Guide</label>
                    {(["angle", "tone", "pace"] as const).map((field) => (
                      <div key={field} className="flex flex-col min-w-0">
                        <span className="text-[8px] text-zinc-400 capitalize leading-none">{field}</span>
                        <input
                          value={node.shootingGuide?.[field] || ""}
                          onChange={(e) => updateNodeShootingGuide(node.id, { [field]: e.target.value })}
                          onMouseDown={(e) => e.stopPropagation()}
                          placeholder={field === "angle" ? "e.g. close-up, handheld" : field === "tone" ? "e.g. playful, urgent" : "e.g. fast cuts"}
                          className="w-full min-w-0 bg-transparent text-[10px] leading-tight text-zinc-700 outline-none placeholder:text-zinc-400 border-b border-transparent focus:border-edge2"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="px-3 py-2 border-b border-edge shrink-0" style={{ height: nodeNotesBoxH(node) }}>
                  <label className="text-[9px] uppercase tracking-wide text-zinc-500 mb-1 block">Your editing notes</label>
                  <textarea
                    value={node.editorNotes || ""}
                    onChange={(e) => updateNodeText(node.id, { editorNotes: e.target.value })}
                    onMouseDown={(e) => e.stopPropagation()}
                    placeholder="Notes for yourself when filming/editing this shot — pacing, framing, tone..."
                    className="w-full bg-transparent text-xs text-zinc-500 leading-relaxed outline-none resize-none placeholder:text-zinc-400"
                    style={{ height: nodeNotesBoxH(node) - 22 }}
                  />
                </div>

                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  className="relative border-b border-edge shrink-0 bg-black"
                  style={{ height: nodeClipVideoH(node) }}
                >
                  {busy && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
                      <span className="text-[11px] text-white animate-pulse">{estimateLabel("Working...", tick)}</span>
                    </div>
                  )}
                  {node.clip ? (
                    <div className="relative w-full h-full">
                      {node.clip.kind === "video" ? (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video
                          src={node.clip.url}
                          controls
                          className="w-full h-full object-contain bg-black"
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={node.clip.url} alt="" className="w-full h-full object-contain bg-black" />
                      )}
                      <button
                        onClick={() => setNodeClip(node.id, null)}
                        title="Remove clip and re-upload"
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] flex items-center justify-center hover:bg-red-500/80 z-10"
                      >
                        ✕
                      </button>
                      <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-zinc-300">
                        {node.clip.source === "upload"
                          ? "Uploaded"
                          : node.clip.source === "ai"
                          ? "AI reference"
                          : node.clip.source === "tiktok"
                          ? "Imported from TikTok"
                          : "Library"}
                      </span>
                    </div>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-4">
                      <p className="text-[10px] text-zinc-500 text-center">Record this shot yourself, then upload it here (9:16)</p>
                      <div className="w-full flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => startUpload(node.id)}
                          className="flex-1 h-8 rounded bg-panel border border-edge text-[10px] text-zinc-600 hover:text-zinc-900 hover:border-edge2"
                        >
                          📤 Upload
                        </button>
                        <button
                          onClick={() => setPickerForNode(node.id)}
                          className="flex-1 h-8 rounded bg-panel border border-edge text-[10px] text-zinc-600 hover:text-zinc-900 hover:border-edge2"
                        >
                          📚 Library
                        </button>
                        <button
                          onClick={() => generateAiImage(node)}
                          className="flex-1 h-8 rounded bg-panel border border-edge text-[10px] text-zinc-600 hover:text-zinc-900 hover:border-edge2"
                        >
                          ✨ AI
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {err && <p className="px-2 py-1 text-[10px] text-red-400 bg-panel border-t border-edge">{err}</p>}
                  </>
                )}

                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => handleDotClick(e, node.id)}
                  title={connStart === node.id ? "Click to cancel" : connStart ? "Click to connect here" : "Click to start a connection"}
                  className={`absolute w-8 h-8 rounded-full border-[4px] cursor-pointer transition-transform hover:scale-125 ${
                    connStart === node.id ? "border-white animate-pulse" : "border-ink"
                  }`}
                  style={{ left: nodeWidth(node), top: cardHeight(node) / 2, transform: "translate(-50%,-50%)", background: accent }}
                />
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => handleDotClick(e, node.id)}
                  title={connStart === node.id ? "Click to cancel" : connStart ? "Click to connect here" : "Click to start a connection"}
                  className={`absolute w-8 h-8 rounded-full border-[4px] cursor-pointer transition-transform hover:scale-125 ${
                    connStart === node.id ? "border-white animate-pulse" : "border-ink"
                  }`}
                  style={{ left: 0, top: cardHeight(node) / 2, transform: "translate(-50%,-50%)", background: accent }}
                />
                {!isPendingTiktokBreakdown(node) && !isPendingProductCard(node) && (
                  <div
                    onMouseDown={(e) => handleResizeMouseDown(e, node)}
                    title="Drag to resize"
                    className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                    style={{
                      backgroundImage:
                        "linear-gradient(135deg, transparent 0%, transparent 45%, #71717a 45%, #71717a 55%, transparent 55%, transparent 100%)",
                    }}
                  />
                )}
              </div>
            );
          })}

          {/* "Generate video" lives anchored under the tail card of any
              connected chain of 3+ cards — no stage tags required. A board
              can have multiple independent chains, each gets its own
              button. Uses cardHeight(n), not a flat NODE_H, since a tail
              could in principle be a not-yet-broken-down TikTok import card
              (taller than a normal card). */}
          {chainTails.map(({ node: n }) => {
            const styleWidgetTop = n.y + cardHeight(n) + 16;
            const generateButtonTop = styleWidgetTop + STYLE_WIDGET_H + STYLE_WIDGET_GAP;
            return (
              <Fragment key={`generate-group-${n.id}`}>
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute rounded-lg border border-dashed border-edge2 bg-panel px-2 flex items-center gap-1.5 text-[10px] overflow-hidden"
                  style={{ left: n.x, top: styleWidgetTop, width: nodeWidth(n), height: STYLE_WIDGET_H }}
                >
                  {analyzingStyle ? (
                    <span className="text-yellow-600 animate-pulse">{estimateLabel("Analyzing reference video...", tick)}</span>
                  ) : board.styleProfile ? (
                    <>
                      <span
                        className="text-zinc-700 truncate flex-1"
                        title={`${board.styleProfile.pacing} pacing · ${board.styleProfile.transition === "hard_cut" ? "hard cuts" : `${board.styleProfile.transition} transitions`} · ${board.styleProfile.captionStyle} captions · ~${board.styleProfile.avgShotSec.toFixed(1)}s/shot · ${board.styleProfile.notes}`}
                      >
                        🎨 {board.styleProfile.pacing} · {board.styleProfile.sourceLabel}
                      </span>
                      <button onClick={startStyleUpload} title="Replace reference video" className="text-zinc-500 hover:text-zinc-900 shrink-0">
                        ↺
                      </button>
                      <button onClick={clearStyleProfile} title="Clear reference video" className="text-zinc-500 hover:text-red-400 shrink-0">
                        ✕
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-zinc-500 shrink-0">🎨 Reference (optional):</span>
                      <button onClick={startStyleUpload} className="text-zinc-600 hover:text-zinc-900 shrink-0">
                        📎 Upload
                      </button>
                      <button onClick={promptForStyleUrl} className="text-zinc-600 hover:text-zinc-900 shrink-0">
                        🔗 Link
                      </button>
                    </>
                  )}
                </div>
                {styleError && (
                  <p
                    className="absolute text-[9px] text-red-400 leading-tight"
                    style={{ left: n.x, top: styleWidgetTop + STYLE_WIDGET_H + 2, width: nodeWidth(n) }}
                  >
                    {styleError}
                  </p>
                )}
                <button
                  onClick={renderVideo}
                  disabled={rendering}
                  className="absolute px-3 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium shadow-xl"
                  style={{ left: n.x, top: generateButtonTop, width: nodeWidth(n) }}
                >
                  {rendering ? estimateLabel("Rendering...", tick) : "🎬 Generate video"}
                </button>
              </Fragment>
            );
          })}

          {/* "Generate script" lives under any product card that's been
              wired into the graph (connected to at least one other card,
              either direction) — same anchored-below-the-card placement
              pattern as the chain-tail Generate button above. The server
              reads the connected chain's CURRENT script text and
              synthesizes a new shoppable script for this product (see the
              generate-shoppable-script route). */}
          {board.nodes
            .filter(
              (n) =>
                isPendingProductCard(n) &&
                board.connections.some((c) => c.fromId === n.id || c.toId === n.id)
            )
            .map((n) => (
              <button
                key={`shoppable-${n.id}`}
                onClick={() => generateShoppableScript(n)}
                disabled={busyNodeId === n.id}
                className="absolute px-3 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium shadow-xl"
                style={{ left: n.x, top: n.y + cardHeight(n) + 16, width: nodeWidth(n) }}
              >
                {busyNodeId === n.id ? estimateLabel("Generating script...", tick) : "✨ Generate script"}
              </button>
            ))}

          {/* "Import original video" + "Breakdown chain" — lives under the
              HEAD of any connected chain (see chainHeads above). Upload a
              full reference video here and it gets transcribed + run
              through the same 6-stage funnel analysis as the single-card
              Breakdown action, then the results are matched onto this
              chain's EXISTING cards (by stageTag, positional fallback for
              untagged ones) — no new cards created, nothing deleted. */}
          {chainHeads.map((n) => {
            const ref = refVideoByNode[n.id];
            const busy = busyNodeId === n.id;
            return (
              <div
                key={`chainhead-${n.id}`}
                onMouseDown={(e) => e.stopPropagation()}
                className="absolute rounded-lg border border-dashed border-edge2 bg-panel px-2 py-2 flex items-center gap-1.5 text-[10px] overflow-hidden"
                style={{ left: n.x, top: n.y + cardHeight(n) + 16, width: nodeWidth(n) }}
              >
                {ref ? (
                  <>
                    <span className="flex-1 text-zinc-600 truncate">✅ Reference video ready</span>
                    <button onClick={() => removeRefVideo(n.id)} title="Remove reference video" className="text-zinc-500 hover:text-red-400 shrink-0">
                      ✕
                    </button>
                    <button
                      onClick={() => startBreakdownChain(n)}
                      disabled={busy}
                      className="px-2.5 py-1.5 rounded bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[10px] font-medium shrink-0 whitespace-nowrap"
                    >
                      {busy ? estimateLabel("Breaking down...", tick) : "🎬 Breakdown chain"}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-zinc-500 shrink-0">📥 Reference video:</span>
                    <button
                      onClick={() => startRefUpload(n.id)}
                      disabled={refUploadingNodeId === n.id}
                      className="text-zinc-600 hover:text-zinc-900 disabled:opacity-40 shrink-0"
                    >
                      {refUploadingNodeId === n.id ? estimateLabel("Uploading...", tick) : "Upload to auto-fill this chain"}
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {/* Shift+drag rubber-band selection rectangle — world-space, so it
              lives inside the pannable/zoomable div and scales with pan/zoom
              automatically. */}
          {marquee && (
            <div
              className="absolute border border-dashed border-brand-500 bg-brand-500/10 pointer-events-none"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
        </div>
      </div>

      {pickerForNode && (
        <StoryboardLibraryPicker onSelect={handleLibraryPick} onClose={() => setPickerForNode(null)} />
      )}

      {productPickerNodeId && (
        <ProductPicker onSelect={handleProductPicked} onClose={() => setProductPickerNodeId(null)} />
      )}
    </div>
  );
}
