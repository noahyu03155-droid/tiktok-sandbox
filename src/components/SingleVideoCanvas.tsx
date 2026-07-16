"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import type {
  CanvasConnection,
  CanvasDrawing,
  CanvasImage,
  CanvasNote,
  CanvasState,
  CanvasTextBox,
  DrawingTool,
  NoteFontSize,
  TranscriptSegment,
  VideoRecord,
} from "@/lib/types";

// The 6-stage e-commerce funnel used everywhere else in the app (AI
// breakdown's "Structure" tab, script generator beats) — deliberately kept
// in English here too, matching the Structure tab's labels (which Claude
// always writes in English regardless of UI language), so a color means the
// same thing wherever it shows up.
const STAGE_TAGS: { color: string; label: string }[] = [
  { color: "#fe2c55", label: "Reaction" },
  { color: "#22c55e", label: "Hook" },
  { color: "#3b82f6", label: "Pain Point" },
  { color: "#f59e0b", label: "Product Intro" },
  { color: "#a855f7", label: "Desired Outcome" },
  { color: "#64748b", label: "CTA" },
];
const COLORS = STAGE_TAGS.map((s) => s.color);
function stageLabel(color: string | null): string | null {
  if (!color) return null;
  return STAGE_TAGS.find((s) => s.color === color)?.label ?? null;
}

const CARD_WIDTH = 260;
const CARD_GAP_Y = 14;
const DEFAULT_CARD_HEIGHT = 76;
const VIDEO_WIDTH = 200;
const VIDEO_HEIGHT = 356;
const IMAGE_WIDTH = 200;
const IMAGE_HEIGHT = 140;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const TEXTBOX_WIDTH = 220;

// Toolbar tool selection — "select" is the default (pan background / drag
// cards, same as before this toolbar existed). The rest are whiteboard-style
// tools: click-drag on empty canvas to place the entity, tool stays active
// afterward so several can be placed in a row without re-selecting it.
type ActiveTool = "select" | "text" | "connect" | DrawingTool;

// A few preset stroke/text colors — reuses the same palette as the stage
// tags so a drawn arrow/line can optionally double as a stage-colored
// annotation, plus a neutral dark default for plain markup.
const DRAW_COLORS = ["#334155", "#fe2c55", "#22c55e", "#3b82f6", "#f59e0b", "#a855f7"];

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// Controlled, zoom-aware drag: reports every intermediate position via
// onChange (not just the final one) so connector lines can track live.
function useDrag(x: number, y: number, zoom: number, onChange: (x: number, y: number) => void) {
  const draggingRef = useRef(false);
  const lastRef = useRef({ x: 0, y: 0 });
  const posRef = useRef({ x, y });
  posRef.current = { x, y };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true;
    lastRef.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.stopPropagation();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = (e.clientX - lastRef.current.x) / zoom;
      const dy = (e.clientY - lastRef.current.y) / zoom;
      lastRef.current = { x: e.clientX, y: e.clientY };
      const next = { x: Math.max(0, posRef.current.x + dx), y: Math.max(0, posRef.current.y + dy) };
      posRef.current = next;
      onChange(next.x, next.y);
    },
    [zoom, onChange]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}

function ColorDots({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
      {STAGE_TAGS.map(({ color: c, label }) => (
        <button
          key={c}
          onClick={() => onChange(value === c ? null : c)}
          title={label}
          className="w-3.5 h-3.5 rounded-full border"
          style={{ backgroundColor: c, borderColor: value === c ? "white" : "transparent" }}
        />
      ))}
    </div>
  );
}

// Always-visible key so a first-time viewer doesn't have to hover each dot
// to learn what the colors mean — especially useful once the canvas is
// projected/shared in fullscreen during a presentation.
function StageLegend({ hint }: { hint: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-[11px] text-zinc-500 shrink-0">{hint}</span>
      {STAGE_TAGS.map(({ color, label }) => (
        <div key={color} className="flex items-center gap-1 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-[11px] text-zinc-500 whitespace-nowrap">{label}</span>
        </div>
      ))}
    </div>
  );
}

function LinkHandle({ onStart }: { onStart: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onStart}
      title="Drag to connect to another card"
      className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-zinc-400 hover:bg-white border border-stone-300 cursor-crosshair z-10"
    />
  );
}

function SegmentCard({
  segment,
  dataId,
  x,
  y,
  color,
  zoom,
  onChange,
  onColorChange,
  onLinkStart,
}: {
  segment: TranscriptSegment;
  dataId: string;
  x: number;
  y: number;
  color: string | null;
  zoom: number;
  onChange: (x: number, y: number) => void;
  onColorChange: (c: string | null) => void;
  onLinkStart: (e: React.PointerEvent) => void;
}) {
  const drag = useDrag(x, y, zoom, onChange);
  const label = stageLabel(color);

  return (
    <div
      data-entity-id={dataId}
      {...drag}
      style={{ position: "absolute", left: x, top: y, width: CARD_WIDTH, touchAction: "none", borderColor: color || undefined }}
      className="cursor-grab active:cursor-grabbing select-none bg-white border border-stone-200 rounded-lg px-3 py-2 shadow-lg"
    >
      <div className="flex items-center justify-between mb-1 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-mono text-stone-500 shrink-0">{formatTime(segment.start)}</span>
          {label && (
            <span
              className="text-[9px] font-medium px-1.5 py-0.5 rounded-full text-white leading-none whitespace-nowrap truncate"
              style={{ backgroundColor: color || undefined }}
            >
              {label}
            </span>
          )}
        </div>
        <ColorDots value={color} onChange={onColorChange} />
      </div>
      <p className="text-sm text-stone-800 leading-snug">{segment.text}</p>
      <LinkHandle onStart={onLinkStart} />
    </div>
  );
}

function NoteCard({
  note,
  dataId,
  zoom,
  noteLabel,
  onChange,
  onTextChange,
  onColorChange,
  onFontSizeChange,
  onDelete,
  onLinkStart,
}: {
  note: CanvasNote;
  dataId: string;
  zoom: number;
  noteLabel: string;
  onChange: (x: number, y: number) => void;
  onTextChange: (html: string) => void;
  onColorChange: (c: string) => void;
  onFontSizeChange: (s: NoteFontSize) => void;
  onDelete: () => void;
  onLinkStart: (e: React.PointerEvent) => void;
}) {
  const drag = useDrag(note.x, note.y, zoom, onChange);
  const editableRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current && editableRef.current) {
      editableRef.current.innerHTML = note.text;
      initialized.current = true;
    }
    // Only seed once on mount — this is an uncontrolled contentEditable so
    // typing doesn't fight React's re-render (which would reset the caret).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function exec(cmd: string, value?: string) {
    editableRef.current?.focus();
    document.execCommand(cmd, false, value);
    onTextChange(editableRef.current?.innerHTML || "");
  }

  const fontSizeClass = note.fontSize === "sm" ? "text-xs" : note.fontSize === "lg" ? "text-base" : "text-sm";
  const nextFontSize: NoteFontSize = note.fontSize === "sm" ? "md" : note.fontSize === "md" ? "lg" : "sm";
  const headerLabel = stageLabel(note.color) || noteLabel;

  return (
    <div
      data-entity-id={dataId}
      style={{ position: "absolute", left: note.x, top: note.y, width: CARD_WIDTH, touchAction: "none" }}
      className="rounded-lg shadow-lg overflow-hidden border border-stone-200"
    >
      <div
        {...drag}
        style={{ backgroundColor: note.color }}
        className="cursor-grab active:cursor-grabbing select-none flex items-center justify-between px-2 py-1"
      >
        <span className="text-[11px] font-medium text-black/70 truncate">{headerLabel}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec("bold")}
            className="text-[10px] font-bold text-black/70 hover:text-black w-4"
          >
            B
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec("hiliteColor", "#fef08a")}
            className="text-[10px] text-black/70 hover:text-black w-4"
            title="Highlight"
          >
            H
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onFontSizeChange(nextFontSize)}
            className="text-[9px] font-medium text-black/70 hover:text-black px-1 border border-black/20 rounded"
            title="Font size"
          >
            {note.fontSize.toUpperCase()}
          </button>
          <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-1">
            {STAGE_TAGS.map(({ color: c, label }) => (
              <button
                key={c}
                onClick={() => onColorChange(c)}
                title={label}
                className="w-3 h-3 rounded-full border border-black/20"
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onDelete}
            className="text-black/60 hover:text-black text-xs px-0.5"
          >
            ✕
          </button>
        </div>
      </div>
      <div
        ref={editableRef}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => onTextChange((e.target as HTMLDivElement).innerHTML)}
        onPointerDown={(e) => e.stopPropagation()}
        className={`w-full bg-white text-stone-800 p-2 outline-none min-h-[70px] ${fontSizeClass}`}
      />
      <LinkHandle onStart={onLinkStart} />
    </div>
  );
}

function TextBoxCard({
  box,
  dataId,
  zoom,
  placeholder,
  onChange,
  onTextChange,
  onFontSizeChange,
  onDelete,
  onLinkStart,
}: {
  box: CanvasTextBox;
  dataId: string;
  zoom: number;
  placeholder: string;
  onChange: (x: number, y: number) => void;
  onTextChange: (html: string) => void;
  onFontSizeChange: (s: NoteFontSize) => void;
  onDelete: () => void;
  onLinkStart: (e: React.PointerEvent) => void;
}) {
  const drag = useDrag(box.x, box.y, zoom, onChange);
  const editableRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current && editableRef.current) {
      editableRef.current.innerHTML = box.text;
      initialized.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fontSizeClass = box.fontSize === "sm" ? "text-xs" : box.fontSize === "lg" ? "text-lg" : "text-sm";
  const nextFontSize: NoteFontSize = box.fontSize === "sm" ? "md" : box.fontSize === "md" ? "lg" : "sm";

  return (
    <div
      data-entity-id={dataId}
      {...drag}
      style={{ position: "absolute", left: box.x, top: box.y, width: TEXTBOX_WIDTH, touchAction: "none" }}
      className="group cursor-grab active:cursor-grabbing select-none"
    >
      <div className="absolute -top-6 right-0 hidden group-hover:flex items-center gap-1 bg-white border border-stone-200 rounded-md shadow-sm px-1 py-0.5 z-10">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onFontSizeChange(nextFontSize)}
          className="text-[9px] font-medium text-stone-500 hover:text-stone-900 px-1"
          title="Font size"
        >
          {box.fontSize.toUpperCase()}
        </button>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onDelete} className="text-stone-400 hover:text-red-500 text-xs px-1">
          ✕
        </button>
      </div>
      <div
        ref={editableRef}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={(e) => onTextChange((e.target as HTMLDivElement).innerHTML)}
        onPointerDown={(e) => e.stopPropagation()}
        className={`w-full text-stone-800 outline-none p-1 empty:before:content-[attr(data-placeholder)] empty:before:text-stone-400 ${fontSizeClass}`}
      />
      <LinkHandle onStart={onLinkStart} />
    </div>
  );
}

function ImageCard({
  image,
  dataId,
  zoom,
  onChange,
  onDelete,
  onLinkStart,
}: {
  image: CanvasImage;
  dataId: string;
  zoom: number;
  onChange: (x: number, y: number) => void;
  onDelete: () => void;
  onLinkStart: (e: React.PointerEvent) => void;
}) {
  const drag = useDrag(image.x, image.y, zoom, onChange);
  return (
    <div
      data-entity-id={dataId}
      {...drag}
      style={{ position: "absolute", left: image.x, top: image.y, width: IMAGE_WIDTH, touchAction: "none" }}
      className="cursor-grab active:cursor-grabbing select-none rounded-lg overflow-hidden border border-stone-200 shadow-lg bg-white"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.dataUrl} alt="captured frame" className="w-full block" draggable={false} />
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onDelete}
        className="absolute top-1 right-1 text-white bg-black/60 hover:bg-black/80 text-xs rounded-full w-5 h-5"
      >
        ✕
      </button>
      <LinkHandle onStart={onLinkStart} />
    </div>
  );
}

function VideoOnCanvas({
  video,
  dataId,
  x,
  y,
  zoom,
  onChange,
  onCapture,
  onLinkStart,
}: {
  video: VideoRecord;
  dataId: string;
  x: number;
  y: number;
  zoom: number;
  onChange: (x: number, y: number) => void;
  onCapture: (dataUrl: string) => void;
  onLinkStart: (e: React.PointerEvent) => void;
}) {
  const drag = useDrag(x, y, zoom, onChange);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoSrc = video.video_path ? `/api/media/${video.id}.mp4` : null;

  function captureFrame() {
    const el = videoRef.current;
    if (!el || !el.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(el, 0, 0);
    onCapture(canvas.toDataURL("image/jpeg", 0.85));
  }

  return (
    <div
      data-entity-id={dataId}
      style={{ position: "absolute", left: x, top: y, width: VIDEO_WIDTH, touchAction: "none" }}
      className="rounded-lg overflow-hidden border border-stone-200 shadow-lg bg-white"
    >
      <div
        {...drag}
        className="cursor-grab active:cursor-grabbing select-none flex items-center justify-between px-2 py-1 bg-stone-100"
      >
        <span className="text-[11px] text-stone-700 truncate">{video.title || video.source_url}</span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={captureFrame}
          title="Capture current frame to canvas"
          className="text-[11px] text-stone-700 hover:text-stone-900 shrink-0 ml-1"
        >
          📷
        </button>
      </div>
      <div style={{ width: VIDEO_WIDTH, height: VIDEO_HEIGHT }} className="bg-black">
        {videoSrc ? (
          <video ref={videoRef} src={videoSrc} controls crossOrigin="anonymous" className="w-full h-full object-contain" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-stone-500 text-xs">no video</div>
        )}
      </div>
      <LinkHandle onStart={onLinkStart} />
    </div>
  );
}

function ConnectionsOverlay({
  connections,
  getAnchor,
  liveLine,
}: {
  connections: CanvasConnection[];
  getAnchor: (id: string) => { x: number; y: number } | null;
  liveLine: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
}) {
  return (
    <svg
      style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}
    >
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#2fb6ea" />
        </marker>
      </defs>
      {connections.map((c) => {
        const from = getAnchor(c.fromId);
        const to = getAnchor(c.toId);
        if (!from || !to) return null;
        return (
          <line
            key={c.id}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="#2fb6ea"
            strokeWidth={2}
            markerEnd="url(#arrowhead)"
          />
        );
      })}
      {liveLine && (
        <line
          x1={liveLine.from.x}
          y1={liveLine.from.y}
          x2={liveLine.to.x}
          y2={liveLine.to.y}
          stroke="#2fb6ea"
          strokeWidth={2}
          strokeDasharray="4 4"
        />
      )}
    </svg>
  );
}

function colorSlug(color: string) {
  return color.replace("#", "");
}

// Renders committed Line / Arrow / Pen drawings from the toolbar, plus a
// dashed live preview while one is being dragged out. Separate from
// ConnectionsOverlay (which tracks live entity anchors for card-to-card
// links) since these are static point lists the user drew freehand.
function DrawingsOverlay({
  drawings,
  selectedId,
  onSelect,
  onDelete,
  liveDrawing,
  deleteLabel,
}: {
  drawings: CanvasDrawing[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  liveDrawing: { tool: DrawingTool; points: { x: number; y: number }[]; color: string } | null;
  deleteLabel: string;
}) {
  function midpoint(points: { x: number; y: number }[]) {
    const p = points[Math.floor((points.length - 1) / 2)];
    return p || { x: 0, y: 0 };
  }

  function renderStroke(d: CanvasDrawing | { tool: DrawingTool; points: { x: number; y: number }[]; color: string }, opts: { dashed?: boolean; clickable?: boolean; id?: string }) {
    const isSelected = opts.id && opts.id === selectedId;
    const common = {
      stroke: d.color,
      strokeWidth: isSelected ? 4 : 3,
      strokeDasharray: opts.dashed ? "5 5" : undefined,
      strokeLinecap: "round" as const,
      strokeLinejoin: "round" as const,
      fill: "none" as const,
      pointerEvents: opts.clickable ? ("stroke" as const) : ("none" as const),
      style: opts.clickable ? { cursor: "pointer" } : undefined,
      onClick: opts.clickable && opts.id ? (e: React.MouseEvent) => { e.stopPropagation(); onSelect(opts.id!); } : undefined,
    };
    if (d.tool === "pen") {
      return <polyline points={d.points.map((p) => `${p.x},${p.y}`).join(" ")} {...common} />;
    }
    const [a, b] = [d.points[0], d.points[d.points.length - 1]];
    if (!a || !b) return null;
    return (
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        markerEnd={d.tool === "arrow" ? `url(#arrowhead-${colorSlug(d.color)})` : undefined}
        {...common}
      />
    );
  }

  return (
    <svg style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}>
      <defs>
        {DRAW_COLORS.map((c) => (
          <marker key={c} id={`arrowhead-${colorSlug(c)}`} markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill={c} />
          </marker>
        ))}
      </defs>
      {drawings.map((d) => (
        <g key={d.id}>
          {renderStroke(d, { clickable: true, id: d.id })}
          {d.id === selectedId && (
            <foreignObject x={midpoint(d.points).x - 10} y={midpoint(d.points).y - 10} width={20} height={20} style={{ pointerEvents: "auto" }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(d.id);
                }}
                title={deleteLabel}
                className="w-5 h-5 rounded-full bg-white border border-red-300 text-red-500 hover:bg-red-500 hover:text-white text-[10px] leading-none flex items-center justify-center shadow"
              >
                ✕
              </button>
            </foreignObject>
          )}
        </g>
      ))}
      {liveDrawing && liveDrawing.points.length > 1 && renderStroke(liveDrawing, { dashed: true })}
    </svg>
  );
}

// Bottom-floating toolbar: tool selection, stroke color, and a font-size
// control that applies to newly created text boxes (Excalidraw-style — the
// tool stays selected after use so several shapes can be placed in a row).
function CanvasToolbar({
  tool,
  onToolChange,
  color,
  onColorChange,
  fontSize,
  onFontSizeChange,
  labels,
}: {
  tool: ActiveTool;
  onToolChange: (t: ActiveTool) => void;
  color: string;
  onColorChange: (c: string) => void;
  fontSize: NoteFontSize;
  onFontSizeChange: (s: NoteFontSize) => void;
  labels: Record<string, string>;
}) {
  const TOOLS: { key: ActiveTool; icon: string; label: string }[] = [
    { key: "select", icon: "↖", label: labels.select },
    { key: "text", icon: "T", label: labels.text },
    { key: "line", icon: "╱", label: labels.line },
    { key: "arrow", icon: "↗", label: labels.arrow },
    { key: "pen", icon: "✎", label: labels.pen },
    { key: "connect", icon: "⚯", label: labels.connect },
  ];
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-panel border border-edge rounded-xl shadow-lg px-2 py-1.5">
      <div className="flex items-center gap-0.5">
        {TOOLS.map((tl) => (
          <button
            key={tl.key}
            title={tl.label}
            onClick={() => onToolChange(tl.key)}
            className={`w-8 h-8 rounded-lg text-sm flex items-center justify-center transition-colors ${
              tool === tl.key ? "bg-brand-500 text-white" : "text-zinc-500 hover:bg-panel2 hover:text-zinc-900"
            }`}
          >
            {tl.icon}
          </button>
        ))}
      </div>
      <div className="w-px h-6 bg-edge" />
      <div className="flex items-center gap-1" title={labels.color}>
        {DRAW_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => onColorChange(c)}
            title={c}
            className="w-4 h-4 rounded-full border"
            style={{ backgroundColor: c, borderColor: color === c ? "#1c1917" : "transparent", boxShadow: color === c ? "0 0 0 1px #1c1917" : undefined }}
          />
        ))}
      </div>
      <div className="w-px h-6 bg-edge" />
      <div className="flex items-center gap-0.5" title={labels.fontSize}>
        {(["sm", "md", "lg"] as NoteFontSize[]).map((s) => (
          <button
            key={s}
            onClick={() => onFontSizeChange(s)}
            className={`w-7 h-8 rounded-lg text-[10px] font-medium flex items-center justify-center ${
              fontSize === s ? "bg-brand-500 text-white" : "text-zinc-500 hover:bg-panel2 hover:text-zinc-900"
            }`}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SingleVideoCanvas({ video }: { video: VideoRecord }) {
  const { t } = useLocale();
  const segments = video.transcript_segments;

  const [cardPositions, setCardPositions] = useState<CanvasState["cardPositions"]>(() => {
    const initial = { ...(video.canvas?.cardPositions || {}) };
    segments.forEach((_, i) => {
      if (!initial[i]) {
        initial[i] = { x: 20, y: i * (DEFAULT_CARD_HEIGHT + CARD_GAP_Y) + 16, color: null };
      }
    });
    return initial;
  });
  const [notes, setNotes] = useState<CanvasNote[]>(video.canvas?.notes || []);
  const [images, setImages] = useState<CanvasImage[]>(video.canvas?.images || []);
  const [connections, setConnections] = useState<CanvasConnection[]>(video.canvas?.connections || []);
  const [textBoxes, setTextBoxes] = useState<CanvasTextBox[]>(video.canvas?.textBoxes || []);
  const [drawings, setDrawings] = useState<CanvasDrawing[]>(video.canvas?.drawings || []);
  const [videoPos, setVideoPos] = useState(video.canvas?.videoPosition || { x: CARD_WIDTH + 60, y: 16 });
  const [zoom, setZoom] = useState(video.canvas?.zoom ?? 1);
  const [pan, setPan] = useState(video.canvas?.pan || { x: 0, y: 0 });
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [connectingPos, setConnectingPos] = useState<{ x: number; y: number } | null>(null);

  // ---- toolbar ----
  const [activeTool, setActiveTool] = useState<ActiveTool>("select");
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [defaultFontSize, setDefaultFontSize] = useState<NoteFontSize>("md");
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [liveDrawing, setLiveDrawing] = useState<{ tool: DrawingTool; points: { x: number; y: number }[]; color: string } | null>(null);
  // "connect" tool click flow lives alongside the drag-handle-based connect
  // that already exists on every card (LinkHandle) — this is just a second,
  // click-only way to trigger the same setConnections logic.
  const [clickConnectFrom, setClickConnectFrom] = useState<string | null>(null);
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;

  // Fullscreen is a plain CSS overlay (fixed inset-0) rather than the
  // browser Fullscreen API — more reliable across embedded contexts, and
  // Escape/the button both work the same way to exit. Each canvas instance
  // (the main video's and, separately, a linked reference video's) manages
  // its own fullscreen state.
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isFullscreen]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  function saveCanvasNow() {
    setSaveStatus("saving");
    fetch(`/api/videos/${video.id}/canvas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cardPositions,
        notes,
        images,
        connections,
        textBoxes,
        drawings,
        videoPosition: videoPos,
        zoom,
        pan,
      }),
    })
      .then((res) => setSaveStatus(res.ok ? "saved" : "error"))
      .catch(() => setSaveStatus("error"));
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveCanvasNow, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardPositions, notes, images, connections, textBoxes, drawings, videoPos, zoom, pan]);

  function updateCardPos(idx: number, x: number, y: number) {
    setCardPositions((prev) => ({ ...prev, [idx]: { ...prev[idx], x, y } }));
  }
  function updateCardColor(idx: number, color: string | null) {
    setCardPositions((prev) => ({ ...prev, [idx]: { ...prev[idx], color } }));
  }
  function addNote() {
    const id = `note-${Date.now()}`;
    setNotes((prev) => [
      ...prev,
      { id, x: 320 + Math.random() * 100, y: 40 + Math.random() * 100, text: "", color: "#f59e0b", fontSize: "md" },
    ]);
  }
  function updateNoteText(id: string, text: string) {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text } : n)));
  }
  function updateNoteColor(id: string, color: string) {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, color } : n)));
  }
  function updateNoteFontSize(id: string, fontSize: NoteFontSize) {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, fontSize } : n)));
  }
  function updateNotePos(id: string, x: number, y: number) {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n)));
  }
  function deleteNote(id: string) {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    setConnections((prev) => prev.filter((c) => c.fromId !== id && c.toId !== id));
  }
  function addImage(dataUrl: string) {
    const id = `img-${Date.now()}`;
    setImages((prev) => [...prev, { id, x: videoPos.x + VIDEO_WIDTH + 30, y: videoPos.y, dataUrl }]);
  }
  function updateImagePos(id: string, x: number, y: number) {
    setImages((prev) => prev.map((im) => (im.id === id ? { ...im, x, y } : im)));
  }
  function deleteImage(id: string) {
    setImages((prev) => prev.filter((im) => im.id !== id));
    setConnections((prev) => prev.filter((c) => c.fromId !== id && c.toId !== id));
  }
  function addTextBoxAt(x: number, y: number) {
    const id = `text-${Date.now()}`;
    setTextBoxes((prev) => [...prev, { id, x, y, text: "", fontSize: defaultFontSize }]);
  }
  function updateTextBoxText(id: string, text: string) {
    setTextBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, text } : b)));
  }
  function updateTextBoxFontSize(id: string, fontSize: NoteFontSize) {
    setTextBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, fontSize } : b)));
  }
  function updateTextBoxPos(id: string, x: number, y: number) {
    setTextBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, x, y } : b)));
  }
  function deleteTextBox(id: string) {
    setTextBoxes((prev) => prev.filter((b) => b.id !== id));
    setConnections((prev) => prev.filter((c) => c.fromId !== id && c.toId !== id));
  }
  function addDrawing(tool: DrawingTool, points: { x: number; y: number }[], color: string) {
    if (points.length < 2) return;
    const id = `draw-${Date.now()}`;
    setDrawings((prev) => [...prev, { id, tool, points, color }]);
  }
  function deleteDrawing(id: string) {
    setDrawings((prev) => prev.filter((d) => d.id !== id));
    setSelectedDrawingId((cur) => (cur === id ? null : cur));
  }
  function resetLayout() {
    const reset: CanvasState["cardPositions"] = {};
    segments.forEach((_, i) => {
      reset[i] = { x: 20, y: i * (DEFAULT_CARD_HEIGHT + CARD_GAP_Y) + 16, color: cardPositions[i]?.color ?? null };
    });
    setCardPositions(reset);
    setVideoPos({ x: CARD_WIDTH + 60, y: 16 });
  }
  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  // ---- connectors ----
  function worldFromClient(clientX: number, clientY: number) {
    const rect = viewportRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }

  const handleConnectMove = useCallback((e: PointerEvent) => {
    setConnectingPos(worldFromClient(e.clientX, e.clientY));
  }, []);

  const handleConnectUp = useCallback((e: PointerEvent) => {
    window.removeEventListener("pointermove", handleConnectMove);
    window.removeEventListener("pointerup", handleConnectUp);
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const targetEl = el?.closest("[data-entity-id]") as HTMLElement | null;
    const toId = targetEl?.getAttribute("data-entity-id") || null;
    setConnectingFrom((fromId) => {
      if (fromId && toId && toId !== fromId) {
        setConnections((prev) => {
          const exists = prev.some(
            (c) => (c.fromId === fromId && c.toId === toId) || (c.fromId === toId && c.toId === fromId)
          );
          if (exists) return prev;
          return [...prev, { id: `conn-${Date.now()}`, fromId, toId }];
        });
      }
      return null;
    });
    setConnectingPos(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startConnect(e: React.PointerEvent, fromId: string) {
    e.stopPropagation();
    e.preventDefault();
    setConnectingFrom(fromId);
    setConnectingPos(worldFromClient(e.clientX, e.clientY));
    window.addEventListener("pointermove", handleConnectMove);
    window.addEventListener("pointerup", handleConnectUp);
  }

  function getAnchor(id: string): { x: number; y: number } | null {
    if (id === "video") return { x: videoPos.x + VIDEO_WIDTH / 2, y: videoPos.y + VIDEO_HEIGHT / 2 };
    if (id.startsWith("seg-")) {
      const p = cardPositions[id.slice(4)];
      return p ? { x: p.x + CARD_WIDTH / 2, y: p.y + 28 } : null;
    }
    if (id.startsWith("note-")) {
      const n = notes.find((n) => n.id === id);
      return n ? { x: n.x + CARD_WIDTH / 2, y: n.y + 40 } : null;
    }
    if (id.startsWith("img-")) {
      const im = images.find((im) => im.id === id);
      return im ? { x: im.x + IMAGE_WIDTH / 2, y: im.y + IMAGE_HEIGHT / 2 } : null;
    }
    if (id.startsWith("text-")) {
      const b = textBoxes.find((b) => b.id === id);
      return b ? { x: b.x + TEXTBOX_WIDTH / 2, y: b.y + 16 } : null;
    }
    return null;
  }

  // ---- click-to-connect (toolbar "Connect" tool — an alternative to
  // dragging each card's little LinkHandle dot) ----
  useEffect(() => {
    if (activeTool !== "connect") {
      setClickConnectFrom(null);
      return;
    }
    function onClick(e: MouseEvent) {
      const el = (e.target as HTMLElement).closest("[data-entity-id]") as HTMLElement | null;
      const id = el?.getAttribute("data-entity-id") || null;
      if (!id) {
        setClickConnectFrom(null);
        return;
      }
      setClickConnectFrom((fromId) => {
        if (!fromId) return id;
        if (fromId === id) return null;
        setConnections((prev) => {
          const exists = prev.some(
            (c) => (c.fromId === fromId && c.toId === id) || (c.fromId === id && c.toId === fromId)
          );
          if (exists) return prev;
          return [...prev, { id: `conn-${Date.now()}`, fromId, toId: id }];
        });
        return null;
      });
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [activeTool]);

  // ---- pan + zoom + toolbar tools (drawing / text placement) ----
  const panDraggingRef = useRef(false);
  const panLastRef = useRef({ x: 0, y: 0 });
  const drawingRef = useRef<{ tool: DrawingTool; points: { x: number; y: number }[]; color: string } | null>(null);

  function handleBgPointerDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget) return;
    const tool = activeToolRef.current;

    if (tool === "select") {
      setSelectedDrawingId(null);
      panDraggingRef.current = true;
      panLastRef.current = { x: e.clientX, y: e.clientY };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "text") {
      const p = worldFromClient(e.clientX, e.clientY);
      addTextBoxAt(p.x, p.y);
      return;
    }
    if (tool === "line" || tool === "arrow" || tool === "pen") {
      const p = worldFromClient(e.clientX, e.clientY);
      drawingRef.current = { tool, points: [p], color: drawColor };
      setLiveDrawing(drawingRef.current);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    // "connect" tool: clicking empty background just cancels an in-progress pick.
    if (tool === "connect") setClickConnectFrom(null);
  }
  function handleBgPointerMove(e: React.PointerEvent) {
    if (panDraggingRef.current) {
      const dx = e.clientX - panLastRef.current.x;
      const dy = e.clientY - panLastRef.current.y;
      panLastRef.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }
    if (drawingRef.current) {
      const p = worldFromClient(e.clientX, e.clientY);
      if (drawingRef.current.tool === "pen") {
        drawingRef.current = { ...drawingRef.current, points: [...drawingRef.current.points, p] };
      } else {
        drawingRef.current = { ...drawingRef.current, points: [drawingRef.current.points[0], p] };
      }
      setLiveDrawing(drawingRef.current);
    }
  }
  function handleBgPointerUp() {
    panDraggingRef.current = false;
    if (drawingRef.current) {
      const { tool, points, color } = drawingRef.current;
      addDrawing(tool, points, color);
      drawingRef.current = null;
      setLiveDrawing(null);
    }
  }
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    setZoom((z) => clamp(z - e.deltaY * 0.0012, MIN_ZOOM, MAX_ZOOM));
  }

  // Bound as a native, non-passive listener rather than via React's onWheel
  // prop. React 17+ registers onWheel (and onTouchMove/onTouchStart) as
  // passive listeners for scroll performance, which silently ignores
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

  const drawingPointsX = drawings.flatMap((d) => d.points.map((p) => p.x));
  const drawingPointsY = drawings.flatMap((d) => d.points.map((p) => p.y));

  const contentBottom = Math.max(
    ...segments.map((_, i) => (cardPositions[i]?.y ?? 0) + DEFAULT_CARD_HEIGHT),
    ...notes.map((n) => n.y + 160),
    ...images.map((im) => im.y + IMAGE_HEIGHT),
    ...textBoxes.map((b) => b.y + 60),
    ...drawingPointsY,
    videoPos.y + VIDEO_HEIGHT,
    400
  );
  const contentRight = Math.max(
    ...segments.map((_, i) => (cardPositions[i]?.x ?? 0) + CARD_WIDTH),
    ...notes.map((n) => n.x + CARD_WIDTH),
    ...images.map((im) => im.x + IMAGE_WIDTH),
    ...textBoxes.map((b) => b.x + TEXTBOX_WIDTH),
    ...drawingPointsX,
    videoPos.x + VIDEO_WIDTH,
    900
  );

  if (segments.length === 0) {
    return <p className="text-sm text-zinc-500">{t("noCanvasTranscript")}</p>;
  }

  return (
    <div className={isFullscreen ? "fixed inset-0 z-50 bg-ink p-4 overflow-auto" : ""}>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <p className="text-xs text-zinc-500 hidden lg:block">{t("canvasHint")}</p>
        <div className="flex gap-2 ml-auto items-center">
          <span className="text-xs flex items-center gap-1.5 text-zinc-500">
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
            {saveStatus === "saving" && t("canvasSaving")}
            {saveStatus === "saved" && t("canvasSaved")}
            {saveStatus === "error" && t("canvasSaveFailed")}
          </span>
          <button
            onClick={() => setIsFullscreen((f) => !f)}
            className={`text-xs rounded-lg px-3 py-1.5 border ${
              isFullscreen
                ? "bg-brand-500 text-white border-brand-500 hover:bg-brand-600"
                : "text-zinc-500 hover:text-zinc-900 border-edge"
            }`}
          >
            {isFullscreen ? `✕ ${t("canvasExitFullscreen")}` : `⛶ ${t("canvasFullscreen")}`}
          </button>
          <div className="flex items-center gap-1 border border-edge rounded-lg overflow-hidden">
            <button onClick={() => setZoom((z) => clamp(z - 0.15, MIN_ZOOM, MAX_ZOOM))} className="px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-900">
              −
            </button>
            <span className="text-xs text-zinc-500 px-1 w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => clamp(z + 0.15, MIN_ZOOM, MAX_ZOOM))} className="px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-900">
              +
            </button>
          </div>
          <button onClick={resetView} className="text-xs text-zinc-500 hover:text-zinc-900 border border-edge rounded-lg px-3 py-1.5">
            Reset view
          </button>
          <button onClick={resetLayout} className="text-xs text-zinc-500 hover:text-zinc-900 border border-edge rounded-lg px-3 py-1.5">
            {t("resetLayout")}
          </button>
          <button onClick={addNote} className="text-xs text-white bg-brand-500 hover:bg-brand-600 rounded-lg px-3 py-1.5">
            {t("addNote")}
          </button>
        </div>
      </div>

      {saveStatus === "error" && (
        <div className="mb-2 px-5 py-2 rounded-lg bg-red-500/15 border border-red-500/40 flex items-center justify-between gap-3">
          <span className="text-xs text-red-600">{t("canvasSaveFailedBanner")}</span>
          <button
            onClick={saveCanvasNow}
            className="px-2.5 py-1 rounded bg-red-500/20 border border-red-500/50 text-red-700 text-xs font-medium hover:bg-red-500/30 shrink-0"
          >
            {t("canvasRetrySave")}
          </button>
        </div>
      )}

      <div className="mb-2">
        <StageLegend hint={t("canvasStageLegendHint")} />
      </div>

      <div
        ref={viewportRef}
        className="relative bg-stone-50 border border-edge rounded-xl overflow-hidden"
        style={{
          height: isFullscreen ? "calc(100vh - 130px)" : "65vh",
          cursor: connectingFrom || activeTool === "connect" ? "crosshair" : undefined,
        }}
      >
        <div
          onPointerDown={handleBgPointerDown}
          onPointerMove={handleBgPointerMove}
          onPointerUp={handleBgPointerUp}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: contentRight + 200,
            height: contentBottom + 200,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
            backgroundImage: "radial-gradient(#d6d3d1 1px, transparent 1px)",
            backgroundSize: "16px 16px",
            cursor: activeTool === "select" ? "grab" : activeTool === "text" ? "text" : activeTool === "connect" ? "crosshair" : "crosshair",
          }}
        >
          <ConnectionsOverlay
            connections={connections}
            getAnchor={getAnchor}
            liveLine={connectingFrom && connectingPos ? { from: getAnchor(connectingFrom) || connectingPos, to: connectingPos } : null}
          />

          <VideoOnCanvas
            video={video}
            dataId="video"
            x={videoPos.x}
            y={videoPos.y}
            zoom={zoom}
            onChange={(x, y) => setVideoPos({ x, y })}
            onCapture={addImage}
            onLinkStart={(e) => startConnect(e, "video")}
          />

          {segments.map((seg, i) => (
            <SegmentCard
              key={i}
              segment={seg}
              dataId={`seg-${i}`}
              x={cardPositions[i]?.x ?? 20}
              y={cardPositions[i]?.y ?? i * (DEFAULT_CARD_HEIGHT + CARD_GAP_Y) + 16}
              color={cardPositions[i]?.color ?? null}
              zoom={zoom}
              onChange={(x, y) => updateCardPos(i, x, y)}
              onColorChange={(c) => updateCardColor(i, c)}
              onLinkStart={(e) => startConnect(e, `seg-${i}`)}
            />
          ))}

          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              dataId={note.id}
              zoom={zoom}
              noteLabel={t("noteTitle")}
              onChange={(x, y) => updateNotePos(note.id, x, y)}
              onTextChange={(html) => updateNoteText(note.id, html)}
              onColorChange={(c) => updateNoteColor(note.id, c)}
              onFontSizeChange={(s) => updateNoteFontSize(note.id, s)}
              onDelete={() => deleteNote(note.id)}
              onLinkStart={(e) => startConnect(e, note.id)}
            />
          ))}

          {images.map((im) => (
            <ImageCard
              key={im.id}
              image={im}
              dataId={im.id}
              zoom={zoom}
              onChange={(x, y) => updateImagePos(im.id, x, y)}
              onDelete={() => deleteImage(im.id)}
              onLinkStart={(e) => startConnect(e, im.id)}
            />
          ))}

          {textBoxes.map((box) => (
            <TextBoxCard
              key={box.id}
              box={box}
              dataId={box.id}
              zoom={zoom}
              placeholder={t("textBoxPlaceholder")}
              onChange={(x, y) => updateTextBoxPos(box.id, x, y)}
              onTextChange={(html) => updateTextBoxText(box.id, html)}
              onFontSizeChange={(s) => updateTextBoxFontSize(box.id, s)}
              onDelete={() => deleteTextBox(box.id)}
              onLinkStart={(e) => startConnect(e, box.id)}
            />
          ))}

          <DrawingsOverlay
            drawings={drawings}
            selectedId={activeTool === "select" ? selectedDrawingId : null}
            onSelect={setSelectedDrawingId}
            onDelete={deleteDrawing}
            liveDrawing={liveDrawing}
            deleteLabel={t("toolDeleteDrawing")}
          />
        </div>

        <CanvasToolbar
          tool={activeTool}
          onToolChange={(tl) => {
            setActiveTool(tl);
            setSelectedDrawingId(null);
          }}
          color={drawColor}
          onColorChange={setDrawColor}
          fontSize={defaultFontSize}
          onFontSizeChange={setDefaultFontSize}
          labels={{
            select: t("toolSelect"),
            text: t("toolText"),
            line: t("toolLine"),
            arrow: t("toolArrow"),
            pen: t("toolPen"),
            connect: t("toolConnect"),
            color: t("toolColor"),
            fontSize: t("toolFontSize"),
          }}
        />
        {activeTool === "connect" && (
          <p className="absolute bottom-16 left-1/2 -translate-x-1/2 z-20 text-[11px] text-white bg-stone-800/90 rounded-full px-3 py-1 whitespace-nowrap">
            {t("toolConnectHint")}
          </p>
        )}
      </div>
    </div>
  );
}
