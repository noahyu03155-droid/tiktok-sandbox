"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { REACTION_EMOTIONS } from "@/lib/types";
import type { CanvasConnection, FunnelStageKey, GeneratedScriptStage, ReactionEmotion, StoryboardClip, StoryboardNode, StoryboardState, StoryboardStyleProfile } from "@/lib/types";
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
// Shooting Guide (angle/tone/pace) used to be squeezed into a side column
// next to Script, sharing its height and getting only ~2/5 of the card's
// 300px width — three labeled inputs in that little space read as
// cramped/hard to actually use. Now its own full-width row below Script,
// same treatment as the "Your editing notes" box, with the three fields
// laid out in a row across the card's full width instead of stacked in a
// sliver. Fixed height (not resizable like Script/Notes) since three short
// single-line inputs never need more room.
const SHOOTING_GUIDE_BOX_H = 54;
const NOTES_BOX_H = 80;
const CLIP_VIDEO_H = Math.round(NODE_W * (16 / 9));
const NODE_H = HEADER_H + SCRIPT_BOX_H + SHOOTING_GUIDE_BOX_H + NOTES_BOX_H + CLIP_VIDEO_H;
const GAP_X = 70;
const STYLE_WIDGET_H = 34; // compact reference-style control shown above each chain-tail's Generate button
const STYLE_WIDGET_GAP = 8;
const GENERATE_BUTTON_H = 36;
const RESULT_CARD_GAP = 10;
const RESULT_CARD_WIDTH = 360; // wider than a normal card — needs room for the video preview + feedback textarea
const RESULT_CARD_MAX_SKIPPED_SHOWN = 3; // long skip lists (a messy board with many leftover cards) used to spill the whole UI — show a few, then "and N more"
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
// renderVideo used to be here with a flat 30s guess — real renders (an
// ffmpeg encode per shot, sometimes minutes for a multi-shot storyboard)
// blew way past that, leaving the button stuck on "Almost done..." for
// however long the render actually took with no real feedback. It's no
// longer a fixed-estimate flow at all: renderVideo() now polls a
// background job (src/lib/storyboardRender.ts) and computes a live ETA
// from the ACTUAL observed time-per-shot (see renderButtonLabel below),
// which is both more honest and self-corrects as the render progresses.
const ACTION_ESTIMATE_SEC: Record<string, number> = {
  upload: 8,
  aiImage: 15,
  breakdown: 50, // ffmpeg trims + whisper transcript + Claude analysis + shooting guide
  breakdownChain: 55, // same pipeline, plus matching onto an existing chain
  shoppableScript: 20,
  productScript: 50, // same transcribe+analyze pipeline as breakdown, plus one more Claude call
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
// A pending TikTok video card's directly-connected pending product card, if
// any — lets "Generate product script" prefer whatever product the user
// already wired into the chain (see image2-style layouts: a product card
// connected down into a video card) over opening the ProductPicker's
// Shopify catalog search. Only looks at DIRECT neighbors (one hop), not the
// whole transitively-connected chain, since a product card should be
// unambiguously "the" product for this specific video, not any product
// anywhere downstream of it.
function findConnectedProductRefNode(
  node: StoryboardNode,
  nodes: StoryboardNode[],
  connections: CanvasConnection[]
): StoryboardNode | null {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const c of connections) {
    if (c.fromId !== node.id && c.toId !== node.id) continue;
    const otherId = c.fromId === node.id ? c.toId : c.fromId;
    const other = nodeById.get(otherId);
    if (other && isPendingProductCard(other)) return other;
  }
  return null;
}
// The mirror of findConnectedProductRefNode — given a PRODUCT card, finds a
// directly-connected raw/not-yet-broken-down TikTok video card, if any.
// Used to detect the "product + fresh video wired together at the start of
// a chain" case: when true, both cards' own default action buttons
// (Breakdown / Generate product script / Generate script) collapse into one
// combined action instead of all three showing at once — see the button
// JSX below for why three separate buttons for what's really one workflow
// was confusing, and why the plain product-only "Generate script" flow
// (generateShoppableScript, which expects an ALREADY-broken-down reference
// chain) would silently produce a low-quality script here anyway, since a
// pending video card's instruction text is still empty.
function findConnectedPendingVideoNode(
  node: StoryboardNode,
  nodes: StoryboardNode[],
  connections: CanvasConnection[]
): StoryboardNode | null {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const c of connections) {
    if (c.fromId !== node.id && c.toId !== node.id) continue;
    const otherId = c.fromId === node.id ? c.toId : c.fromId;
    const other = nodeById.get(otherId);
    if (other && isPendingTiktokBreakdown(other)) return other;
  }
  return null;
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
  return HEADER_H + nodeScriptBoxH(node) + SHOOTING_GUIDE_BOX_H + nodeNotesBoxH(node) + nodeClipVideoH(node);
}

function seedInstruction(script: string, direction: string) {
  return [script, direction ? `🎬 ${direction}` : ""].filter(Boolean).join("\n\n");
}

// Every fetch in this component reads the response body with `res.json()`.
// That's safe as long as the server actually answers — but every one of
// this app's own API routes always responds with NextResponse.json, even on
// failure, so a body that ISN'T valid JSON never comes from our own code.
// In practice it means the request never made it to (or back from) the
// Next.js server at all: Railway's edge proxy returning a plain-text body
// like "upstream error" when a request times out or the app process
// restarts/crashes mid-request (long ffmpeg renders are the most likely
// trigger). Without this, that shows up to the user as a raw, meaningless
// "Unexpected token 'u', "upstream error" is not valid JSON" crash instead
// of an actionable message. Used in place of a bare `await res.json()`
// everywhere in this file.
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.trim().slice(0, 200);
    throw new Error(
      res.ok
        ? `Got an unexpected non-JSON response from the server: "${snippet}"`
        : `The server didn't respond properly (status ${res.status}): "${snippet || "empty response"}". This usually means the request timed out or the app restarted mid-request — please try again${
            snippet.toLowerCase().includes("upstream") ? " (if this keeps happening on video render, try a shorter storyboard — fewer/shorter clips render faster)." : "."
          }`
    );
  }
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
  // Whichever of Breakdown / Breakdown chain / Generate product script is
  // waiting on the user to answer "indoor or outdoor?" before it actually
  // runs (null = no prompt open) — see the LocationPromptModal render below
  // and confirmLocation. Asked so deriveShootingGuide (shootingGuide.ts) can
  // favor angle/tone/pace guidance that's realistic for where the creator
  // actually plans to film, instead of one-size-fits-all guidance.
  const [locationPromptFor, setLocationPromptFor] = useState<
    | { kind: "breakdown"; node: StoryboardNode }
    | { kind: "breakdownChain"; node: StoryboardNode }
    | {
        kind: "productScript";
        node: StoryboardNode;
        // Either a Shopify catalog product picked ad hoc through
        // ProductPicker, or the id of an already-connected pending
        // product card (productRef) on the canvas — see
        // findConnectedProductRefNode, which makes the video card prefer
        // an already-wired product over opening the picker.
        source: { type: "shopify"; product: { id: string; title: string } } | { type: "connected"; nodeId: string };
      }
    | { kind: "shoppableScript"; node: StoryboardNode }
    | null
  >(null);
  // ---- Reaction-emotion picker (Generate Product Script / Generate
  // Shoppable Script only — see REACTION_EMOTIONS in types.ts and
  // reactionEmotionInstruction in scriptgen.ts). Reuses the SAME modal as
  // the indoor/outdoor prompt above rather than a second popup — for
  // productScript both questions are asked together with one final
  // "Generate script" button; for shoppableScript (no location concept)
  // it's just the emotion picker. selectedLocation/selectedEmotion reset
  // whenever a new locationPromptFor is opened (see the effect below).
  const [selectedLocation, setSelectedLocation] = useState<"indoor" | "outdoor" | null>(null);
  const [selectedEmotion, setSelectedEmotion] = useState<ReactionEmotion | null>(null);
  // This member's own past picks (see /api/reaction-emotions) — sorts the
  // emotion picker so whichever they reach for most floats to the top,
  // ties broken by REACTION_EMOTIONS' fixed order. Fetched once; no need to
  // refetch mid-session, the increment happens server-side and only matters
  // for next time they open the picker.
  const [emotionUsage, setEmotionUsage] = useState<Partial<Record<ReactionEmotion, number>>>({});
  useEffect(() => {
    fetch("/api/reaction-emotions")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data?.usage && setEmotionUsage(data.usage))
      .catch(() => {});
  }, []);
  const sortedEmotions = [...REACTION_EMOTIONS].sort(
    (a, b) => (emotionUsage[b] || 0) - (emotionUsage[a] || 0)
  );
  useEffect(() => {
    setSelectedLocation(null);
    setSelectedEmotion(null);
  }, [locationPromptFor]);
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
  // Captions are opt-in per render (see storyboardRender.ts's CaptionsMode
  // doc comment for why script-text captions got removed entirely) — this
  // just tracks whether the confirm modal is open; the actual choice is
  // passed straight into renderVideo(captionsMode) and never persisted, so
  // the question is asked fresh every time Generate/Regenerate is clicked.
  const [captionsPromptOpen, setCaptionsPromptOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<{ url: string; skipped: string[]; styleApplied: { pacing: string; transition: string; notes: string } | null; appliedFeedback: { notes: string } | null } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  // Which chain-tail node the current/last render belongs to — the render
  // result card is drawn on the canvas anchored under THIS tail's Generate
  // button (see resolveChainNodeIds in storyboard.ts for why a render is now
  // scoped to one specific chain instead of a heuristically-guessed "primary"
  // one). pendingRenderTailId is a one-tick holding spot: set the instant
  // Generate/Regenerate is clicked, before the captions modal even resolves,
  // so chooseCaptionsAndRender knows which tail to actually send.
  const [pendingRenderTailId, setPendingRenderTailId] = useState<string | null>(null);
  const [renderChainTailId, setRenderChainTailId] = useState<string | null>(null);
  // Live progress from the background render job (see renderVideo below +
  // src/lib/storyboardRender.ts) — completedShots/totalShots/avgSecPerShot
  // are all real, observed numbers, not a guess, so the "~Xs left" shown on
  // the button gets more accurate as the render actually progresses instead
  // of being wrong from the start.
  const [renderProgress, setRenderProgress] = useState<{
    completedShots: number;
    totalShots: number;
    step: string;
    avgSecPerShot: number | null;
  } | null>(null);
  const renderPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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
  const [journalHeight, setJournalHeight] = useState(150);
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
      const data = await safeJson(res);
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
    // Let a scrollable textarea (the Script / "your editing notes" boxes)
    // handle its own wheel scroll natively instead of always zooming the
    // whole canvas — previously this fired unconditionally, so scrolling
    // long script/notes text required dragging the textarea's own
    // scrollbar handle rather than just scrolling the mouse wheel over it.
    if (e.target instanceof HTMLTextAreaElement) return;
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
      const data = await safeJson(res);
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
      const data = await safeJson(res);
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
      const data = await safeJson(res);
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
      const data = await safeJson(res);
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
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setNodeClip(node.id, { source: "ai", url: data.url, kind: data.kind });
    } catch (err: any) {
      setNodeErrors((prev) => ({ ...prev, [node.id]: err.message || "Generation failed" }));
    } finally {
      setBusyNodeId(null);
      setBusyKind(null);
    }
  }

  // "Breakdown into stages" — for a TikTok-imported clip, asks the server
  // to transcribe + run the same 6-stage funnel analysis used by Video
  // Analysis, then adds new stage-tagged cards (one per funnel stage
  // actually found, each trimmed to that stage's time range and pre-filled
  // with the AI's summary/quote as a starting instruction) in a new row
  // BELOW the original card. The original card is kept, untouched, so the
  // user can compare it against the breakdown — see breakdown/route.ts.
  function startBreakdown(node: StoryboardNode) {
    if (!window.confirm("Break this TikTok clip down into tagged stage cards (only the stages actually found in the video)? The original video stays on the board so you can compare it against the new cards.")) return;
    // Ask indoor/outdoor before actually running — see locationPromptFor.
    setLocationPromptFor({ kind: "breakdown", node });
  }

  async function runBreakdown(node: StoryboardNode, location: "indoor" | "outdoor" | null) {
    setBusyNodeId(node.id);
    beginBusy("breakdown");
    clearNodeError(node.id);
    try {
      const res = await fetch(`${apiBase}/breakdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, location }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Breakdown failed");
      // The original card is NOT filtered out here — the server keeps it
      // (and its existing connections) untouched; we just add the new
      // stage cards on top of the current board state.
      setBoard((b) => ({
        ...b,
        nodes: [...b.nodes, ...data.newNodes],
        connections: [...b.connections, ...data.newConnections],
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
  function startBreakdownChain(node: StoryboardNode) {
    const ref = refVideoByNode[node.id];
    if (!ref) return;
    if (!window.confirm("Break down this reference video and fill in the connected chain's script + shooting guide? Cards with no clip yet may get a reference clip trimmed in.")) return;
    setLocationPromptFor({ kind: "breakdownChain", node });
  }

  async function runBreakdownChain(node: StoryboardNode, location: "indoor" | "outdoor" | null) {
    const ref = refVideoByNode[node.id];
    if (!ref) return;
    setBusyNodeId(node.id);
    beginBusy("breakdownChain");
    clearNodeError(node.id);
    try {
      const res = await fetch(`${apiBase}/breakdown-chain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, referenceVideoUrl: ref.url, location }),
      });
      const data = await safeJson(res);
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
  // a free-floating, reusable card. The reaction-emotion modal (see
  // locationPromptFor's "shoppableScript" kind) now serves as the
  // confirmation step this used to need a window.confirm() for.
  async function generateShoppableScript(node: StoryboardNode, reactionEmotion?: ReactionEmotion | null) {
    setBusyNodeId(node.id);
    beginBusy("shoppableScript");
    clearNodeError(node.id);
    try {
      const res = await fetch(`${apiBase}/generate-shoppable-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, reactionEmotion: reactionEmotion || undefined }),
      });
      const data = await safeJson(res);
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
  function handleProductPicked(product: { id: string; title: string }) {
    const nodeId = productPickerNodeId;
    setProductPickerNodeId(null);
    if (!nodeId) return;
    const node = board.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // Ask indoor/outdoor before actually running — see locationPromptFor.
    setLocationPromptFor({ kind: "productScript", node, source: { type: "shopify", product } });
  }

  async function runGenerateProductScript(
    nodeId: string,
    source: { type: "shopify"; product: { id: string; title: string } } | { type: "connected"; nodeId: string },
    location: "indoor" | "outdoor" | null,
    reactionEmotion?: ReactionEmotion | null
  ) {
    setBusyNodeId(nodeId);
    beginBusy("productScript");
    clearNodeError(nodeId);
    try {
      const res = await fetch(`${apiBase}/generate-product-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId,
          location,
          reactionEmotion: reactionEmotion || undefined,
          ...(source.type === "shopify" ? { shopifyProductId: source.product.id } : { connectedProductNodeId: source.nodeId }),
        }),
      });
      const data = await safeJson(res);
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

  // Fired by the location-prompt modal's Indoor/Outdoor/Skip buttons —
  // dispatches to whichever of the 3 actions was actually waiting (see
  // locationPromptFor), now with the user's answer (or null for Skip).
  function confirmLocation(location: "indoor" | "outdoor" | null) {
    const pending = locationPromptFor;
    const emotion = selectedEmotion;
    setLocationPromptFor(null);
    if (!pending) return;
    if (pending.kind === "breakdown") runBreakdown(pending.node, location);
    else if (pending.kind === "breakdownChain") runBreakdownChain(pending.node, location);
    else if (pending.kind === "productScript") runGenerateProductScript(pending.node.id, pending.source, location, emotion);
    else if (pending.kind === "shoppableScript") generateShoppableScript(pending.node, emotion);
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

  // Applies one poll's worth of job status. `job` is whatever GET ${apiBase}/render
  // returns (see src/lib/storyboardRender.ts's RenderJob) — this both
  // updates the live progress display and, once the job leaves "running",
  // stops polling and resolves renderVideo()'s outer busy state.
  function applyRenderJob(job: {
    status: "running" | "done" | "error";
    totalShots: number;
    completedShots: number;
    step: string;
    avgSecPerShot: number | null;
    result: { url: string; skipped: string[]; styleApplied: { pacing: string; transition: string; notes: string } | null; appliedFeedback: { notes: string } | null } | null;
    error: string | null;
  } | null | undefined) {
    if (!job) return;
    setRenderProgress({
      completedShots: job.completedShots,
      totalShots: job.totalShots,
      step: job.step,
      avgSecPerShot: job.avgSecPerShot,
    });
    if (job.status === "done") {
      // Every render overwrites the SAME render.mp4 path (see
      // storyboardRender.ts's finalPath) — with an identical URL every
      // time, the browser (and the <video> element's own internal cache)
      // can and does keep showing whatever it fetched for that URL on a
      // PREVIOUS render, which is exactly why the inline preview and the
      // freshly-downloaded file could end up showing completely different
      // content. Appending a cache-busting query param unique to this
      // specific completed job forces both the preview <video> and the
      // Download link to actually fetch the file that was just generated.
      const result = job.result ? { ...job.result, url: `${job.result.url}?t=${Date.now()}` } : job.result;
      setRenderResult(result);
      stopRenderPoll();
      setRendering(false);
    } else if (job.status === "error") {
      setRenderError(job.error || "Render failed");
      stopRenderPoll();
      setRendering(false);
    }
  }

  function stopRenderPoll() {
    if (renderPollTimer.current) {
      clearInterval(renderPollTimer.current);
      renderPollTimer.current = null;
    }
  }

  async function pollRenderStatus() {
    try {
      const res = await fetch(`${apiBase}/render`, { cache: "no-store" });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to check render status");
      applyRenderJob(data.job);
    } catch {
      // A single poll failing (network blip) isn't fatal — the next tick 2s
      // later just tries again. Only an error the SERVER actually reports
      // via job.status:"error" above stops the render and surfaces to the
      // user; a transient poll failure shouldn't abandon an otherwise
      // successfully-running render.
    }
  }

  // Ensure the poll timer never outlives the component.
  useEffect(() => stopRenderPoll, []);

  async function renderVideo(captionsMode: "off" | "auto", chainTailId: string | null) {
    setRendering(true);
    setRenderError(null);
    setRenderResult(null);
    setRenderProgress(null);
    stopRenderPoll();
    try {
      const res = await fetch(`${apiBase}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captionsMode, chainTailId: chainTailId || undefined }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Render failed");
      applyRenderJob(data.job);
      // Only keep polling if the job is still running after this first
      // response — a 1-shot render can already be "done" by the time the
      // POST itself returns.
      if (data.job?.status === "running") {
        renderPollTimer.current = setInterval(pollRenderStatus, 2000);
      }
    } catch (err: any) {
      setRenderError(err.message || "Render failed");
      setRendering(false);
    }
  }

  // Both the initial "Generate video" button (one per chain-tail — see
  // chainTails.map below) and the post-render "🔁 Regenerate" button on the
  // result card go through here first — opens the captions-choice modal
  // instead of calling renderVideo() directly. tailId is the specific
  // chain-tail node whose button was clicked, so the server renders EXACTLY
  // that chain (see resolveChainNodeIds in storyboard.ts).
  function requestRender(tailId: string) {
    setPendingRenderTailId(tailId);
    setCaptionsPromptOpen(true);
  }

  function chooseCaptionsAndRender(mode: "off" | "auto") {
    setCaptionsPromptOpen(false);
    setRenderChainTailId(pendingRenderTailId);
    renderVideo(mode, pendingRenderTailId);
  }

  // Real-progress label for the Generate/Rendering button — replaces the
  // old fixed-guess estimateLabel for this one action (see the doc comment
  // on ACTION_ESTIMATE_SEC above for why). Falls back to a plain "Starting…"
  // until the first poll response has come back with real shot counts.
  function renderButtonLabel(): string {
    if (!rendering) return "🎬 Generate video";
    if (!renderProgress || renderProgress.totalShots === 0) return "Starting...";
    const { completedShots, totalShots, step, avgSecPerShot } = renderProgress;
    if (avgSecPerShot != null && completedShots > 0 && completedShots < totalShots) {
      const remainingSec = Math.round(avgSecPerShot * (totalShots - completedShots));
      const etaLabel = remainingSec >= 60 ? `~${Math.ceil(remainingSec / 60)}m left` : remainingSec > 2 ? `~${remainingSec}s left` : "almost done";
      return `Shot ${completedShots}/${totalShots} (${etaLabel})`;
    }
    return step || `Shot ${completedShots}/${totalShots}...`;
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
      const data = await safeJson(res);
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
      const data = await safeJson(res);
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
          handle on its bottom edge to resize (down = taller, up = shorter).
          Given a header + tinted background + avatar bubbles so it reads as
          a live chat with a creative partner rather than a stray text strip. */}
      <div
        className="border-b border-edge bg-gradient-to-b from-brand-50 to-panel shrink-0 w-full flex flex-col overflow-hidden"
        style={{ height: journalHeight }}
      >
        <div className="flex items-center gap-2 px-4 py-2 border-b border-brand-100 shrink-0">
          <span className="w-6 h-6 rounded-full bg-brand-500 text-white flex items-center justify-center text-xs shrink-0">
            💬
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-zinc-800 leading-tight">Journal with your AI partner</p>
            <p className="text-[10px] text-zinc-500 leading-tight truncate">
              Tell it what you're working on — it'll help you think it through
            </p>
          </div>
        </div>
        <div ref={journalScrollRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2.5 min-h-0">
          {journalEntries.length === 0 && !journalLoading && (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-1.5 py-2">
              <span className="text-2xl">📝</span>
              <p className="text-xs text-zinc-600 max-w-[280px]">
                Write like you're journaling to a friend — how's today going, what are you working on, what's on your mind?
              </p>
            </div>
          )}
          {journalEntries.map((e) => (
            <div
              key={e.id}
              className={`flex items-end gap-1.5 ${e.role === "user" ? "self-end flex-row-reverse" : "self-start"}`}
            >
              {e.role === "ai" && (
                <span className="w-5 h-5 rounded-full bg-brand-500 text-white flex items-center justify-center text-[10px] shrink-0">
                  🤖
                </span>
              )}
              <div
                className={`max-w-[260px] px-3 py-2 rounded-2xl text-xs leading-relaxed shadow-sm ${
                  e.role === "user" ? "bg-brand-500 text-white" : "bg-white text-zinc-800 border border-edge"
                }`}
              >
                {e.content}
              </div>
            </div>
          ))}
          {journalSending && (
            <div className="self-start flex items-end gap-1.5">
              <span className="w-5 h-5 rounded-full bg-brand-500 text-white flex items-center justify-center text-[10px] shrink-0">
                🤖
              </span>
              <div className="px-3 py-2 rounded-2xl text-xs bg-white border border-edge text-zinc-500 animate-pulse">
                {estimateLabel("...", tick)}
              </div>
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendJournalMessage();
          }}
          className="border-t border-brand-100 bg-white/60 px-3 py-2 flex items-center gap-2 shrink-0"
        >
          <input
            value={journalDraft}
            onChange={(e) => setJournalDraft(e.target.value)}
            placeholder="Today was..."
            className="flex-1 h-9 px-3.5 rounded-full bg-white border border-edge text-xs text-zinc-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 placeholder:text-zinc-400 shadow-sm transition-shadow"
          />
          <button
            type="submit"
            disabled={!journalDraft.trim() || journalSending}
            className="h-9 px-4 rounded-full bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium shrink-0 shadow-sm transition-colors flex items-center gap-1"
          >
            Send <span aria-hidden>➤</span>
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
              const next = Math.min(420, Math.max(104, originH + (ev.clientY - startY)));
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
            // A raw video card that already has a product card wired
            // directly into it — see findConnectedPendingVideoNode's doc
            // comment for why this collapses the card's usual two buttons
            // (Breakdown / Generate product script) into one combined
            // action instead.
            const connectedProductForVideo = isPendingTiktokBreakdown(node)
              ? findConnectedProductRefNode(node, board.nodes, board.connections)
              : null;
            return (
              <div
                key={node.id}
                // Grab-anywhere dragging: mousedown anywhere on the card
                // starts a drag, not just the header strip — every
                // interactive element inside (buttons, text inputs,
                // textareas, the resize grip, connection dots, video
                // controls) already calls stopPropagation() on its own
                // onMouseDown, so this bubbles up and fires only when the
                // user grabs actual card background/header, exactly like a
                // real desktop window.
                onMouseDown={(e) => handleNodeMouseDown(e, node)}
                className={`group absolute bg-panel border rounded-xl shadow-xl flex flex-col overflow-hidden cursor-move ${
                  selectedIds.has(node.id) ? "border-brand-500 ring-2 ring-brand-500" : "border-edge"
                }`}
                style={{ left: node.x, top: node.y, width: nodeWidth(node), height: cardHeight(node) }}
              >
                {isPendingTiktokBreakdown(node) ? (
                  <>
                    <div
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
                    <div
                      onMouseDown={(e) => e.stopPropagation()}
                      className="relative bg-black shrink-0 cursor-default"
                      style={{ height: TIKTOK_PREVIEW_VIDEO_H }}
                    >
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
                    <div onMouseDown={(e) => e.stopPropagation()} className="p-2 flex-1 flex flex-col justify-center gap-1.5 cursor-default">
                      {connectedProductForVideo ? (
                        // Product already wired directly into this fresh
                        // video — one combined action instead of the usual
                        // two-plus-the-product-card's-own-button set (see
                        // findConnectedPendingVideoNode's doc comment).
                        // Analyzes the video itself first (transcribe +
                        // Claude breakdown), then folds in the connected
                        // product's own selling points, and writes a brand
                        // new 6-stage script — same generate-product-script
                        // pipeline "Generate product script" already used,
                        // just surfaced as the one obvious action here
                        // instead of a buried second button.
                        <button
                          onClick={() =>
                            setLocationPromptFor({
                              kind: "productScript",
                              node,
                              source: { type: "connected", nodeId: connectedProductForVideo.id },
                            })
                          }
                          disabled={busy}
                          className="w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium"
                        >
                          🎬✨ Analyze Video + Write Product Script
                        </button>
                      ) : (
                        <>
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
                        </>
                      )}
                      {err && <p className="mt-0.5 text-[10px] text-red-400">{err}</p>}
                    </div>
                  </>
                ) : isPendingProductCard(node) ? (
                  <>
                    <div
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
                    <div onMouseDown={(e) => e.stopPropagation()} className="p-2 flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden cursor-default">
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

                {/* Script — full width, its own row. Used to share this row
                    with Shooting Guide in a cramped side column; that's now
                    its own full-width row right below (see
                    SHOOTING_GUIDE_BOX_H's doc comment above). */}
                <div className="px-3 py-2 border-b border-edge shrink-0 min-w-0" style={{ height: nodeScriptBoxH(node) }}>
                  <label className="text-[9px] uppercase tracking-wide text-zinc-500 mb-1 block">Script</label>
                  <textarea
                    value={node.instruction}
                    onChange={(e) => updateNodeText(node.id, { instruction: e.target.value })}
                    onMouseDown={(e) => e.stopPropagation()}
                    placeholder="What happens in this shot? Dialogue, action, camera direction..."
                    className="w-full bg-transparent text-xs text-zinc-800 leading-relaxed outline-none resize-none overflow-y-auto placeholder:text-zinc-400"
                    style={{ height: nodeScriptBoxH(node) - 22 }}
                  />
                </div>
                {/* Shooting Guide — full width now instead of a squeezed
                    side column, three fields laid out across the row so
                    each actually has room to type in. */}
                <div className="px-3 py-1.5 border-b border-edge shrink-0 min-w-0" style={{ height: SHOOTING_GUIDE_BOX_H }}>
                  <label className="text-[9px] uppercase tracking-wide text-zinc-500 leading-none mb-1 block">Shooting Guide</label>
                  <div className="flex gap-2 min-w-0">
                    {(["angle", "tone", "pace"] as const).map((field) => (
                      <div key={field} className="flex-1 min-w-0">
                        <span className="text-[8px] text-zinc-400 capitalize leading-none">{field}</span>
                        <input
                          value={node.shootingGuide?.[field] || ""}
                          onChange={(e) => updateNodeShootingGuide(node.id, { [field]: e.target.value })}
                          onMouseDown={(e) => e.stopPropagation()}
                          placeholder={field === "angle" ? "e.g. close-up" : field === "tone" ? "e.g. playful" : "e.g. fast cuts"}
                          className="w-full min-w-0 bg-transparent text-[10px] leading-tight text-zinc-700 outline-none placeholder:text-zinc-400 border-b border-edge focus:border-brand-500"
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
                    className="w-full bg-transparent text-xs text-zinc-500 leading-relaxed outline-none resize-none overflow-y-auto placeholder:text-zinc-400"
                    style={{ height: nodeNotesBoxH(node) - 22 }}
                  />
                </div>

                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  className="relative border-b border-edge shrink-0 bg-black cursor-default"
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
                  onClick={() => requestRender(n.id)}
                  disabled={rendering}
                  className="absolute px-3 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium shadow-xl"
                  style={{ left: n.x, top: generateButtonTop, width: nodeWidth(n) }}
                >
                  {renderButtonLabel()}
                </button>

                {/* Render result card — appears anchored under THIS tail's
                    Generate button once a render for THIS specific chain has
                    finished (or failed). Replaces the old fixed top banner,
                    which showed one global result with no link back to which
                    chain it belonged to on a board with multiple chains —
                    per the user's explicit request, the finished video now
                    lands as a card on the canvas next to the chain it came
                    from, with its own feedback box + Regenerate + Download. */}
                {renderChainTailId === n.id && (renderResult || renderError) && (
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    className="absolute rounded-lg border border-edge bg-panel2 shadow-2xl p-3 flex flex-col gap-2.5 text-xs"
                    style={{ left: n.x, top: generateButtonTop + GENERATE_BUTTON_H + RESULT_CARD_GAP, width: RESULT_CARD_WIDTH }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        {renderError && <p className="text-red-400">{renderError}</p>}
                        {renderResult && (
                          <>
                            <p className="text-green-600">
                              Render done{renderResult.styleApplied ? ` — applied ${renderResult.styleApplied.pacing} reference style` : ""}
                              {renderResult.appliedFeedback ? ` — ${renderResult.appliedFeedback.notes}` : ""}
                            </p>
                            {renderResult.skipped.length > 0 && (
                              <p className="text-zinc-500 mt-0.5">
                                Skipped (no clip attached): {renderResult.skipped.slice(0, RESULT_CARD_MAX_SKIPPED_SHOWN).join(", ")}
                                {renderResult.skipped.length > RESULT_CARD_MAX_SKIPPED_SHOWN
                                  ? ` and ${renderResult.skipped.length - RESULT_CARD_MAX_SKIPPED_SHOWN} more`
                                  : ""}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setRenderError(null);
                          setRenderResult(null);
                          setRenderChainTailId(null);
                        }}
                        className="text-zinc-500 hover:text-zinc-900 shrink-0"
                      >
                        ✕
                      </button>
                    </div>

                    {renderResult && (
                      <>
                        <video src={renderResult.url} controls className="w-full rounded border border-edge" style={{ maxHeight: 260 }} />

                        <div>
                          <label className="text-[10px] text-zinc-500 mb-1 block">Want something changed? Tell the AI what to adjust, then regenerate.</label>
                          <textarea
                            value={board.direction}
                            onChange={(e) => setBoard((b) => ({ ...b, direction: e.target.value }))}
                            placeholder="e.g. faster cuts, punchier captions, less text on screen, more product close-ups..."
                            rows={2}
                            className="w-full px-2.5 py-1.5 rounded-lg bg-panel border border-edge text-xs text-zinc-900 outline-none focus:border-brand-500 resize-none"
                          />
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            onClick={startStyleUpload}
                            className="h-8 px-2.5 rounded border border-dashed border-edge2 text-[10px] text-zinc-600 hover:text-zinc-900 hover:border-brand-500 shrink-0"
                          >
                            📎 {board.styleProfile ? `Ref: ${board.styleProfile.sourceLabel}` : "Import reference video"}
                          </button>
                          <button
                            onClick={() => requestRender(n.id)}
                            disabled={rendering}
                            className="h-8 px-3 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-[11px] font-medium shrink-0"
                          >
                            {rendering ? "Regenerating..." : "🔁 Regenerate"}
                          </button>
                          <a
                            href={renderResult.url}
                            download
                            className="h-8 px-3 rounded-lg bg-panel border border-edge hover:border-brand-500 text-zinc-900 text-[11px] font-medium shrink-0 flex items-center"
                          >
                            ⬇ Download
                          </a>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}

          {/* "Generate script" lives under any product card that's been
              wired into the graph (connected to at least one other card,
              either direction) — same anchored-below-the-card placement
              pattern as the chain-tail Generate button above. The server
              reads the connected chain's CURRENT script text and
              synthesizes a new shoppable script for this product (see the
              generate-shoppable-script route). EXCLUDES a product card
              wired directly to a still-raw/un-analyzed video card — that
              pairing already gets its own single merged
              "Analyze Video + Write Product Script" button on the video
              card itself (see connectedProductForVideo above and
              findConnectedPendingVideoNode's doc comment); showing this
              button there too would just be the second of two buttons
              doing overlapping things, which was the user's original
              complaint. */}
          {board.nodes
            .filter(
              (n) =>
                isPendingProductCard(n) &&
                board.connections.some((c) => c.fromId === n.id || c.toId === n.id) &&
                !findConnectedPendingVideoNode(n, board.nodes, board.connections)
            )
            .map((n) => (
              <button
                key={`shoppable-${n.id}`}
                onClick={() => setLocationPromptFor({ kind: "shoppableScript", node: n })}
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

      {/* Indoor/outdoor prompt — shown right before Breakdown / Breakdown
          chain / Generate product script actually runs, so the Shooting
          Guide can be tailored (see confirmLocation + deriveShootingGuide
          in shootingGuide.ts). Skip proceeds with the old
          location-agnostic guidance. */}
      {locationPromptFor &&
        (() => {
          // productScript asks both questions in one modal; shoppableScript
          // has no location concept (no shooting guide is generated for
          // it) so only the emotion half shows; breakdown/breakdownChain
          // are analysis-only actions with no new copy being written, so
          // neither has a "reaction" to pick — unchanged plain
          // indoor/outdoor/Skip flow for those two.
          const needsEmotion = locationPromptFor.kind === "productScript" || locationPromptFor.kind === "shoppableScript";
          const needsLocation = locationPromptFor.kind !== "shoppableScript";
          return (
            <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
              <div className="bg-panel rounded-xl border border-edge max-w-sm w-full p-5 max-h-[85vh] overflow-y-auto">
                {needsLocation && (
                  <>
                    <h3 className="text-zinc-900 font-semibold mb-1">Where will you be filming this?</h3>
                    <p className="text-sm text-zinc-500 mb-3">
                      So the Shooting Guide can suggest angles, lighting, and pacing that actually work for the space.
                    </p>
                    {needsEmotion ? (
                      <div className="flex gap-2 mb-4">
                        <button
                          onClick={() => setSelectedLocation("indoor")}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium ${
                            selectedLocation === "indoor"
                              ? "bg-brand-500 text-white"
                              : "bg-panel2 border border-edge text-zinc-700 hover:border-brand-500"
                          }`}
                        >
                          🏠 Indoor
                        </button>
                        <button
                          onClick={() => setSelectedLocation("outdoor")}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium ${
                            selectedLocation === "outdoor"
                              ? "bg-brand-500 text-white"
                              : "bg-panel2 border border-edge text-zinc-700 hover:border-brand-500"
                          }`}
                        >
                          🌳 Outdoor
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => confirmLocation("indoor")}
                          className="flex-1 py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
                        >
                          🏠 Indoor
                        </button>
                        <button
                          onClick={() => confirmLocation("outdoor")}
                          className="flex-1 py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
                        >
                          🌳 Outdoor
                        </button>
                      </div>
                    )}
                  </>
                )}
                {needsEmotion && (
                  <>
                    {/* Which emotion the script's opening "Reaction" beat
                        (a sharp 2-3s reactive beat, see scriptgen.ts)
                        should land — see REACTION_EMOTIONS in types.ts.
                        Sorted by this member's own past picks
                        (emotionUsage, from /api/reaction-emotions) so
                        whichever they reach for most floats to the top;
                        entirely optional, leaving none selected lets the
                        AI pick whatever fits the product best. */}
                    <h3 className="text-zinc-900 font-semibold mb-1">What reaction should the hook land?</h3>
                    <p className="text-sm text-zinc-500 mb-3">
                      Pick the emotion the opening beat should evoke in viewers — optional, leave blank to let the AI decide.
                    </p>
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {sortedEmotions.map((emotion) => (
                        <button
                          key={emotion}
                          onClick={() => setSelectedEmotion((cur) => (cur === emotion ? null : emotion))}
                          className={`px-2.5 py-1 rounded-full text-xs capitalize ${
                            selectedEmotion === emotion
                              ? "bg-brand-500 text-white"
                              : "bg-panel2 border border-edge text-zinc-600 hover:border-brand-500"
                          }`}
                        >
                          {emotion}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => confirmLocation(selectedLocation)}
                      className="w-full py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
                    >
                      ✨ Generate script
                    </button>
                  </>
                )}
                <button
                  onClick={() => (needsEmotion ? setLocationPromptFor(null) : confirmLocation(null))}
                  className="w-full mt-2 py-2 rounded-lg border border-edge text-zinc-500 hover:text-zinc-900 hover:border-edge2 text-sm"
                >
                  {needsEmotion ? "Cancel" : "Skip"}
                </button>
              </div>
            </div>
          );
        })()}

      {captionsPromptOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-panel border border-edge rounded-xl p-5 w-full max-w-sm shadow-2xl">
            <h3 className="text-zinc-900 font-semibold text-sm mb-1">Want captions on this video?</h3>
            <p className="text-xs text-zinc-500 mb-4">
              Captions are off by default. If you want them, they're auto-generated from what's actually said in each
              clip (speech-to-text) — not the script text, so they always match what's on screen.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => chooseCaptionsAndRender("auto")}
                className="w-full py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
              >
                🎙️ Yes — auto-generate from audio
              </button>
              <button
                onClick={() => chooseCaptionsAndRender("off")}
                className="w-full py-2.5 rounded-lg border border-edge text-zinc-700 hover:text-zinc-900 hover:border-edge2 text-sm font-medium"
              >
                No captions
              </button>
              <button
                onClick={() => setCaptionsPromptOpen(false)}
                className="w-full py-2 text-zinc-500 hover:text-zinc-900 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
