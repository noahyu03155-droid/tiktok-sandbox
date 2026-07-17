"use client";

// Interactive keyword-graph canvas for the admin-only User Data detail page
// (src/app/user-data/[userId]). The radial layout is still deterministic
// (same polar()/curvePath() math as the old static version), but every node
// can now be dragged to a new position, leaf/custom nodes can be
// re-parented by clicking their connector dot and then another node
// (mirrors StoryboardCanvas's click-to-connect gesture), and admins can add
// their own freeform "custom tag" nodes from the docked top-right form.
// Positions/parents persist per VIEWED user via /api/user-data/[userId]/graph
// (debounced, silent best-effort — much lower stakes than Storyboard's
// retry-banner autosave).

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/translations";
import type { ProfileBranch, ProfileBranchKind } from "@/lib/userGraph";

const BRANCH_COLOR: Record<ProfileBranchKind, string> = {
  category: "#2fb6ea",
  age: "#a78bfa",
  occupation: "#fbbf24",
  interests: "#f472b6",
  experience: "#34d399",
  style: "#fb923c",
  journal: "#5cc4ee",
};

const BRANCH_LABEL_KEY: Record<ProfileBranchKind, TranslationKey> = {
  category: "userDataBranchCategory",
  age: "userDataBranchAge",
  occupation: "userDataBranchOccupation",
  interests: "userDataBranchInterests",
  experience: "userDataBranchExperience",
  style: "userDataBranchStyle",
  journal: "userDataBranchJournal",
};

// Custom (admin-typed) tags get a fixed neutral gray — they're manual
// curation, not one of the specific data kinds above.
const CUSTOM_TAG_COLOR = "#a1a1aa";

// Canvas geometry for the default radial layout — root at center, branch
// nodes on an inner ring, leaf (keyword) nodes on an outer ring, and
// not-yet-attached custom tags on a small ring hugging the root so they're
// visible near center until the admin drags them somewhere.
const CX = 500;
const CY = 400;
const R1 = 170; // center -> branch node
const R2 = 320; // center -> leaf node
const R_CUSTOM = 90; // center -> unplaced custom tag

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;
// Shifts the default world-space center (CX/CY = 500/400) up a bit so it
// sits in the middle of the 640px-tall viewport.
const DEFAULT_PAN = { x: 0, y: -80 };

function polar(r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

// A gently bowed connector rather than a straight line — bows outward
// perpendicular to the line's own direction, so the whole graph reads as
// radiating branches instead of a rigid wheel of spokes.
function curvePath(x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const nx = -dy * 0.15;
  const ny = dx * 0.15;
  return `M ${x1} ${y1} Q ${mx + nx} ${my + ny} ${x2} ${y2}`;
}

function truncate(label: string, max = 22): string {
  return label.length > max ? label.slice(0, max - 1) + "…" : label;
}

function leafWidth(label: string): number {
  return Math.min(220, Math.max(88, label.length * 7 + 28));
}

type CustomTag = { id: string; label: string; createdAt: string };

type GraphNode = {
  id: string; // "root" | "branch:<kind>" | "leaf:<kind>:<index>" | "custom:<tagId>"
  label: string;
  color: string;
  kind: "root" | "branch" | "leaf" | "custom";
  reconnectable: boolean; // false for "root" and "branch" nodes, true for "leaf" and "custom"
  deletable: boolean; // true only for "custom"
  width: number; // pill width (unused for the root circle)
  tagId?: string; // set on "custom" nodes — the CustomTag id behind them
};

export default function UserKeywordGraph({
  userId,
  username,
  branches,
  customTags: initialCustomTags,
  graphPositions,
  graphParentOverrides,
}: {
  userId: string;
  username: string;
  branches: ProfileBranch[];
  customTags: CustomTag[];
  graphPositions: Record<string, { x: number; y: number }>;
  graphParentOverrides: Record<string, string>;
}) {
  const { t } = useLocale();

  const [customTags, setCustomTags] = useState<CustomTag[]>(initialCustomTags);
  // Manually-dragged positions / reassigned parents — seeded from the
  // persisted maps; any node without an entry falls back to the
  // deterministic defaults computed below.
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(graphPositions);
  const [parentOverrides, setParentOverrides] = useState<Record<string, string>>(graphParentOverrides);

  const [pan, setPan] = useState(DEFAULT_PAN);
  const [zoom, setZoom] = useState(1);

  // Click-to-reconnect (mirrors StoryboardCanvas's connStart/connDraft):
  // click a leaf/custom node's connector dot to arm, a dashed line follows
  // the cursor, click any OTHER node to make it the new parent; Escape (or
  // clicking the background / the same dot again) cancels.
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [connDraft, setConnDraft] = useState<{ x: number; y: number } | null>(null);

  const [tagDraft, setTagDraft] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const [addingTag, setAddingTag] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  // ---- node list + deterministic defaults (same radial math as the old
  // static version) ----
  const { nodes, nodeById, defaultPositions, defaultParents } = useMemo(() => {
    const list: GraphNode[] = [];
    const defPos: Record<string, { x: number; y: number }> = {};
    const defParent: Record<string, string> = {};

    const displayName = username.length > 10 ? username.slice(0, 9) + "…" : username;
    list.push({ id: "root", label: displayName, color: "#2fb6ea", kind: "root", reconnectable: false, deletable: false, width: 88 });
    defPos["root"] = { x: CX, y: CY };

    const n = branches.length;
    branches.forEach((branch, i) => {
      // Start straight up (-90deg) and go clockwise so branches fan out
      // evenly regardless of how many are present.
      const branchAngle = -90 + (360 / n) * i;
      const color = BRANCH_COLOR[branch.kind];
      const branchId = `branch:${branch.kind}`;
      list.push({ id: branchId, label: t(BRANCH_LABEL_KEY[branch.kind]), color, kind: "branch", reconnectable: false, deletable: false, width: 120 });
      defPos[branchId] = polar(R1, branchAngle);
      defParent[branchId] = "root";

      const m = branch.values.length;
      // Cap each branch's leaf arc to 80% of its own angular slot so
      // neighboring branches' leaves never overlap.
      const maxArc = (360 / n) * 0.8;
      const arcSpan = m <= 1 ? 0 : Math.min(maxArc, (m - 1) * 18);
      branch.values.forEach((value, j) => {
        const leafId = `leaf:${branch.kind}:${j}`;
        const leafAngle = m <= 1 ? branchAngle : branchAngle - arcSpan / 2 + (arcSpan * j) / (m - 1);
        const label = truncate(value);
        list.push({ id: leafId, label, color, kind: "leaf", reconnectable: true, deletable: false, width: leafWidth(label) });
        defPos[leafId] = polar(R2, leafAngle);
        defParent[leafId] = branchId;
      });
    });

    customTags.forEach((tag, i) => {
      const id = `custom:${tag.id}`;
      const label = truncate(tag.label);
      list.push({ id, label, color: CUSTOM_TAG_COLOR, kind: "custom", reconnectable: true, deletable: true, width: leafWidth(label), tagId: tag.id });
      defPos[id] = polar(R_CUSTOM, -90 + (360 / customTags.length) * i);
      defParent[id] = "root";
    });

    return { nodes: list, nodeById: new Map(list.map((nd) => [nd.id, nd])), defaultPositions: defPos, defaultParents: defParent };
  }, [branches, customTags, username, t]);

  function posOf(nodeId: string): { x: number; y: number } {
    return positions[nodeId] ?? defaultPositions[nodeId] ?? { x: CX, y: CY };
  }

  // Effective parent = override (if it still points at a live node) else
  // the deterministic default. Branch nodes are always children of "root"
  // regardless of overrides (they're not reconnectable, so an override for
  // one shouldn't exist — but stale persisted data must not break drawing).
  function effectiveParentId(nodeId: string): string | null {
    if (nodeId === "root") return null;
    const node = nodeById.get(nodeId);
    if (!node) return null;
    if (node.reconnectable) {
      const o = parentOverrides[nodeId];
      if (o && o !== nodeId && nodeById.has(o)) return o;
    }
    return defaultParents[nodeId] ?? null;
  }

  // ---- autosave (debounced, silent best-effort) ----
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(`/api/user-data/${userId}/graph`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions, parentOverrides }),
      }).catch(() => {});
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, parentOverrides]);

  function toWorld(clientX: number, clientY: number) {
    const rect = viewportRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: (clientX - left - pan.x) / zoom,
      y: (clientY - top - pan.y) / zoom,
    };
  }

  // While a reconnect is armed: dashed draft line follows the cursor,
  // Escape cancels (same listener shape as StoryboardCanvas).
  useEffect(() => {
    if (!reconnectingId) return;
    function onMove(ev: MouseEvent) {
      setConnDraft(toWorld(ev.clientX, ev.clientY));
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setReconnectingId(null);
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
  }, [reconnectingId]);

  // ---- panning the background ----
  function handleBackgroundMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (reconnectingId) {
      setReconnectingId(null);
      setConnDraft(null);
      return;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const originPan = pan;
    function onMove(ev: MouseEvent) {
      setPan({ x: originPan.x + (ev.clientX - startX), y: originPan.y + (ev.clientY - startY) });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function zoomBy(factor: number) {
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
  }

  function resetView() {
    setZoom(1);
    setPan(DEFAULT_PAN);
  }

  // ---- dragging a node (also doubles as the reconnect-completion click
  // target: clicking any node's body while a reconnect is armed reassigns
  // the armed node's parent to the clicked node instead of starting a drag) ----
  function handleNodeMouseDown(e: React.MouseEvent, node: GraphNode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (reconnectingId) {
      if (reconnectingId !== node.id) {
        completeReconnect(reconnectingId, node.id);
      } else {
        setReconnectingId(null);
        setConnDraft(null);
      }
      return;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = posOf(node.id);
    function onMove(ev: MouseEvent) {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      setPositions((prev) => ({ ...prev, [node.id]: { x: origin.x + dx, y: origin.y + dy } }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ---- click-to-reconnect ----
  function handleDotClick(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    if (!reconnectingId) {
      setReconnectingId(nodeId);
      setConnDraft(toWorld(e.clientX, e.clientY));
      return;
    }
    if (reconnectingId === nodeId) {
      // clicked the node's own dot again — cancel
      setReconnectingId(null);
      setConnDraft(null);
      return;
    }
    completeReconnect(reconnectingId, nodeId);
  }

  function completeReconnect(movingId: string, targetId: string) {
    setReconnectingId(null);
    setConnDraft(null);
    if (movingId === targetId) return;
    const moving = nodeById.get(movingId);
    if (!moving || !moving.reconnectable) return;
    if (!nodeById.has(targetId)) return;
    // Reject a target that's a descendant of the node being moved (would
    // create a cycle) — walk up from the target via the CURRENT effective
    // parent chain; visited-set guard in case stale persisted overrides
    // already contain a loop.
    const visited = new Set<string>();
    let cur: string | null = targetId;
    while (cur) {
      if (cur === movingId) return;
      if (visited.has(cur)) break;
      visited.add(cur);
      cur = effectiveParentId(cur);
    }
    setParentOverrides((prev) => ({ ...prev, [movingId]: targetId }));
  }

  // ---- custom tags: add / delete ----
  async function handleAddTag(e: React.FormEvent) {
    e.preventDefault();
    const label = tagDraft.trim();
    if (!label || addingTag) return;
    setAddingTag(true);
    setTagError(null);
    try {
      const res = await fetch(`/api/user-data/${userId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const data = await res.json();
      if (!res.ok || !data.tag) throw new Error(data.error || "Failed");
      setCustomTags((prev) => [...prev, data.tag]);
      setTagDraft("");
    } catch {
      setTagError(t("userDataAddTagFailed"));
    } finally {
      setAddingTag(false);
    }
  }

  async function handleDeleteTag(tagId: string) {
    const nodeId = `custom:${tagId}`;
    try {
      const res = await fetch(`/api/user-data/${userId}/tags/${tagId}`, { method: "DELETE" });
      if (!res.ok) return;
      setCustomTags((prev) => prev.filter((tag) => tag.id !== tagId));
      // Drop the deleted node's own entries from the local maps too — the
      // server already removed them, and the graph PATCH route merges, so
      // leaving them here would resurrect them on the next autosave.
      setPositions((prev) => {
        if (!(nodeId in prev)) return prev;
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      setParentOverrides((prev) => {
        if (!(nodeId in prev)) return prev;
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      if (reconnectingId === nodeId) {
        setReconnectingId(null);
        setConnDraft(null);
      }
    } catch {
      // silent best-effort — the tag simply stays until a retry works.
    }
  }

  const rootNode = nodeById.get("root")!;
  const rootPos = posOf("root");
  const isEmpty = branches.length === 0 && customTags.length === 0;

  return (
    <div
      ref={viewportRef}
      onMouseDown={handleBackgroundMouseDown}
      className="relative h-[640px] rounded-xl border border-edge bg-panel overflow-hidden cursor-grab active:cursor-grabbing select-none"
      style={{
        backgroundImage: "radial-gradient(circle, #d4d4d8 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
    >
      {/* zoom / view toolbar, docked top-left */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
        <button
          onClick={() => zoomBy(1.2)}
          className="w-7 h-7 rounded border border-edge bg-panel shadow-sm text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-sm"
        >
          +
        </button>
        <button
          onClick={() => zoomBy(1 / 1.2)}
          className="w-7 h-7 rounded border border-edge bg-panel shadow-sm text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-sm"
        >
          −
        </button>
        <button
          onClick={resetView}
          className="px-2 h-7 rounded border border-edge bg-panel shadow-sm text-zinc-600 hover:text-zinc-900 hover:border-edge2 text-xs"
        >
          {t("userDataResetView")}
        </button>
      </div>

      {/* add-tag form, docked top-right */}
      <div className="absolute top-3 right-3 z-10" onMouseDown={(e) => e.stopPropagation()}>
        <form onSubmit={handleAddTag} className="bg-panel border border-edge rounded-lg shadow-sm px-2 py-1.5 flex items-center gap-1.5">
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            placeholder={t("userDataAddTagPlaceholder")}
            className="w-40 h-6 px-2 rounded bg-panel2 border border-edge text-xs text-zinc-900 outline-none focus:border-brand-500 placeholder:text-zinc-400"
          />
          <button
            type="submit"
            disabled={!tagDraft.trim() || addingTag}
            className="h-6 px-2 rounded bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs font-medium shrink-0"
          >
            + {t("userDataAddTagButton")}
          </button>
        </form>
        {tagError && <p className="text-[10px] text-red-500 mt-1 text-right">{tagError}</p>}
      </div>

      {isEmpty && (
        <p className="absolute bottom-3 left-3 right-3 z-10 text-xs text-zinc-500 text-center pointer-events-none">
          {t("userDataNoProfile")}
        </p>
      )}

      {/* pannable/zoomable world */}
      <div
        className="absolute top-0 left-0"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
      >
        <svg className="absolute top-0 left-0 overflow-visible" width={1} height={1}>
          {/* edges: each non-root node's curve from its EFFECTIVE parent's
              current position to its own — dragging either end updates the
              bow live */}
          {nodes.map((node) => {
            if (node.id === "root") return null;
            const parentId = effectiveParentId(node.id);
            if (!parentId) return null;
            const p = posOf(node.id);
            const pp = posOf(parentId);
            return (
              <path
                key={`edge-${node.id}`}
                d={curvePath(pp.x, pp.y, p.x, p.y)}
                fill="none"
                stroke={node.color}
                strokeWidth={1.5}
                opacity={0.45}
                pointerEvents="none"
              />
            );
          })}

          {/* dashed draft line while a reconnect is armed */}
          {reconnectingId &&
            connDraft &&
            (() => {
              const from = posOf(reconnectingId);
              return (
                <path
                  d={`M ${from.x} ${from.y} L ${connDraft.x} ${connDraft.y}`}
                  fill="none"
                  stroke="#5cc4ee"
                  strokeDasharray="6 5"
                  strokeWidth={2}
                  pointerEvents="none"
                />
              );
            })()}

          {/* root */}
          <g
            transform={`translate(${rootPos.x} ${rootPos.y})`}
            onMouseDown={(e) => handleNodeMouseDown(e, rootNode)}
            style={{ cursor: "move" }}
          >
            <circle r={44} fill="#2fb6ea" />
            <text y={5} textAnchor="middle" fontSize={13} fontWeight={600} fill="#18181b">
              {rootNode.label}
            </text>
          </g>

          {/* branch nodes (fixed to root, no connector dot) */}
          {nodes
            .filter((node) => node.kind === "branch")
            .map((node) => {
              const p = posOf(node.id);
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x} ${p.y})`}
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  style={{ cursor: "move" }}
                >
                  <rect x={-60} y={-16} width={120} height={32} rx={16} fill="#ffffff" stroke={node.color} strokeWidth={1.5} />
                  <text y={4} textAnchor="middle" fontSize={11} fontWeight={600} fill="#18181b">
                    {node.label}
                  </text>
                </g>
              );
            })}

          {/* leaf + custom nodes (draggable, reconnectable; custom also deletable) */}
          {nodes
            .filter((node) => node.kind === "leaf" || node.kind === "custom")
            .map((node) => {
              const p = posOf(node.id);
              const w = node.width;
              const armed = reconnectingId === node.id;
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x} ${p.y})`}
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  style={{ cursor: "move" }}
                >
                  <rect x={-w / 2} y={-13} width={w} height={26} rx={13} fill="#ffffff" stroke={node.color} strokeWidth={1} />
                  <text y={4} textAnchor="middle" fontSize={10} fill="#18181b">
                    {node.label}
                  </text>
                  <title>{node.label}</title>

                  {/* connector dot — click to arm a re-parent, then click the
                      new parent node (Esc cancels) */}
                  <circle
                    cx={w / 2}
                    cy={0}
                    r={5.5}
                    fill={node.color}
                    stroke={armed ? "#18181b" : "#ffffff"}
                    strokeWidth={2}
                    className={armed ? "animate-pulse" : ""}
                    style={{ cursor: "pointer" }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => handleDotClick(e, node.id)}
                  />

                  {/* delete ✕ — custom tags only */}
                  {node.deletable && node.tagId && (
                    <g
                      style={{ cursor: "pointer" }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteTag(node.tagId!);
                      }}
                    >
                      <circle cx={w / 2} cy={-15} r={7} fill="#ffffff" stroke="#d4d4d8" strokeWidth={1} />
                      <text x={w / 2} y={-12} textAnchor="middle" fontSize={9} fill="#52525b">
                        ✕
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
        </svg>
      </div>
    </div>
  );
}
