"use client";

// A simplified, in-website timeline editor — the "✂️ Manual Edit" button next
// to Regenerate on a render result card opens this. NOT a CapCut/Premiere
// replacement (there's no public way to embed either of those in a
// webpage) — this is an honestly-scoped alternative for a user who wants
// more precise, hands-on control than the AI render gives them. Laid out
// like a real desktop NLE (media bin on the left, preview + timeline in the
// center, an inspector on the right) because that's the layout people
// already know from CapCut/Premiere and it makes the tool easier to use,
// not just nicer to look at.
//
// Still not CapCut-level under the hood — no stickers, no effects library,
// no multi-track compositing — but the timeline itself (thumbnails,
// drag-to-trim/reorder, split, per-cut transitions, a text track, a
// scrubbable playhead, and one real AI feature — Whisper auto-caption on a
// clip's actual audio) is a genuine, if simplified, editor.
//
// Auto-imports the current chain's already-edited shots as the starting
// timeline (see StoryboardCanvas.tsx's openManualEdit), and the left media
// bin lists every other clip already uploaded elsewhere on the board via
// boardClips.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ManualEditSourceClip {
  nodeId: string;
  url: string;
  kind: "video" | "image";
  label: string;
  // The shot's script/voiceover text (StoryboardNode.instruction on the
  // canvas) — carried through so the Properties panel can show it as a
  // reference while cutting (see the "idle" state below), instead of
  // wasting that space on a "select a clip" placeholder.
  script?: string;
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
  script?: string; // see ManualEditSourceClip.script
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
  bold: boolean;
  color: string; // "#rrggbb", fed straight into the export payload and on to ffmpeg drawtext's fontcolor
}

interface BoundaryTransition {
  preset: TransitionPreset;
  sec: number;
}

// A clip dropped onto the B-roll row — sits on its OWN track, positioned by
// absolute time on the GLOBAL timeline (unlike TimelineItem, which is
// ordered/concatenated end-to-end), so it can freely overlap whichever base
// clip(s) happen to play underneath it during [startSec, startSec+duration).
// Rendered on top of the base video during that window (see
// storyboardRender.ts's manual render pipeline, which clamps each B-roll
// segment to the single base clip it starts within — a B-roll spanning a cut
// is truncated to the first clip's remaining time, a known v1 simplification
// rather than splitting it across the boundary).
// boxX/boxY/boxW/boxH position the B-roll WITHIN the 9:16 canvas as 0-1
// fractions (0,0,1,1 = full-frame, the original behavior) — dragging/
// resizing it in the preview (see the preview frame's overlay handles)
// shrinks it down into a picture-in-picture inset instead, CapCut-style.
// Top-left anchored: resizing only ever changes boxW/boxH, moving only ever
// changes boxX/boxY. `track` (0-2, see NUM_BROLL_TRACKS) is which of the 3
// stacked B-roll rows this sits on — higher track number composites ON TOP
// of lower ones (and lower ones on top of the base video), same convention
// as every other layer-based editor.
interface BRollItem {
  id: string;
  nodeId: string;
  url: string;
  kind: "video" | "image";
  label: string;
  startSec: number; // position on the whole sequence's global timeline
  duration: number; // how long it's shown for
  trimStart: number; // in-point within the SOURCE clip (video only)
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  track: number;
}

// Which corner of a B-roll's picture-in-picture box a resize handle grabs —
// see beginBrollBoxResizeDrag. Four round handles (one per corner) replaced
// the original single bottom-right square handle.
type BoxCorner = "nw" | "ne" | "sw" | "se";
const CORNER_HANDLE_POS: Record<BoxCorner, React.CSSProperties> = {
  nw: { top: 0, left: 0, transform: "translate(-50%,-50%)", cursor: "nwse-resize" },
  ne: { top: 0, right: 0, transform: "translate(50%,-50%)", cursor: "nesw-resize" },
  sw: { bottom: 0, left: 0, transform: "translate(-50%,50%)", cursor: "nesw-resize" },
  se: { bottom: 0, right: 0, transform: "translate(50%,50%)", cursor: "nwse-resize" },
};

// A single background-music slot — spans the whole render (looped/trimmed to
// match the final duration server-side) rather than being placed at a
// specific point, since that's how virtually every short-form editor treats
// background music. `volume` is a 0-1 multiplier mixed under the clips' own
// audio.
interface MusicTrack {
  url: string;
  label: string;
  volume: number;
}

const DEFAULT_IMAGE_DURATION = 4;
const DEFAULT_BROLL_DURATION = 2.5;
const DEFAULT_MUSIC_VOLUME = 0.4;
// Accepts pure audio files AND video files — dropping a video onto the
// Music row is meant to work too, automatically pulling just its audio
// track (see the render pipeline's mixing pass, which reads only the `a`
// stream regardless of whether the source file has video in it, so no
// separate "extract audio" step is actually needed here).
const MUSIC_MIME_OK = /^(audio\/(mpeg|mp3|wav|x-wav|mp4|x-m4a|m4a|aac)|video\/(mp4|quicktime|webm))$/;
const MIN_ZOOM = 15;
const MAX_ZOOM = 140;
const DEFAULT_ZOOM = 46; // pixels per second
const DEFAULT_TRANSITION: BoundaryTransition = { preset: "fade", sec: 0.25 };

// Timeline track layout (four stacked rows inside one scroll container) —
// B-roll sits ABOVE the base video row, both because that's roughly where
// CapCut puts an overlay/PIP track and because it visually reinforces "this
// plays ON TOP of the video below it". Music sits below the text row (see
// MUSIC_ROW_H below). These are the BASE (1x) sizes — the actual on-screen
// row heights are these multiplied by `rowScale` state, which the resize
// handle above the timeline drags between MIN/MAX_ROW_SCALE — see that
// handle's own comment for why (clips read as cramped/thin at the fixed
// size once there could be up to 4 stacked rows).
const BASE_BROLL_ROW_H = 30;
const BASE_VIDEO_ROW_H = 58;
const BASE_TEXT_ROW_H = 24;
const BASE_MUSIC_ROW_H = 26;
// 3 stacked B-roll tracks (CapCut-style) instead of a single overlay row —
// track 2 renders on top of track 1 renders on top of track 0 renders on
// top of the base video. Stacked with a small gap between them for visual
// separation; see brollTrackTop() inside the component for the per-track
// position math.
const NUM_BROLL_TRACKS = 3;
const BROLL_TRACK_GAP = 3;
const MIN_ROW_SCALE = 0.8;
const MAX_ROW_SCALE = 2.4;
const DEFAULT_ROW_SCALE = 1;

// ---- monochrome toolbar icons ----
// Plain inline SVGs (stroke/fill = currentColor, no hardcoded color of their
// own) replacing the toolbar's previous emoji glyphs (▶ ⏸ ✂️ 🗑️ 🎙️ 🪄 ⇄) —
// those render as full-color OS emoji pictograms regardless of the
// button's own text color, which is what made the toolbar look
// inconsistent with the rest of the app's black/white/cyan "tech" aesthetic
// (see Logo.tsx and the phase-74c icon pass elsewhere in this file). Every
// icon here instead inherits whatever color the surrounding button/IconBtn
// is already using (slate by default, cyan when active).
function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 2.3v11.4a.9.9 0 0 0 1.36.77l9.1-5.7a.9.9 0 0 0 0-1.54l-9.1-5.7A.9.9 0 0 0 4 2.3z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <rect x="3.3" y="2.3" width="3.4" height="11.4" rx="0.8" />
      <rect x="9.3" y="2.3" width="3.4" height="11.4" rx="0.8" />
    </svg>
  );
}
function ScissorsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="4" r="1.7" />
      <circle cx="4" cy="12" r="1.7" />
      <line x1="5.3" y1="5.1" x2="13.5" y2="12.5" />
      <line x1="5.3" y1="10.9" x2="13.5" y2="3.5" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4.5h11" />
      <path d="M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
      <path d="M4 4.5l.6 8.3a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.3" />
      <line x1="6.5" y1="7" x2="6.5" y2="11.5" />
      <line x1="9.5" y1="7" x2="9.5" y2="11.5" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="1.5" width="4" height="7.5" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
      <line x1="8" y1="12" x2="8" y2="14.3" />
      <line x1="5.5" y1="14.3" x2="10.5" y2="14.3" />
    </svg>
  );
}
function WandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2.5" y1="13.5" x2="9.5" y2="6.5" />
      <path d="M12.3 2l.55 1.3 1.3.55-1.3.55-.55 1.3-.55-1.3-1.3-.55 1.3-.55L12.3 2z" fill="currentColor" stroke="none" />
      <path d="M4.3 9.8l.35.85.85.35-.85.35-.35.85-.35-.85-.85-.35.85-.35.35-.85z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function SwapIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5.2h9.5" />
      <path d="M8.7 2.3l3 2.9-3 2.9" />
      <path d="M14 10.8H4.5" />
      <path d="M7.3 13.7l-3-2.9 3-2.9" />
    </svg>
  );
}
// ---- per-track (lock/hide/mute) icons — sit in the fixed header column to
// the left of each B-roll track row (see brollTrackTop). 12px, up from an
// original 7px the user reported as unreadably small. ----
function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="7" width="9" height="7" rx="1.2" />
      <path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}
function UnlockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="7" width="9" height="7" rx="1.2" />
      <path d="M5.5 7V4.5a2.5 2.5 0 0 1 4.7-1.2" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 2l12 12" />
      <path d="M6.6 4.1A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11.6 11.6 0 0 1-2.3 2.9M4.2 4.9A11.7 11.7 0 0 0 1.5 8s2.5 4.5 6.5 4.5c.9 0 1.7-.2 2.5-.5" />
    </svg>
  );
}
function VolumeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" stroke="none" />
      <path d="M10.5 5.5a4 4 0 0 1 0 5" />
    </svg>
  );
}
function MuteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" stroke="none" />
      <path d="M10.5 6l3 4M13.5 6l-3 4" />
    </svg>
  );
}
function UndoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8a5 5 0 1 1 1.5 3.6" />
      <path d="M4 4.5V8h3.5" />
    </svg>
  );
}

// Hoisted to MODULE scope (was previously declared inside ManualEditModal's
// render body) — that was the actual root cause of "Pause doesn't respond":
// a component function re-declared fresh on every render is a NEW type as
// far as React's reconciler is concerned, so every single re-render of the
// modal (which happens ~24x/sec while playing, via the rAF tick loop in
// togglePlay) forced React to unmount and remount every IconBtn-based
// button — including Play/Pause itself — instead of just updating props on
// the existing DOM node. A click landing mid-unmount/remount can be lost
// entirely, which reads exactly as "I pressed it and nothing happened."
// Throttling the tick loop's commits (COMMIT_INTERVAL_MS) made this less
// frequent but never fixed the underlying thrashing. A plain, stable,
// module-level function component never has this problem.
function IconBtn({ onClick, disabled, title, children, active }: { onClick?: () => void; disabled?: boolean; title: string; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-sm disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
      style={{
        color: active ? "#22d3ee" : "#cbd5e1",
        background: active ? "rgba(34,211,238,0.12)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "rgba(255,255,255,0.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "rgba(34,211,238,0.12)" : "transparent";
      }}
    >
      {children}
    </button>
  );
}

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
  const [broll, setBroll] = useState<BRollItem[]>([]);
  // Per B-roll TRACK (not per-clip) state — lock blocks new drops/drags on
  // that track, hide skips it in the live preview AND the export (client
  // just filters it out of the export payload, see handleExport), mute
  // silences that track's own <video> element in the preview only (B-roll
  // audio was never mixed into the export to begin with — see
  // storyboardRender.ts's manual pipeline, which only ever composites the
  // B-roll's video stream — so there's no "unmuted in the export" state to
  // preserve here; this toggle is purely a monitoring aid while editing).
  const [trackLocked, setTrackLocked] = useState<boolean[]>(() => Array(NUM_BROLL_TRACKS).fill(false));
  const [trackHidden, setTrackHidden] = useState<boolean[]>(() => Array(NUM_BROLL_TRACKS).fill(false));
  // Muted by DEFAULT (unlike lock/hidden) — matches what the export
  // actually produces (B-roll audio is never mixed in), so the preview's
  // default sound matches the final render. Unmuting is purely a
  // "let me hear what's on this track" monitoring toggle while editing.
  const [trackMuted, setTrackMuted] = useState<boolean[]>(() => Array(NUM_BROLL_TRACKS).fill(true));
  function toggleTrackLocked(t: number) {
    setTrackLocked((cur) => cur.map((v, i) => (i === t ? !v : v)));
  }
  function toggleTrackHidden(t: number) {
    setTrackHidden((cur) => cur.map((v, i) => (i === t ? !v : v)));
  }
  function toggleTrackMuted(t: number) {
    setTrackMuted((cur) => cur.map((v, i) => (i === t ? !v : v)));
  }
  const [transitions, setTransitions] = useState<BoundaryTransition[]>([]);
  const [thumbsByUrl, setThumbsByUrl] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [selectedBrollId, setSelectedBrollId] = useState<string | null>(null);
  // Which of the 3 B-roll tracks (if any) is currently being dragged over —
  // replaces a single boolean now that there are multiple drop targets
  // stacked on top of each other.
  const [brollDragOverTrack, setBrollDragOverTrack] = useState<number | null>(null);
  const [binDragOver, setBinDragOver] = useState(false);
  const [music, setMusic] = useState<MusicTrack | null>(null);
  const [musicSelected, setMusicSelected] = useState(false);
  const [musicDragOver, setMusicDragOver] = useState(false);
  // Locally-uploaded clips (dragged/dropped in from the user's own computer,
  // not already sitting on the board) — merged with `boardClips` into
  // `binClips` below wherever the Media panel's contents are rendered from.
  // Kept separate from the `boardClips` prop (owned by StoryboardCanvas.tsx)
  // since this modal doesn't have a way to push new nodes back onto the
  // board; the uploaded file just lives here for the rest of this editing
  // session (its underlying URL is real and permanent — /upload writes it
  // to disk under this project's media folder — only the "it's also a card
  // on the canvas" part doesn't happen).
  const [uploadedClips, setUploadedClips] = useState<ManualEditSourceClip[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [openTransitionAt, setOpenTransitionAt] = useState<number | null>(null);
  const [autoCaptioning, setAutoCaptioning] = useState(false);
  const [autoCaptionError, setAutoCaptionError] = useState<string | null>(null);
  // Row-height scale — dragged via the resize handle above the timeline (see
  // beginRowResizeDrag) so the user can pull the whole track area taller
  // when there's a lot stacked up (B-roll + video + text + music).
  const [rowScale, setRowScale] = useState(DEFAULT_ROW_SCALE);
  const rowResizeStart = useRef<{ y: number; scale: number } | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ url: string } | null>(null);
  const [exportProgress, setExportProgress] = useState<{ completedShots: number; totalShots: number; step: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Minimize-to-pill — hides the fullscreen overlay (display:none, NOT
  // unmount, so every state slice, the hidden <video> probes, and the
  // export poll timer all keep running) and shows a small floating pill
  // with live export progress instead. Lets the user kick off an export,
  // shrink the editor out of the way, and keep working on other videos on
  // the page behind it while ffmpeg grinds server-side.
  const [minimized, setMinimized] = useState(false);

  // ---- Undo history — snapshot-based (simplest correct approach given how
  // many independent state slices a single action can touch — e.g. split
  // touches both items AND overlays at once). pushHistory() is called at the
  // START of each mutating action (add/remove clip or B-roll, split, add/
  // remove overlay/music, and once at the START of each drag — never on
  // every mousemove — so a whole drag collapses into one undo step). Capped
  // so a long editing session can't grow this unbounded.
  const MAX_UNDO_STEPS = 50;
  const undoStack = useRef<
    { items: TimelineItem[]; overlays: TextOverlay[]; broll: BRollItem[]; transitions: BoundaryTransition[]; music: MusicTrack | null }[]
  >([]);
  const [canUndo, setCanUndo] = useState(false);
  function pushHistory() {
    undoStack.current.push({ items, overlays, broll, transitions, music });
    if (undoStack.current.length > MAX_UNDO_STEPS) undoStack.current.shift();
    setCanUndo(true);
  }
  const undo = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    setItems(snap.items);
    setOverlays(snap.overlays);
    setBroll(snap.broll);
    setTransitions(snap.transitions);
    setMusic(snap.music);
    setSelectedId(null);
    setSelectedOverlayId(null);
    setSelectedBrollId(null);
    setMusicSelected(false);
    setCanUndo(undoStack.current.length > 0);
  }, []);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      e.preventDefault();
      undo();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  // Delete/Backspace removes whatever's currently selected (a timeline
  // clip, a B-roll block, a text overlay, or the music track) — previously
  // the ONLY way to delete a selected B-roll clip was the trash icon in the
  // toolbar (which only handled `selected`/`selectedBrollId`, or a
  // per-block delete button buried in the Properties panel; there was no
  // keyboard shortcut at all, which read as "the Delete key doesn't work."
  // Resubscribes whenever the selection changes rather than mounting once,
  // so it always has the right id — cheap (just add/removeEventListener).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (selectedId) {
        e.preventDefault();
        removeItem(selectedId);
      } else if (selectedBrollId) {
        e.preventDefault();
        removeBroll(selectedBrollId);
      } else if (selectedOverlayId) {
        e.preventDefault();
        removeOverlay(selectedOverlayId);
      } else if (musicSelected) {
        e.preventDefault();
        removeMusic();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, selectedBrollId, selectedOverlayId, musicSelected]);

  const trackRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  // The 9:16 preview frame's own DOM node — measured (getBoundingClientRect)
  // by the B-roll box move/resize drags above to convert pixel deltas into
  // 0-1 canvas fractions.
  const previewFrameRef = useRef<HTMLDivElement>(null);
  // One <video> element per B-roll item CURRENTLY RENDERED in the preview
  // (only active-in-window and/or selected ones are ever mounted — see the
  // B-roll overlay JSX) — keyed by BRollItem.id so syncBrollPlayback can
  // find and drive each one's currentTime/play/pause independently of the
  // main preview video.
  const brollVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  // Mirrors `broll` state for syncBrollPlayback to read from inside the rAF
  // tick loop without closing over a stale array (the loop's own callback
  // is only created once per togglePlay() call, so a plain closure over
  // `broll` would freeze at whatever it was when Play was clicked).
  const brollRef = useRef<BRollItem[]>([]);
  const dragFromIndex = useRef<number | null>(null);
  // requestAnimationFrame id, not a setInterval id — the play-through tick
  // loop switched from a fixed 100ms setInterval (visibly choppy, ~10fps
  // playhead motion — reported as the play/pause experience feeling
  // sluggish/"不灵活") to a real per-frame rAF loop (~60fps) for a smooth
  // playhead. Still used as the plain truthiness check for "is something
  // actually playing right now" everywhere else in this file (see
  // togglePlay's own doc comment for why a ref beats the `playing` state).
  const playTickTimer = useRef<number | null>(null);
  const imageElapsedRef = useRef(0);
  // Same-page drag-and-drop (Media bin thumbnail -> B-roll row) primary data
  // channel — a plain JS ref rather than relying solely on
  // e.dataTransfer.getData/setData with a custom MIME type, which some
  // embedded webview contexts restrict or drop silently. Set on
  // dragstart, read on drop, cleared on dragend so a stale value can't
  // leak into an unrelated later drop.
  const draggedBinClipRef = useRef<ManualEditSourceClip | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => stopPoll, []);
  useEffect(() => stopPlayback, []);
  useEffect(() => {
    brollRef.current = broll;
  }, [broll]);

  // Keep exactly one transition entry per boundary (items.length - 1),
  // defaulting new boundaries to a plain fade — belongs to a BOUNDARY
  // POSITION, not a specific pair of clip identities, so reordering clips
  // reassigns transitions to whatever's now adjacent rather than trying to
  // follow the original pair around.
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

  // Actual on-screen row layout — BASE_*_H constants scaled by rowScale
  // (dragged via the resize handle at the top of the timeline section).
  // Recomputed every render (cheap arithmetic) rather than memoized so the
  // drag feels immediate.
  const brollTrackH = Math.round(BASE_BROLL_ROW_H * rowScale);
  const brollAreaH = brollTrackH * NUM_BROLL_TRACKS + BROLL_TRACK_GAP * (NUM_BROLL_TRACKS - 1);
  const videoRowH = Math.round(BASE_VIDEO_ROW_H * rowScale);
  const textRowH = Math.round(BASE_TEXT_ROW_H * rowScale);
  const musicRowH = Math.round(BASE_MUSIC_ROW_H * rowScale);
  const brollRowTop = 10; // top of the WHOLE 3-track B-roll area
  const videoRowTop = brollRowTop + brollAreaH + 8;
  const textRowTop = videoRowTop + videoRowH + 10;
  const musicRowTop = textRowTop + textRowH + 10;
  const trackHeight = musicRowTop + musicRowH + 10;
  // Per-track vertical position within the B-roll area — track NUM-1 (the
  // highest z-order / rendered on top) is drawn at the TOP of the stack
  // (nearest the top of the screen), track 0 at the bottom (nearest the
  // video row below it) — mirrors both a real NLE's panel layout AND the
  // actual compositing order.
  function brollTrackTop(track: number): number {
    const rowFromTop = NUM_BROLL_TRACKS - 1 - track;
    return brollRowTop + rowFromTop * (brollTrackH + BROLL_TRACK_GAP);
  }

  // Resize handle drag: mousedown on the thin bar above the timeline starts
  // tracking, mousemove converts vertical drag distance into a rowScale
  // delta (dragging UP/toward negative dy makes rows bigger, matching "拉
  // 窗口往上拉加大工作栏" — pulling the top edge upward enlarges the area
  // below it), mouseup cleans up. Mirrors the existing beginTrimDrag /
  // beginBrollMoveDrag window-listener pattern used elsewhere in this file.
  function beginRowResizeDrag(e: React.MouseEvent) {
    e.preventDefault();
    rowResizeStart.current = { y: e.clientY, scale: rowScale };
    // rAF-throttled rather than calling setRowScale straight from every
    // mousemove event — mousemove can fire much faster than the browser
    // can actually repaint (especially here, where every tick re-renders
    // the whole timeline's worth of blocks), and piling up a React state
    // update per raw event is what made the drag feel laggy/stuttery
    // ("拉起来不是很顺畅"). Collapsing to at most one update per animation
    // frame keeps it visually in sync with the cursor without the backlog.
    let rafId: number | null = null;
    let pendingScale: number | null = null;
    function applyPending() {
      rafId = null;
      if (pendingScale !== null) setRowScale(pendingScale);
    }
    function onMove(ev: MouseEvent) {
      if (!rowResizeStart.current) return;
      const dy = rowResizeStart.current.y - ev.clientY; // positive when dragging up
      const next = Math.max(MIN_ROW_SCALE, Math.min(MAX_ROW_SCALE, rowResizeStart.current.scale + dy / 160));
      pendingScale = next;
      if (rafId === null) rafId = requestAnimationFrame(applyPending);
    }
    function onUp() {
      rowResizeStart.current = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function updateItem(id: string, patch: Partial<TimelineItem>) {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function removeItem(id: string) {
    pushHistory();
    setItems((cur) => cur.filter((it) => it.id !== id));
    setOverlays((cur) => cur.filter((o) => o.itemId !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  function addFromBoard(clip: ManualEditSourceClip) {
    pushHistory();
    const existingWithSameUrl = items.find((it) => it.url === clip.url && it.duration > 0);
    const newItem: TimelineItem = {
      id: uid(),
      nodeId: clip.nodeId,
      url: clip.url,
      kind: clip.kind,
      label: clip.label,
      script: clip.script,
      duration: clip.kind === "image" ? DEFAULT_IMAGE_DURATION : existingWithSameUrl?.duration || 0,
      trimStart: 0,
      trimEnd:
        clip.kind === "image" ? DEFAULT_IMAGE_DURATION : existingWithSameUrl ? existingWithSameUrl.duration : 0,
    };
    setItems((cur) => [...cur, newItem]);
    setSelectedId(newItem.id);
    setMusicSelected(false);
  }

  // ---- B-roll overlay track ----
  function addBrollFromBoard(clip: ManualEditSourceClip, dropAtSec: number, track: number = 0) {
    if (trackLocked[track]) return; // locked tracks reject new drops
    pushHistory();
    const clamped = Math.max(0, Math.min(dropAtSec, Math.max(0, total - 0.2)));
    const dur = clip.kind === "image" ? DEFAULT_IMAGE_DURATION : DEFAULT_BROLL_DURATION;
    const newBroll: BRollItem = {
      id: uid(),
      nodeId: clip.nodeId,
      url: clip.url,
      kind: clip.kind,
      label: clip.label,
      startSec: clamped,
      duration: Math.min(dur, Math.max(0.3, total - clamped)),
      trimStart: 0,
      // Full-frame by default (matches the original cutaway-only behavior)
      // — drag the handles in the preview to shrink it into a
      // picture-in-picture inset instead.
      boxX: 0,
      boxY: 0,
      boxW: 1,
      boxH: 1,
      track,
    };
    setBroll((cur) => [...cur, newBroll]);
    setSelectedId(null);
    setSelectedOverlayId(null);
    setSelectedBrollId(newBroll.id);
    setMusicSelected(false);
  }
  function updateBroll(id: string, patch: Partial<BRollItem>) {
    setBroll((cur) => cur.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }
  function removeBroll(id: string) {
    pushHistory();
    setBroll((cur) => cur.filter((b) => b.id !== id));
    setSelectedBrollId((cur) => (cur === id ? null : cur));
  }

  // ---- Background music track — a single optional slot, looped/trimmed to
  // the final render length on export, mixed under the existing clip audio
  // at `volume` (0-1). ----
  async function uploadMusicFile(file: File) {
    if (!MUSIC_MIME_OK.test(file.type)) {
      setUploadError("Unsupported file for background music — use mp3/wav/m4a audio, or an mp4/mov/webm video (its audio track will be used automatically).");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const nodeId = `manual-music-${uid()}`;
      const form = new FormData();
      form.append("file", file);
      form.append("nodeId", nodeId);
      const res = await fetch(`${apiBase}/upload`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadError(data.error || `Failed to upload ${file.name}`);
        return;
      }
      pushHistory();
      setMusic({ url: data.url, label: file.name.replace(/\.[^.]+$/, "") || "Background music", volume: DEFAULT_MUSIC_VOLUME });
      setSelectedId(null);
      setSelectedOverlayId(null);
      setSelectedBrollId(null);
      setMusicSelected(true);
    } finally {
      setUploading(false);
    }
  }
  function updateMusic(patch: Partial<MusicTrack>) {
    setMusic((cur) => (cur ? { ...cur, ...patch } : cur));
  }
  function removeMusic() {
    pushHistory();
    setMusic(null);
    setMusicSelected(false);
  }

  // Media panel contents = whatever's already wired into this chain on the
  // board + anything the user has dragged/dropped in from their own
  // computer this session (see uploadFiles below).
  const binClips = useMemo(() => [...boardClips, ...uploadedClips], [boardClips, uploadedClips]);

  const UPLOAD_MIME_OK = /^(video\/(mp4|quicktime|webm)|image\/(jpeg|png|webp|gif))$/;

  // Uploads one or more files dropped in from OUTSIDE the app (onto the
  // Media panel, or directly onto the B-roll row) via the same /upload
  // route StoryboardCanvas uses for a card's own clip slot — its `nodeId`
  // field is really just a filename key (see that route's doc comment), so
  // any unique string works fine even though these files were never
  // attached to a real board node. Adds each successfully-uploaded file to
  // `uploadedClips` (so it shows up in the Media panel from then on) and
  // returns the resulting clips so a B-roll-row drop can also place them
  // straight onto the timeline in the same action.
  async function uploadFiles(files: FileList | File[]): Promise<ManualEditSourceClip[]> {
    const list = Array.from(files).filter((f) => UPLOAD_MIME_OK.test(f.type));
    if (list.length === 0) {
      setUploadError("Unsupported file type — use mp4/mov/webm for clips or jpg/png/webp/gif for photos.");
      return [];
    }
    setUploading(true);
    setUploadError(null);
    const added: ManualEditSourceClip[] = [];
    try {
      for (const file of list) {
        const nodeId = `manual-upload-${uid()}`;
        const form = new FormData();
        form.append("file", file);
        form.append("nodeId", nodeId);
        const res = await fetch(`${apiBase}/upload`, { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setUploadError(data.error || `Failed to upload ${file.name}`);
          continue;
        }
        added.push({
          nodeId,
          url: data.url,
          kind: data.kind,
          label: file.name.replace(/\.[^.]+$/, "") || "Uploaded clip",
        });
      }
      if (added.length) setUploadedClips((cur) => [...cur, ...added]);
      return added;
    } finally {
      setUploading(false);
    }
  }

  // ---- thumbnail capture (client-side, no backend probe needed) ----
  function captureThumb(video: HTMLVideoElement, url: string) {
    try {
      const w = 120;
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
      pushHistory();
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
      pushHistory();
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

  // ---- B-roll (drag the whole block to reposition, or its right edge to
  // resize how long it's shown) — mouse-based like beginTrimDrag above,
  // rather than the video row's native HTML5 drag/drop, since a B-roll
  // block moves freely by TIME rather than swapping places in a list.
  function beginBrollMoveDrag(b: BRollItem) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      pushHistory();
      setSelectedId(null);
      setSelectedOverlayId(null);
      setSelectedBrollId(b.id);
      setMusicSelected(false);
      const startX = e.clientX;
      const startSec0 = b.startSec;
      function onMove(ev: MouseEvent) {
        const deltaSec = (ev.clientX - startX) / zoom;
        const next = Math.max(0, Math.min(Math.max(0, total - b.duration), startSec0 + deltaSec));
        updateBroll(b.id, { startSec: next });
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  // ---- B-roll PICTURE-IN-PICTURE positioning — separate from the two
  // helpers above, which drag the block along the TIMELINE (when it plays).
  // These instead drag it WITHIN THE PREVIEW FRAME (where on screen it
  // shows), converting pixel deltas to 0-1 canvas fractions via the preview
  // frame's own measured size. Move drags the whole box (changes boxX/boxY
  // only); resize is now available from ALL FOUR corners (previously just
  // bottom-right) — each one keeps the OPPOSITE corner anchored in place
  // while it drags, same as every other editor's corner-resize convention.
  const MIN_BOX_FRAC = 0.12;
  function beginBrollBoxMoveDrag(b: BRollItem) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const frame = previewFrameRef.current;
      if (!frame) return;
      pushHistory();
      const rect = frame.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startBoxX = b.boxX;
      const startBoxY = b.boxY;
      function onMove(ev: MouseEvent) {
        const dxFrac = (ev.clientX - startX) / rect.width;
        const dyFrac = (ev.clientY - startY) / rect.height;
        const nextX = Math.max(0, Math.min(1 - b.boxW, startBoxX + dxFrac));
        const nextY = Math.max(0, Math.min(1 - b.boxH, startBoxY + dyFrac));
        updateBroll(b.id, { boxX: nextX, boxY: nextY });
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }
  function beginBrollBoxResizeDrag(b: BRollItem, corner: BoxCorner) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const frame = previewFrameRef.current;
      if (!frame) return;
      pushHistory();
      const rect = frame.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startBoxX = b.boxX;
      const startBoxY = b.boxY;
      const startW = b.boxW;
      const startH = b.boxH;
      // The corner OPPOSITE the one being dragged stays fixed — e.g.
      // dragging "se" (bottom-right) keeps the top-left corner anchored
      // (the original, only-supported behavior); dragging "nw" now keeps
      // the bottom-right corner anchored instead, and so on.
      const anchorRight = startBoxX + startW;
      const anchorBottom = startBoxY + startH;
      function onMove(ev: MouseEvent) {
        const dxFrac = (ev.clientX - startX) / rect.width;
        const dyFrac = (ev.clientY - startY) / rect.height;
        let nextX = startBoxX;
        let nextY = startBoxY;
        let nextW = startW;
        let nextH = startH;
        if (corner === "se" || corner === "ne") {
          nextW = Math.max(MIN_BOX_FRAC, Math.min(1 - startBoxX, startW + dxFrac));
        } else {
          const rawX = Math.min(anchorRight - MIN_BOX_FRAC, Math.max(0, startBoxX + dxFrac));
          nextX = rawX;
          nextW = anchorRight - rawX;
        }
        if (corner === "se" || corner === "sw") {
          nextH = Math.max(MIN_BOX_FRAC, Math.min(1 - startBoxY, startH + dyFrac));
        } else {
          const rawY = Math.min(anchorBottom - MIN_BOX_FRAC, Math.max(0, startBoxY + dyFrac));
          nextY = rawY;
          nextH = anchorBottom - rawY;
        }
        updateBroll(b.id, { boxX: nextX, boxY: nextY, boxW: nextW, boxH: nextH });
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }
  function beginBrollResizeDrag(b: BRollItem) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      pushHistory();
      const startX = e.clientX;
      const startDur = b.duration;
      function onMove(ev: MouseEvent) {
        const deltaSec = (ev.clientX - startX) / zoom;
        const maxDur = Math.max(0.3, total - b.startSec);
        const next = Math.max(0.3, Math.min(maxDur, startDur + deltaSec));
        updateBroll(b.id, { duration: next });
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
    if (playTickTimer.current !== null) {
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
    pushHistory();
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
    pushHistory();
    const newOverlay: TextOverlay = { id: uid(), itemId, text: "", startSec: 0, endSec: Math.max(0.5, Math.min(3, clipTrimmedDur)), position: "bottom", size: "medium", bold: false, color: "#ffffff" };
    setOverlays((cur) => [...cur, newOverlay]);
    setSelectedOverlayId(newOverlay.id);
  }
  function updateOverlay(id: string, patch: Partial<TextOverlay>) {
    setOverlays((cur) => cur.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }
  function removeOverlay(id: string) {
    pushHistory();
    setOverlays((cur) => cur.filter((o) => o.id !== id));
    setSelectedOverlayId((cur) => (cur === id ? null : cur));
  }

  // ---- AI auto-caption (real speech-to-text on this clip's actual audio) ----
  // Shared transcribe call, factored out of autoCaption below so
  // autoCaptionAll (the whole-timeline "AI Generate Subtitle" button) can
  // reuse it per-clip without duplicating the fetch/mapping logic.
  async function transcribeClip(item: TimelineItem): Promise<TextOverlay[]> {
    if (item.kind !== "video") return [];
    const res = await fetch(`${apiBase}/manual-transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, trimStart: item.trimStart, trimEnd: item.trimEnd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Auto-caption failed");
    const segs: { start: number; end: number; text: string }[] = Array.isArray(data.segments) ? data.segments : [];
    return segs.map((s) => ({ id: uid(), itemId: item.id, text: s.text, startSec: s.start, endSec: s.end, position: "bottom" as const, size: "medium" as const, bold: false, color: "#ffffff" }));
  }

  async function autoCaption(item: TimelineItem) {
    if (item.kind !== "video") return;
    setAutoCaptioning(true);
    setAutoCaptionError(null);
    try {
      const newOverlays = await transcribeClip(item);
      if (newOverlays.length === 0) {
        setAutoCaptionError("No clear speech detected in this clip's trimmed range.");
        return;
      }
      // Replaces any overlays already on this clip rather than piling
      // AI-generated ones on top of hand-written ones.
      setOverlays((cur) => [...cur.filter((o) => o.itemId !== item.id), ...newOverlays]);
    } catch (err: any) {
      setAutoCaptionError(err.message || "Auto-caption failed");
    } finally {
      setAutoCaptioning(false);
    }
  }

  // "AI Generate Subtitle" toolbar button — captions EVERY video clip on the
  // timeline in one action, instead of requiring the user to select each
  // clip and hit the per-clip mic button one at a time. Runs sequentially
  // (not Promise.all) so autoCaptionError can report which specific clip(s)
  // failed rather than one race-y combined error, and so the transcription
  // server isn't hit with N simultaneous requests.
  async function autoCaptionAll() {
    const videoItems = items.filter((it) => it.kind === "video");
    if (videoItems.length === 0) {
      setAutoCaptionError("Add a video clip to the timeline first.");
      return;
    }
    setAutoCaptioning(true);
    setAutoCaptionError(null);
    const failed: string[] = [];
    try {
      for (const item of videoItems) {
        try {
          const newOverlays = await transcribeClip(item);
          if (newOverlays.length > 0) {
            setOverlays((cur) => [...cur.filter((o) => o.itemId !== item.id), ...newOverlays]);
          }
        } catch {
          failed.push(item.label || "a clip");
        }
      }
      if (failed.length) setAutoCaptionError(`Couldn't auto-caption: ${failed.join(", ")}.`);
    } finally {
      setAutoCaptioning(false);
    }
  }

  // ---- combined play-through preview ----
  // Drives every active B-roll <video> in the preview to match `nowSec`:
  // paused+seeked to the right frame while scrubbing, playing from the
  // right offset once it enters its [startSec, startSec+duration) window
  // during real playback, paused the moment it leaves that window. Reads
  // brollRef (not `broll` directly) so it stays correct when called from
  // inside the rAF tick loop's long-lived closure — see brollRef's own doc
  // comment. Image B-roll needs no playback syncing (just visibility, which
  // the JSX below already keys off the same active-window check).
  function syncBrollPlayback(nowSec: number) {
    const isPlaying = playTickTimer.current !== null;
    brollRef.current.forEach((b) => {
      if (b.kind !== "video") return;
      const el = brollVideoRefs.current.get(b.id);
      if (!el) return;
      const isActive = nowSec >= b.startSec - 0.02 && nowSec < b.startSec + b.duration + 0.02;
      if (!isActive) {
        if (!el.paused) el.pause();
        return;
      }
      const withinSec = b.trimStart + Math.max(0, nowSec - b.startSec);
      if (isPlaying) {
        if (el.paused) {
          el.currentTime = withinSec;
          el.play().catch(() => {});
        }
      } else {
        el.pause();
        el.currentTime = withinSec;
      }
    });
  }

  function stopPlayback() {
    if (playTickTimer.current !== null) {
      cancelAnimationFrame(playTickTimer.current);
      playTickTimer.current = null;
    }
    previewVideoRef.current?.pause();
    brollVideoRefs.current.forEach((el) => el.pause());
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
    syncBrollPlayback(clamped);
  }

  function togglePlay() {
    // Checks the ACTUAL running rAF loop (a ref, always current) rather
    // than the `playing` React state — state updates inside the tick loop
    // below are batched together with a nested setPlayheadSec call, and
    // under rapid clicks that could leave `playing` reporting stale by one
    // render. Clicking Pause must always stop whatever is really running,
    // so it keys off the ref instead.
    if (playTickTimer.current !== null) {
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
    syncBrollPlayback(startAt);
    const it = items[loc.index];
    if (it.kind === "video") previewVideoRef.current?.play().catch(() => {});
    setPlaying(true);

    // requestAnimationFrame loop instead of a fixed setInterval — a plain
    // setInterval(..., 100) only advances the visible playhead ~10 times a
    // second, which read as choppy. rAF itself is cheap (just scheduling),
    // but committing a React state update EVERY real display frame
    // (~60fps) turned out to be a real regression, not an improvement: with
    // a timeline full of blocks/B-roll overlays to re-lay-out on every
    // single re-render, 60 full-modal re-renders a second kept the main
    // thread busy enough that clicking Pause could take a very long time to
    // even be processed — reported as the button "按了没反应" (pressed, no
    // response), which is really "the click IS queued, but nothing gets a
    // chance to run it for a while." COMMIT_INTERVAL_MS throttles how often
    // setItems/setPlayheadSec actually fire (~24fps — still much smoother
    // than the old 100ms interval, but a fraction of the render load of
    // doing it on every rAF frame), while accDt keeps image-clip pacing
    // accurate across the frames that get skipped.
    const COMMIT_INTERVAL_MS = 42;
    let lastFrameTime = performance.now();
    let lastCommitTime = lastFrameTime;
    let accDt = 0;
    function tick(now: number) {
      accDt += Math.min(0.25, Math.max(0, (now - lastFrameTime) / 1000));
      lastFrameTime = now;
      if (now - lastCommitTime >= COMMIT_INTERVAL_MS) {
        lastCommitTime = now;
        const committedDt = accDt;
        accDt = 0;
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
              imageElapsedRef.current += committedDt;
              withinItem = imageElapsedRef.current;
            }
            const finishedItem = withinItem >= itemDur(curItem) - 0.05;
            if (!finishedItem) {
              const nextHead = offsetOfItem(curItems, curLoc.index) + withinItem;
              syncBrollPlayback(nextHead);
              return nextHead;
            }
            const nextIndex = curLoc.index + 1;
            if (nextIndex >= curItems.length) {
              stopPlayback();
              setPlaying(false);
              const nextHead = totalDur(curItems);
              syncBrollPlayback(nextHead);
              return nextHead;
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
            const nextHead = offsetOfItem(curItems, nextIndex);
            syncBrollPlayback(nextHead);
            return nextHead;
          });
          return curItems;
        });
      }
      if (playTickTimer.current !== null) {
        playTickTimer.current = requestAnimationFrame(tick);
      }
    }
    playTickTimer.current = requestAnimationFrame(tick);
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
      if (job.result) {
        const url = `${job.result.url}?t=${Date.now()}`;
        setExportResult({ url });
        // Auto-save into "Your Works" (src/app/favorites 3rd tab) — same
        // fire-and-forget treatment as the AI-render path in
        // StoryboardCanvas.tsx's applyRenderJob. Title falls back to the
        // first clip's label since this modal has no product/chain title
        // context of its own.
        fetch("/api/works", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, title: items[0]?.label || "Manual edit", source: "manual-edit" }),
        }).catch(() => {});
      } else {
        setExportResult(null);
      }
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
            : { clipIndex, text: o.text, startSec: o.startSec, endSec: o.endSec, position: o.position, size: o.size, bold: o.bold, color: o.color };
        })
        .filter((o): o is NonNullable<typeof o> => o !== null);
      // Hidden tracks are dropped entirely here (never even sent to the
      // server) rather than threaded through as a "skip me" flag — hiding
      // is meant to act exactly like the track didn't exist for this
      // export. The rest are sorted by track ASCENDING so the server's
      // sequential overlay chain (buildBrollFilterComplex, which layers
      // each array entry on top of the previous one) ends up compositing
      // higher-numbered tracks on top — same z-order the live preview
      // above already uses.
      const brollPayload = broll
        .filter((b) => !trackHidden[b.track])
        .sort((a, b) => a.track - b.track)
        .map((b) => ({
          url: b.url,
          kind: b.kind,
          startSec: b.startSec,
          duration: b.duration,
          trimStart: b.trimStart,
          label: b.label,
          boxX: b.boxX,
          boxY: b.boxY,
          boxW: b.boxW,
          boxH: b.boxH,
        }));

      const res = await fetch(`${apiBase}/manual-render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clips,
          textOverlays,
          transitions,
          broll: brollPayload,
          music: music ? { url: music.url, volume: music.volume } : null,
        }),
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
  // Every video url currently in the timeline OR sitting in the media bin —
  // the media bin needs thumbnails too, before a clip is ever dropped onto
  // the timeline.
  const uniqueUrls = useMemo(() => {
    const s = new Set<string>();
    items.forEach((it) => it.kind === "video" && s.add(it.url));
    binClips.forEach((c) => c.kind === "video" && s.add(c.url));
    return Array.from(s);
  }, [items, binClips]);

  return (
    <>
    <div className={`fixed inset-0 bg-black/80 backdrop-blur-sm z-50 p-3 md:p-6 items-center justify-center ${minimized ? "hidden" : "flex"}`}>
      <div
        className="w-full h-full rounded-2xl flex flex-col overflow-hidden border border-white/10"
        style={{
          background: "linear-gradient(160deg, #0c1120 0%, #090c16 55%, #0a0e1a 100%)",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.03), 0 30px 80px -20px rgba(0,0,0,0.7), 0 0 60px -20px rgba(56,189,248,0.2)",
        }}
      >
        {/* ---- top bar ---- */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 shrink-0 bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <span
              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)", boxShadow: "0 0 16px -2px rgba(99,102,241,0.7)" }}
            >
              {/* Geometric line-art scissors — two pivot rings + crossing
                  blade strokes — reads as "cut/edit" without leaning on an
                  emoji glyph, matching the thin-line, technical look used
                  elsewhere in this modal (the ⇄ transition chips, hairline
                  borders, tabular-nums timecodes). */}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="6" cy="6" r="2.4" stroke="white" strokeWidth="1.7" />
                <circle cx="6" cy="18" r="2.4" stroke="white" strokeWidth="1.7" />
                <path d="M8 7.5L20 17" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
                <path d="M8 16.5L20 7" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
            <div>
              <h3 className="text-slate-100 font-semibold text-sm tracking-wide leading-tight">Manual Edit</h3>
              <p className="text-[10.5px] text-slate-500 leading-tight">Trim, reorder, split, transitions, text &amp; captions — then export.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {exportResult && (
              <a
                href={exportResult.url}
                download
                className="px-3 py-1.5 rounded-lg text-white text-xs font-medium transition-transform hover:scale-105"
                style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)" }}
              >
                ⬇ Download
              </a>
            )}
            <button
              onClick={handleExport}
              disabled={exporting || items.length === 0}
              className="px-4 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-40 transition-transform hover:enabled:scale-105"
              style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)", boxShadow: "0 4px 16px -4px rgba(99,102,241,0.6)" }}
            >
              {exporting ? (exportProgress && exportProgress.totalShots > 0 ? `Exporting ${exportProgress.completedShots}/${exportProgress.totalShots}...` : "Starting...") : "Export"}
            </button>
            {/* Minimize — collapse to a floating progress pill so the user
                can keep using the page (e.g. start editing another video)
                while an export runs. Playback is stopped first so a hidden
                <video> doesn't keep narrating from off-screen. */}
            <button
              onClick={() => {
                stopPlayback();
                setPlaying(false);
                setMinimized(true);
              }}
              title="Minimize — keep exporting in the background"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 12.5h10" />
              </svg>
            </button>
            <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-200 hover:bg-white/5 text-base leading-none transition-colors">
              ✕
            </button>
          </div>
        </div>
        {exportError && <p className="px-4 py-1.5 text-xs text-rose-400 border-b border-white/10 bg-rose-500/5 shrink-0">{exportError}</p>}

        {/* Hidden probes — one per unique video url in the media bin or
            timeline: reads real duration client-side AND grabs a
            representative frame for thumbnails. */}
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

        {/* ---- 3-column body: media bin | preview+timeline | inspector ---- */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Media bin */}
          <div className="w-52 shrink-0 border-r border-white/10 flex flex-col min-h-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={musicInputRef}
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/mp4,audio/x-m4a,audio/aac,video/mp4,video/quicktime,video/webm"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length) uploadMusicFile(e.target.files[0]);
                e.target.value = "";
              }}
            />
            <div className="px-3 py-2.5 flex items-center justify-between shrink-0 border-b border-white/5">
              <span className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">📁 Media</span>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Upload a photo or video from your computer"
                className="text-[10px] px-2 py-0.5 rounded-full text-cyan-300 hover:text-cyan-200 disabled:opacity-40 transition-colors"
                style={{ background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)" }}
              >
                {uploading ? "Uploading…" : "+ Upload"}
              </button>
            </div>
            {uploadError && (
              <p className="px-3 py-1 text-[10px] text-rose-400 border-b border-white/5">{uploadError}</p>
            )}
            <div
              onDragOver={(e) => {
                // Only react to a real OS file drag (dragging one of this
                // panel's own thumbnails around doesn't carry a "Files"
                // type) — otherwise this would swallow the drag before it
                // ever reaches a card's own onDragStart/onDrop handlers.
                if (e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setBinDragOver(true);
                }
              }}
              onDragLeave={() => setBinDragOver(false)}
              onDrop={(e) => {
                if (e.dataTransfer.files && e.dataTransfer.files.length) {
                  e.preventDefault();
                  setBinDragOver(false);
                  uploadFiles(e.dataTransfer.files);
                }
              }}
              className="flex-1 overflow-y-auto p-2 grid grid-cols-2 gap-2 content-start transition-colors"
              style={{ background: binDragOver ? "rgba(34,211,238,0.06)" : undefined, outline: binDragOver ? "1px dashed rgba(34,211,238,0.5)" : undefined, outlineOffset: -4 }}
            >
              {binClips.length === 0 ? (
                <p className="col-span-2 text-[11px] text-slate-600 p-2">No clips yet — drag a photo/video in, or use + Upload above.</p>
              ) : (
                binClips.map((c) => {
                  const thumb = c.kind === "video" ? thumbsByUrl[c.url] : c.url;
                  const inTimeline = items.some((it) => it.url === c.url);
                  return (
                    <button
                      key={c.nodeId}
                      onClick={() => addFromBoard(c)}
                      draggable
                      onDragStart={(e) => {
                        // Drag target for the B-roll row below — clicking
                        // still adds to the main timeline as before; dragging
                        // onto the B-roll row instead drops it as an overlay
                        // at that time position (see the row's onDrop). The
                        // ref is the actual data channel (see its own doc
                        // comment); dataTransfer is set too for standards
                        // compliance but isn't relied on.
                        draggedBinClipRef.current = c;
                        e.dataTransfer.setData("application/x-broll-clip", JSON.stringify(c));
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDragEnd={() => {
                        draggedBinClipRef.current = null;
                      }}
                      title={`Add "${c.label}" to the timeline, or drag onto the B-roll row to overlay it`}
                      className="group relative rounded-lg overflow-hidden aspect-[3/4] text-left cursor-grab active:cursor-grabbing"
                      style={{ border: "1px solid rgba(255,255,255,0.08)" }}
                    >
                      <div
                        className="absolute inset-0 bg-cover bg-center"
                        style={{
                          background: c.kind === "video" ? "linear-gradient(135deg, rgba(99,102,241,0.55), rgba(79,70,229,0.5))" : "linear-gradient(135deg, rgba(20,184,166,0.55), rgba(8,145,178,0.5))",
                          backgroundImage: thumb ? `url(${thumb})` : undefined,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }}
                      />
                      <div className="absolute inset-0 flex flex-col justify-end p-1.5" style={{ background: "linear-gradient(to top, rgba(2,6,23,.85), rgba(2,6,23,.05) 60%)" }}>
                        <span className="text-[9.5px] text-white/90 truncate leading-tight">{c.label}</span>
                      </div>
                      <div
                        className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: "rgba(2,6,23,0.45)" }}
                      >
                        <span className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs" style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)" }}>
                          +
                        </span>
                      </div>
                      {inTimeline && <span className="absolute top-1 right-1 text-[9px] px-1 rounded bg-cyan-400/90 text-slate-950 font-semibold">✓</span>}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Center: preview + timeline */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex-1 min-h-0 flex items-center justify-center p-4">
              <div
                ref={previewFrameRef}
                className="h-full max-h-full rounded-xl flex items-center justify-center relative overflow-hidden"
                style={{ aspectRatio: "9/16", background: "#000", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "inset 0 0 40px rgba(0,0,0,0.6)" }}
              >
                <video ref={previewVideoRef} className="max-h-full max-w-full relative z-10" />
                {items.length === 0 && <span className="absolute text-slate-600 text-xs tracking-wide">NO SIGNAL</span>}

                {/* B-roll picture-in-picture overlay(s) — rendering it HERE
                    (not just as a block in the timeline) is what makes
                    B-roll actually show up in the preview at all, and at
                    the same box position/size the export will composite it
                    at (see storyboardRender.ts's buildBrollFilterComplex).
                    Real video/image content only renders while the
                    playhead is inside [startSec, startSec+duration);
                    whichever B-roll is currently SELECTED also gets a
                    move/resize affordance (drag the body to reposition,
                    the corner handle to resize) even when the playhead
                    isn't sitting inside its window right now, so it can be
                    framed up without needing to scrub to that exact
                    moment first. */}
                {/* Iterated in TRACK-ASCENDING order (not array-insertion
                    order) so a higher-numbered track's DOM node comes later
                    and therefore paints on top when two boxes happen to
                    overlap in space — same z-order convention as
                    storyboardRender.ts's export compositing (which also
                    layers strictly by track number). Hidden tracks are
                    skipped entirely here, matching what the export will
                    actually produce. */}
                {[...broll]
                  .sort((a, b2) => a.track - b2.track)
                  .map((b) => {
                    if (trackHidden[b.track]) return null;
                    const isActive = playheadSec >= b.startSec - 0.02 && playheadSec < b.startSec + b.duration + 0.02;
                    const isSelected = b.id === selectedBrollId;
                    if (!isActive && !isSelected) return null;
                    return (
                      <div
                        key={b.id}
                        onMouseDown={isSelected ? beginBrollBoxMoveDrag(b) : undefined}
                        className="absolute z-20 overflow-hidden rounded-[2px]"
                        style={{
                          left: `${b.boxX * 100}%`,
                          top: `${b.boxY * 100}%`,
                          width: `${b.boxW * 100}%`,
                          height: `${b.boxH * 100}%`,
                          cursor: isSelected ? "move" : "default",
                          boxShadow: isSelected
                            ? "0 0 0 2px #a78bfa, 0 0 16px -4px rgba(167,139,250,0.9)"
                            : "0 0 0 1px rgba(255,255,255,0.25)",
                          background: isActive ? undefined : "rgba(2,6,23,0.65)",
                        }}
                      >
                        {isActive && b.kind === "video" && (
                          <video
                            ref={(el) => {
                              if (el) brollVideoRefs.current.set(b.id, el);
                              else brollVideoRefs.current.delete(b.id);
                            }}
                            src={b.url}
                            muted={trackMuted[b.track]}
                            playsInline
                            className="w-full h-full object-cover"
                          />
                        )}
                        {isActive && b.kind === "image" && (
                          <img src={b.url} className="w-full h-full object-cover" alt={b.label} />
                        )}
                        {isSelected &&
                          (Object.keys(CORNER_HANDLE_POS) as BoxCorner[]).map((corner) => (
                            <div
                              key={corner}
                              onMouseDown={beginBrollBoxResizeDrag(b, corner)}
                              className="absolute w-3 h-3 rounded-full"
                              style={{
                                ...CORNER_HANDLE_POS[corner],
                                background: "#a78bfa",
                                border: "1.5px solid white",
                                boxShadow: "0 0 6px rgba(167,139,250,0.9)",
                              }}
                            />
                          ))}
                      </div>
                    );
                  })}

                {/* Text overlays — rendered LAST (highest in DOM order, and
                    z-30 vs B-roll's z-20) so captions always sit on top of
                    everything else, matching what the export actually
                    burns in. Previously these were only ever drawn into the
                    exported MP4 (see storyboardRender.ts's drawtext pass)
                    and never shown in the live preview at all, which is why
                    they appeared to not exist while editing. Position/size/
                    bold/color mirror the export's own conventions (top/
                    center/bottom anchoring, small/medium/large sizing) —
                    exact pixel parity with the server's fontsize isn't
                    attempted here, just the same relative proportions. */}
                {overlays.map((o) => {
                  const itemIndex = items.findIndex((it) => it.id === o.itemId);
                  if (itemIndex === -1 || !o.text.trim()) return null;
                  const base = offsetOfItem(items, itemIndex);
                  const absStart = base + o.startSec;
                  const absEnd = base + o.endSec;
                  if (playheadSec < absStart - 0.02 || playheadSec >= absEnd + 0.02) return null;
                  return (
                    <div
                      key={o.id}
                      className="absolute left-1/2 -translate-x-1/2 z-30 px-2.5 py-1 rounded text-center pointer-events-none"
                      style={{
                        top: o.position === "top" ? "6%" : o.position === "center" ? "50%" : undefined,
                        bottom: o.position === "bottom" ? "8%" : undefined,
                        transform: o.position === "center" ? "translate(-50%,-50%)" : "translateX(-50%)",
                        maxWidth: "88%",
                        background: "rgba(0,0,0,0.55)",
                        color: o.color || "#ffffff",
                        fontWeight: o.bold ? 700 : 500,
                        fontSize: o.size === "small" ? "clamp(10px, 3.1vw, 26px)" : o.size === "large" ? "clamp(15px, 5.4vw, 46px)" : "clamp(12px, 4vw, 34px)",
                        lineHeight: 1.25,
                        wordBreak: "break-word",
                      }}
                    >
                      {o.text}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* toolbar row */}
            <div className="px-4 flex items-center gap-1 shrink-0 border-t border-white/10 py-1.5" style={{ background: "rgba(255,255,255,0.015)" }}>
              <IconBtn onClick={togglePlay} disabled={items.length === 0} title={playing ? "Pause" : "Play"}>
                {playing ? <PauseIcon /> : <PlayIcon />}
              </IconBtn>
              <span className="text-[11px] text-cyan-300/90 font-mono tabular-nums px-1 shrink-0">
                {fmtTime(playheadSec)} <span className="text-slate-600">/ {fmtTime(total)}</span>
              </span>
              <div className="w-px h-5 bg-white/10 mx-1" />
              <IconBtn onClick={splitAtPlayhead} disabled={!canSplit()} title="Split at playhead">
                <ScissorsIcon />
              </IconBtn>
              <IconBtn onClick={undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">
                <UndoIcon />
              </IconBtn>
              <IconBtn
                onClick={() => {
                  if (selected) removeItem(selected.id);
                  else if (selectedBrollId) removeBroll(selectedBrollId);
                }}
                disabled={!selected && !selectedBrollId}
                title="Delete selected clip"
              >
                <TrashIcon />
              </IconBtn>
              <IconBtn onClick={() => selected && addOverlay(selected.id, itemDur(selected))} disabled={!selected} title="Add text to selected clip">+T</IconBtn>
              <IconBtn onClick={() => selected && autoCaption(selected)} disabled={!selected || selected.kind !== "video" || autoCaptioning} title="AI auto-caption selected clip only">
                {autoCaptioning ? "…" : <MicIcon />}
              </IconBtn>
              <button
                onClick={autoCaptionAll}
                disabled={autoCaptioning || items.every((it) => it.kind !== "video")}
                title="AI-generate subtitles for every clip on the timeline"
                className="h-8 px-2.5 rounded-lg flex items-center gap-1 text-[11px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                style={{ background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)", color: "#67e8f9" }}
              >
                {autoCaptioning ? (
                  "Captioning…"
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <WandIcon /> AI Subtitles
                  </span>
                )}
              </button>
              <div className="flex-1" />
              {autoCaptionError && <span className="text-[10.5px] text-rose-400 mr-2">{autoCaptionError}</span>}
              <span className="text-[10px] text-slate-500">🔍</span>
              <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-24 accent-cyan-400" />
            </div>

            {/* timeline */}
            {/* Resize handle — drag up to enlarge every row (rowScale),
                drag down to shrink back toward the default. A thin bar
                sitting right above the track container so it reads as "pull
                this edge" rather than a random control. */}
            <div
              onMouseDown={beginRowResizeDrag}
              className="shrink-0 mx-4 h-2.5 rounded-full cursor-ns-resize flex items-center justify-center group"
              title="Drag to resize timeline rows"
            >
              <div className="w-10 h-1 rounded-full bg-white/15 group-hover:bg-cyan-400/70 transition-colors" />
            </div>
            <div className="shrink-0 px-4 py-3 flex gap-1.5" style={{ height: trackHeight + 24 }}>
              {/* Fixed (non-scrolling) B-roll track-header column — lock/
                  hide/mute per track, CapCut-style. Deliberately its own
                  sibling column rather than living inside the horizontally-
                  scrolling track div below, so it stays put while the user
                  scrolls a long timeline left/right. */}
              {items.length > 0 && (
                <div className="relative shrink-0" style={{ width: 56, height: "100%" }}>
                  {Array.from({ length: NUM_BROLL_TRACKS }, (_, track) => (
                    <div
                      key={track}
                      className="absolute left-0 right-0 flex items-center justify-center gap-1 rounded"
                      style={{
                        top: brollTrackTop(track),
                        height: brollTrackH,
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <button
                        onClick={() => toggleTrackLocked(track)}
                        title={trackLocked[track] ? "Unlock this B-roll track" : "Lock this B-roll track (blocks new drops/edits)"}
                        className="transition-colors flex items-center justify-center w-4 h-4 rounded hover:bg-white/10"
                        style={{ color: trackLocked[track] ? "#fbbf24" : "#64748b" }}
                      >
                        {trackLocked[track] ? <LockIcon /> : <UnlockIcon />}
                      </button>
                      <button
                        onClick={() => toggleTrackHidden(track)}
                        title={trackHidden[track] ? "Show this B-roll track" : "Hide this B-roll track (skips it in preview + export)"}
                        className="transition-colors flex items-center justify-center w-4 h-4 rounded hover:bg-white/10"
                        style={{ color: trackHidden[track] ? "#f87171" : "#64748b" }}
                      >
                        {trackHidden[track] ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                      <button
                        onClick={() => toggleTrackMuted(track)}
                        title={trackMuted[track] ? "Unmute this track's preview audio" : "Mute this track's preview audio (preview-only — B-roll audio isn't mixed into the export)"}
                        className="transition-colors flex items-center justify-center w-4 h-4 rounded hover:bg-white/10"
                        style={{ color: trackMuted[track] ? "#f87171" : "#64748b" }}
                      >
                        {trackMuted[track] ? <MuteIcon /> : <VolumeIcon />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div
                ref={trackRef}
                onClick={onTrackClick}
                className="relative overflow-x-auto overflow-y-visible rounded-xl h-full flex-1 min-w-0"
                style={{
                  background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 1px, transparent 1px, transparent 46px), #0b0f1c",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div className="relative h-full" style={{ width: Math.max(400, total * zoom + 60) }}>
                  {items.length === 0 && (
                    <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-600">
                      Drag a clip from Media on the left to start building your timeline.
                    </p>
                  )}

                  {/* B-roll row — an overlay track sitting on top of the base
                      video during whatever time window it's placed at. Two
                      things can land here: (1) a Media bin thumbnail dragged
                      down from the left (see the bin button's onDragStart —
                      the drag payload travels mainly via draggedBinClipRef,
                      not dataTransfer, since some embedded webview contexts
                      don't reliably deliver custom dataTransfer MIME types),
                      or (2) a photo/video file dragged straight in from the
                      user's own computer, which gets uploaded on the spot and
                      placed as B-roll immediately (and shows up in the Media
                      panel from then on too, via uploadFiles). */}
                  {items.length > 0 &&
                    Array.from({ length: NUM_BROLL_TRACKS }, (_, track) => {
                      const locked = trackLocked[track];
                      return (
                        <div
                          key={track}
                          onDragOver={(e) => {
                            if (locked) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "copy";
                            setBrollDragOverTrack(track);
                          }}
                          onDragLeave={() => setBrollDragOverTrack((cur) => (cur === track ? null : cur))}
                          onDrop={async (e) => {
                            e.preventDefault();
                            setBrollDragOverTrack(null);
                            if (locked) return;
                            const rect = trackRef.current?.getBoundingClientRect();
                            if (!rect) return;
                            const sec = (e.clientX - rect.left + (trackRef.current?.scrollLeft || 0)) / zoom;

                            // Case 1: a real file dragged in from outside the app.
                            if (e.dataTransfer.files && e.dataTransfer.files.length) {
                              const added = await uploadFiles(e.dataTransfer.files);
                              added.forEach((clip) => addBrollFromBoard(clip, sec, track));
                              return;
                            }

                            // Case 2: an existing Media bin thumbnail — ref
                            // first (see its doc comment), dataTransfer as a
                            // fallback for browsers where that's actually
                            // reliable.
                            const clip = draggedBinClipRef.current;
                            draggedBinClipRef.current = null;
                            if (clip) {
                              addBrollFromBoard(clip, sec, track);
                              return;
                            }
                            const raw = e.dataTransfer.getData("application/x-broll-clip");
                            if (!raw) return;
                            try {
                              addBrollFromBoard(JSON.parse(raw), sec, track);
                            } catch {
                              // Malformed drag payload — silently ignore.
                            }
                          }}
                          className="absolute rounded-lg transition-colors"
                          style={{
                            left: 0,
                            width: Math.max(400, total * zoom + 60),
                            top: brollTrackTop(track),
                            height: brollTrackH,
                            cursor: locked ? "not-allowed" : undefined,
                            background: locked
                              ? "repeating-linear-gradient(45deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 4px, transparent 4px, transparent 8px)"
                              : brollDragOverTrack === track
                              ? "rgba(34,211,238,0.10)"
                              : "rgba(255,255,255,0.02)",
                            border: brollDragOverTrack === track ? "1px dashed rgba(34,211,238,0.6)" : "1px dashed rgba(255,255,255,0.08)",
                          }}
                        >
                          {broll.every((b) => b.track !== track) && (
                            <span className="absolute inset-0 flex items-center px-2 text-[9.5px] text-slate-600 pointer-events-none truncate">
                              {locked ? "Locked" : `Drag a clip here for B-roll layer ${track + 1}`}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  {broll.map((b) => {
                    const left = b.startSec * zoom;
                    const width = Math.max(6, b.duration * zoom);
                    const isSel = b.id === selectedBrollId;
                    const thumb = b.kind === "video" ? thumbsByUrl[b.url] : b.url;
                    const locked = trackLocked[b.track];
                    const hidden = trackHidden[b.track];
                    return (
                      <div
                        key={b.id}
                        onMouseDown={
                          locked
                            ? (e) => {
                                e.stopPropagation();
                                setSelectedBrollId(b.id);
                                setSelectedId(null);
                                setSelectedOverlayId(null);
                                setMusicSelected(false);
                              }
                            : beginBrollMoveDrag(b)
                        }
                        title={`${b.label}${hidden ? " (hidden)" : ""}${locked ? " (locked)" : ""}`}
                        className="absolute rounded-md overflow-hidden"
                        style={{
                          left,
                          width,
                          top: brollTrackTop(b.track),
                          height: brollTrackH,
                          opacity: hidden ? 0.4 : 1,
                          cursor: locked ? "default" : "grab",
                          boxShadow: isSel ? "0 0 0 2px #a78bfa, 0 0 12px -2px rgba(167,139,250,0.8)" : "0 0 0 1px rgba(255,255,255,0.18)",
                          background: "linear-gradient(135deg, rgba(167,139,250,0.9), rgba(139,92,246,0.85))",
                          backgroundImage: thumb ? `linear-gradient(to top, rgba(2,6,23,.55), rgba(2,6,23,.1) 60%), url(${thumb})` : undefined,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }}
                      >
                        <span className="absolute left-1 top-0.5 text-[8.5px] text-white/90 truncate drop-shadow-sm" style={{ maxWidth: "calc(100% - 8px)" }}>
                          {b.label}
                        </span>
                        {!locked && (
                          <div onMouseDown={beginBrollResizeDrag(b)} className="absolute top-0 bottom-0 right-0 w-1.5 bg-white/0 hover:bg-white/50 cursor-ew-resize" />
                        )}
                      </div>
                    );
                  })}
                  {items.length > 0 && (
                    <div className="absolute left-2 text-[9px] text-slate-600 uppercase tracking-wide pointer-events-none" style={{ top: brollRowTop - 12 }}>
                      B-roll
                    </div>
                  )}

                  {/* video row */}
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
                          setSelectedOverlayId(null);
                          setSelectedBrollId(null);
                          setMusicSelected(false);
                        }}
                        className="absolute rounded-lg overflow-hidden cursor-grab active:cursor-grabbing transition-shadow"
                        style={{
                          left,
                          width,
                          top: videoRowTop,
                          height: videoRowH,
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

                  {/* per-boundary transition pickers */}
                  {items.slice(0, -1).map((_, i) => {
                    const x = offsetOfItem(items, i + 1) * zoom;
                    const trans = transitions[i] || DEFAULT_TRANSITION;
                    return (
                      <div key={`boundary-${i}`} className="absolute z-20" style={{ left: x - 9, top: videoRowTop + videoRowH / 2 - 9 }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenTransitionAt((cur) => (cur === i ? null : i));
                          }}
                          title={TRANSITION_LABELS[trans.preset]}
                          className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-cyan-200 transition-colors hover:text-white"
                          style={{ background: "#0f1424", border: "1px solid rgba(34,211,238,0.4)", boxShadow: "0 0 8px -2px rgba(34,211,238,0.5)" }}
                        >
                          <SwapIcon />
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

                  {/* text track */}
                  {overlays.map((o) => {
                    const idx = items.findIndex((it) => it.id === o.itemId);
                    if (idx === -1) return null;
                    const base = offsetOfItem(items, idx);
                    const left = (base + o.startSec) * zoom;
                    const width = Math.max(10, (o.endSec - o.startSec) * zoom);
                    const isSel = o.id === selectedOverlayId;
                    return (
                      <div
                        key={o.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(o.itemId);
                          setSelectedOverlayId(o.id);
                          setSelectedBrollId(null);
                          setMusicSelected(false);
                        }}
                        className="absolute rounded px-1.5 flex items-center text-[9px] text-slate-100 truncate cursor-pointer transition-colors"
                        style={{
                          left,
                          width,
                          top: textRowTop,
                          height: textRowH,
                          background: isSel ? "rgba(34,211,238,0.28)" : "rgba(255,255,255,0.06)",
                          border: isSel ? "1px solid rgba(34,211,238,0.7)" : "1px solid rgba(255,255,255,0.12)",
                        }}
                        title={o.text || "(empty caption)"}
                      >
                        {o.text || "Text"}
                      </div>
                    );
                  })}
                  {items.length > 0 && (
                    <div className="absolute left-2 text-[9px] text-slate-600 uppercase tracking-wide pointer-events-none" style={{ top: textRowTop - 12 }}>
                      Text
                    </div>
                  )}

                  {/* music row — a single background-music slot dropped/
                      uploaded here, spans the whole track width (loops or
                      trims to match on export) with a volume slider in the
                      Properties panel when selected. */}
                  {items.length > 0 && (
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                        setMusicDragOver(true);
                      }}
                      onDragLeave={() => setMusicDragOver(false)}
                      onDrop={async (e) => {
                        e.preventDefault();
                        setMusicDragOver(false);
                        // Case 1: a real file dragged in from outside the app
                        // — audio or video, either is fine (see
                        // MUSIC_MIME_OK's doc comment).
                        if (e.dataTransfer.files && e.dataTransfer.files.length) {
                          await uploadMusicFile(e.dataTransfer.files[0]);
                          return;
                        }
                        // Case 2: an existing Media bin VIDEO clip dragged
                        // straight over — it's already uploaded and has a
                        // real URL, so no re-upload needed, just point the
                        // music track at it directly; its audio track gets
                        // picked up automatically at render time. Images
                        // have no audio, so those are ignored here. Ref
                        // first (see draggedBinClipRef's own doc comment),
                        // dataTransfer JSON as a fallback.
                        const clip = draggedBinClipRef.current;
                        draggedBinClipRef.current = null;
                        const useClip =
                          clip && clip.kind === "video"
                            ? clip
                            : (() => {
                                const raw = e.dataTransfer.getData("application/x-broll-clip");
                                if (!raw) return null;
                                try {
                                  const parsed = JSON.parse(raw);
                                  return parsed?.kind === "video" && parsed?.url ? parsed : null;
                                } catch {
                                  return null;
                                }
                              })();
                        if (useClip) {
                          pushHistory();
                          setMusic({ url: useClip.url, label: useClip.label || "Background music", volume: DEFAULT_MUSIC_VOLUME });
                          setSelectedId(null);
                          setSelectedOverlayId(null);
                          setSelectedBrollId(null);
                          setMusicSelected(true);
                        }
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (music) {
                          setSelectedId(null);
                          setSelectedOverlayId(null);
                          setSelectedBrollId(null);
                          setMusicSelected(true);
                        } else {
                          musicInputRef.current?.click();
                        }
                      }}
                      className="absolute rounded-lg transition-colors cursor-pointer overflow-hidden"
                      style={{
                        left: 0,
                        width: Math.max(400, total * zoom + 60),
                        top: musicRowTop,
                        height: musicRowH,
                        background: musicSelected
                          ? "rgba(52,211,153,0.22)"
                          : musicDragOver
                          ? "rgba(52,211,153,0.14)"
                          : "rgba(255,255,255,0.02)",
                        border: musicSelected
                          ? "1px solid rgba(52,211,153,0.7)"
                          : musicDragOver
                          ? "1px dashed rgba(52,211,153,0.6)"
                          : "1px dashed rgba(255,255,255,0.08)",
                      }}
                    >
                      <span className="absolute inset-0 flex items-center px-2 text-[9.5px] text-slate-300 pointer-events-none truncate gap-1">
                        {music ? `🎵 ${music.label}` : "Drop audio/video or click to add background music"}
                      </span>
                    </div>
                  )}
                  {items.length > 0 && (
                    <div className="absolute left-2 text-[9px] text-slate-600 uppercase tracking-wide pointer-events-none" style={{ top: musicRowTop - 12 }}>
                      Music
                    </div>
                  )}

                  {/* playhead */}
                  <div onMouseDown={beginPlayheadDrag} className="absolute top-0 bottom-0 w-3 z-10 cursor-ew-resize" style={{ left: playheadSec * zoom - 6 }}>
                    <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45" style={{ background: "#22d3ee", boxShadow: "0 0 8px rgba(34,211,238,0.9)" }} />
                    <div className="absolute inset-y-0 left-1.5 w-px pointer-events-none" style={{ background: "#22d3ee", boxShadow: "0 0 6px rgba(34,211,238,0.9)" }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Inspector */}
          <div className="w-72 shrink-0 border-l border-white/10 flex flex-col min-h-0">
            <div className="px-3 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-medium shrink-0 border-b border-white/5">⚙️ Properties</div>
            <div className="flex-1 overflow-y-auto p-3">
              {musicSelected && !selected && !selectedBrollId && music ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <span className="text-sm text-slate-100 font-medium block truncate">🎵 {music.label}</span>
                    <span className="text-[10.5px] text-slate-500">Background music</span>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10.5px] text-slate-500">Volume — {Math.round(music.volume * 100)}%</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={music.volume}
                      onChange={(e) => updateMusic({ volume: Number(e.target.value) })}
                      className="accent-emerald-400"
                    />
                  </label>
                  <p className="text-[10px] text-slate-600">
                    Plays under the clips' own audio for the whole video, looping or trimming to match the final length.
                  </p>
                  <button
                    onClick={() => musicInputRef.current?.click()}
                    disabled={uploading}
                    className="text-[11px] px-3 py-1.5 rounded-lg text-cyan-300 hover:text-cyan-200 disabled:opacity-40 transition-colors self-start"
                    style={{ background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)" }}
                  >
                    Replace track
                  </button>
                  <button
                    onClick={removeMusic}
                    className="text-[11px] px-3 py-1.5 rounded-lg text-rose-300 hover:text-rose-200 transition-colors self-start"
                    style={{ background: "rgba(244,63,94,0.1)", border: "1px solid rgba(244,63,94,0.3)" }}
                  >
                    Remove music
                  </button>
                </div>
              ) : selectedBrollId && !selected ? (
                (() => {
                  const b = broll.find((x) => x.id === selectedBrollId);
                  if (!b) return null;
                  return (
                    <div className="flex flex-col gap-3">
                      <div>
                        <span className="text-sm text-slate-100 font-medium block truncate">{b.label}</span>
                        <span className="text-[10.5px] text-slate-500">B-roll overlay · {b.kind}</span>
                      </div>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10.5px] text-slate-500">Starts at (sec)</span>
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={Number(b.startSec.toFixed(2))}
                          onChange={(e) => updateBroll(b.id, { startSec: Math.max(0, Math.min(total - 0.1, Number(e.target.value) || 0)) })}
                          className="text-xs rounded-lg px-2 py-1.5 outline-none"
                          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0" }}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10.5px] text-slate-500">Duration (sec)</span>
                        <input
                          type="number"
                          min={0.3}
                          step={0.1}
                          value={Number(b.duration.toFixed(2))}
                          onChange={(e) => updateBroll(b.id, { duration: Math.max(0.3, Number(e.target.value) || 0.3) })}
                          className="text-xs rounded-lg px-2 py-1.5 outline-none"
                          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0" }}
                        />
                      </label>
                      <p className="text-[10px] text-slate-600">
                        Shown ON TOP of whatever base clip is playing during this window. On the timeline: drag the block to reposition WHEN it shows, or its right edge to resize how long. In the preview above: drag the frame itself to reposition WHERE it shows, or its corner handle to resize into a picture-in-picture inset.
                      </p>
                      {(b.boxX !== 0 || b.boxY !== 0 || b.boxW !== 1 || b.boxH !== 1) && (
                        <button
                          onClick={() => updateBroll(b.id, { boxX: 0, boxY: 0, boxW: 1, boxH: 1 })}
                          className="text-[11px] px-3 py-1.5 rounded-lg text-cyan-300 hover:text-cyan-200 transition-colors self-start"
                          style={{ background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)" }}
                        >
                          Reset to full frame
                        </button>
                      )}
                      <button
                        onClick={() => removeBroll(b.id)}
                        className="text-[11px] px-3 py-1.5 rounded-lg text-rose-300 hover:text-rose-200 transition-colors self-start"
                        style={{ background: "rgba(244,63,94,0.1)", border: "1px solid rgba(244,63,94,0.3)" }}
                      >
                        Remove B-roll
                      </button>
                    </div>
                  );
                })()
              ) : !selected ? (
                // Idle state — instead of wasting this space on a bare
                // placeholder, show the chain's script/voiceover text
                // (one card per shot, in timeline order) so it's readable
                // as a reference while cutting, same way a script
                // supervisor's sheet sits next to an editor's timeline.
                items.length === 0 ? (
                  <p className="text-xs text-slate-500">Add clips to the timeline, then select one to trim it, caption it, or add text.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">📝 Script</p>
                    {items.map((it, i) => (
                      <div key={it.id} className="rounded-lg p-2.5" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <p className="text-[10.5px] text-cyan-300/90 font-medium mb-1 truncate">
                          {i + 1}. {it.label}
                        </p>
                        <p className="text-[11px] text-slate-400 leading-relaxed whitespace-pre-wrap">
                          {it.script?.trim() || "(no script text for this shot)"}
                        </p>
                      </div>
                    ))}
                    <p className="text-[10px] text-slate-600 mt-1 pt-2 border-t border-white/5">
                      Select a clip on the timeline to trim it, caption it, or add text.
                    </p>
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-3">
                  <div>
                    <span className="text-sm text-slate-100 font-medium block truncate">{selected.label}</span>
                    <span className="text-[10.5px] text-slate-500 capitalize">{selected.kind} clip</span>
                  </div>

                  {selected.kind === "video" ? (
                    <div className="text-[11px] text-slate-400 font-mono rounded-lg p-2" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      {selected.trimStart.toFixed(1)}s – {selected.trimEnd.toFixed(1)}s
                      <span className="text-slate-600"> / {selected.duration > 0 ? selected.duration.toFixed(1) : "…"}s</span>
                      <p className="font-sans text-slate-600 mt-1">Drag the block's edges on the timeline to trim.</p>
                    </div>
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

                  <div className="h-px bg-white/5" />

                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Text ({selectedOverlays.length})</span>
                    <button onClick={() => addOverlay(selected.id, itemDur(selected))} className="text-[11px] text-cyan-400 hover:text-cyan-300 transition-colors">
                      + Add
                    </button>
                  </div>

                  {selectedOverlays.length === 0 && <p className="text-[11px] text-slate-600">No captions on this clip yet.</p>}

                  {selectedOverlays.map((o) => (
                    <div
                      key={o.id}
                      onClick={() => setSelectedOverlayId(o.id)}
                      className="flex flex-col gap-1.5 rounded-lg p-2.5 cursor-pointer"
                      style={{
                        background: o.id === selectedOverlayId ? "rgba(34,211,238,0.06)" : "rgba(255,255,255,0.02)",
                        border: o.id === selectedOverlayId ? "1px solid rgba(34,211,238,0.4)" : "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
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
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          value={o.position}
                          onChange={(e) => updateOverlay(o.id, { position: e.target.value as TextOverlay["position"] })}
                          className="flex-1 text-[11px] px-1.5 py-1 rounded border border-white/10 bg-black/30 text-slate-100"
                        >
                          <option value="top" className="bg-[#0f1424]">Top</option>
                          <option value="center" className="bg-[#0f1424]">Center</option>
                          <option value="bottom" className="bg-[#0f1424]">Bottom</option>
                        </select>
                        <select
                          value={o.size}
                          onChange={(e) => updateOverlay(o.id, { size: e.target.value as TextOverlay["size"] })}
                          className="flex-1 text-[11px] px-1.5 py-1 rounded border border-white/10 bg-black/30 text-slate-100"
                        >
                          <option value="small" className="bg-[#0f1424]">Small</option>
                          <option value="medium" className="bg-[#0f1424]">Medium</option>
                          <option value="large" className="bg-[#0f1424]">Large</option>
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => updateOverlay(o.id, { bold: !o.bold })}
                          title="Bold"
                          className="w-7 h-7 rounded border text-[12px] font-bold transition-colors"
                          style={{
                            borderColor: o.bold ? "rgba(34,211,238,0.6)" : "rgba(255,255,255,0.1)",
                            background: o.bold ? "rgba(34,211,238,0.15)" : "rgba(255,255,255,0.02)",
                            color: o.bold ? "#22d3ee" : "#cbd5e1",
                          }}
                        >
                          B
                        </button>
                        <input
                          type="color"
                          value={o.color}
                          onChange={(e) => updateOverlay(o.id, { color: e.target.value })}
                          title="Text color"
                          className="w-7 h-7 rounded border border-white/10 bg-black/30 p-0.5 cursor-pointer"
                        />
                        <span className="text-[10px] text-slate-500 font-mono">{o.color}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {exportResult && (
              <div className="p-3 border-t border-white/10 shrink-0">
                <video src={exportResult.url} controls className="w-full rounded-lg" style={{ border: "1px solid rgba(255,255,255,0.1)" }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
      {/* ---- minimized floating pill — the whole modal stays mounted above
          (just display:none via the root's `hidden` class), so export
          polling, all edit state, and the hidden <video> probes keep
          running; this pill shows the export's live progress. Clicking
          anywhere on it restores the full editor. Sits OUTSIDE the hidden
          root (sibling in the fragment) so it stays visible while the
          overlay is display:none. ---- */}
      {minimized && (
        <div
          onClick={() => setMinimized(false)}
          title="Restore Manual Edit"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 pl-2.5 pr-4 py-2.5 rounded-full cursor-pointer border border-white/15 hover:border-cyan-400/50 transition-colors"
          style={{
            background: "linear-gradient(160deg, #0c1120, #0a0e1a)",
            boxShadow: "0 8px 30px -8px rgba(0,0,0,0.8), 0 0 24px -8px rgba(56,189,248,0.35)",
          }}
        >
          <span
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)" }}
          >
            {exporting ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" className="animate-spin">
                <path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <circle cx="6" cy="6" r="2.4" stroke="white" strokeWidth="1.7" />
                <circle cx="6" cy="18" r="2.4" stroke="white" strokeWidth="1.7" />
                <path d="M8 7.5L20 17" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
                <path d="M8 16.5L20 7" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            )}
          </span>
          <span className="text-xs text-slate-200 font-medium whitespace-nowrap">
            {exporting
              ? exportProgress && exportProgress.totalShots > 0
                ? `Exporting ${exportProgress.completedShots}/${exportProgress.totalShots}…`
                : "Exporting…"
              : exportError
                ? "Export failed — click to reopen"
                : exportResult
                  ? "Export done ✓ — click to open"
                  : "Manual Edit — click to reopen"}
          </span>
        </div>
      )}
    </>
  );
}
