"use client";

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
};

const BRANCH_LABEL_KEY: Record<ProfileBranchKind, TranslationKey> = {
  category: "userDataBranchCategory",
  age: "userDataBranchAge",
  occupation: "userDataBranchOccupation",
  interests: "userDataBranchInterests",
  experience: "userDataBranchExperience",
  style: "userDataBranchStyle",
};

// Canvas geometry for the radial layout — root at center, branch nodes on
// an inner ring, leaf (keyword) nodes on an outer ring.
const WIDTH = 1000;
const HEIGHT = 800;
const CX = 500;
const CY = 400;
const R1 = 170; // center -> branch node
const R2 = 320; // center -> leaf node

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

export default function UserKeywordGraph({ username, branches }: { username: string; branches: ProfileBranch[] }) {
  const { t } = useLocale();
  const n = branches.length;

  if (n === 0) {
    return <p className="text-sm text-zinc-500 py-12 text-center">{t("userDataNoProfile")}</p>;
  }

  const edges: { d: string; color: string }[] = [];
  const branchNodes: { x: number; y: number; label: string; color: string }[] = [];
  const leafNodes: { x: number; y: number; label: string; color: string; width: number }[] = [];

  branches.forEach((branch, i) => {
    // Start straight up (-90deg) and go clockwise so branches fan out
    // evenly regardless of how many are present.
    const branchAngle = -90 + (360 / n) * i;
    const color = BRANCH_COLOR[branch.kind];
    const bp = polar(R1, branchAngle);
    branchNodes.push({ x: bp.x, y: bp.y, label: t(BRANCH_LABEL_KEY[branch.kind]), color });
    edges.push({ d: curvePath(CX, CY, bp.x, bp.y), color });

    const m = branch.values.length;
    // Cap each branch's leaf arc to 80% of its own angular slot so
    // neighboring branches' leaves never overlap.
    const maxArc = (360 / n) * 0.8;
    const arcSpan = m <= 1 ? 0 : Math.min(maxArc, (m - 1) * 18);
    branch.values.forEach((value, j) => {
      const leafAngle = m <= 1 ? branchAngle : branchAngle - arcSpan / 2 + (arcSpan * j) / (m - 1);
      const lp = polar(R2, leafAngle);
      const label = truncate(value);
      leafNodes.push({ x: lp.x, y: lp.y, label, color, width: leafWidth(label) });
      edges.push({ d: curvePath(bp.x, bp.y, lp.x, lp.y), color });
    });
  });

  const displayName = username.length > 10 ? username.slice(0, 9) + "…" : username;

  return (
    <div className="overflow-auto rounded-xl border border-edge bg-panel">
      <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {edges.map((e, i) => (
          <path key={`edge-${i}`} d={e.d} fill="none" stroke={e.color} strokeWidth={1.5} opacity={0.45} />
        ))}

        <circle cx={CX} cy={CY} r={44} fill="#2fb6ea" />
        <text x={CX} y={CY + 5} textAnchor="middle" fontSize={13} fontWeight={600} fill="#0a0a0b">
          {displayName}
        </text>

        {branchNodes.map((b, i) => (
          <g key={`branch-${i}`}>
            <rect x={b.x - 60} y={b.y - 16} width={120} height={32} rx={16} fill="#161618" stroke={b.color} strokeWidth={1.5} />
            <text x={b.x} y={b.y + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill={b.color}>
              {b.label}
            </text>
          </g>
        ))}

        {leafNodes.map((l, i) => (
          <g key={`leaf-${i}`}>
            <rect
              x={l.x - l.width / 2}
              y={l.y - 13}
              width={l.width}
              height={26}
              rx={13}
              fill="#1f1f22"
              stroke={l.color}
              strokeWidth={1}
              opacity={0.9}
            />
            <text x={l.x} y={l.y + 4} textAnchor="middle" fontSize={10} fill="#e4e4e7">
              {l.label}
            </text>
            <title>{l.label}</title>
          </g>
        ))}
      </svg>
    </div>
  );
}
