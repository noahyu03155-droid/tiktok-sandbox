// Shared between StoryboardCanvas.tsx (renders order-number badges) and the
// render route (decides what order to concatenate clips in) — kept in one
// place so the two can't drift apart, same reasoning as trends.ts.

import type { StoryboardNode, CanvasConnection, FunnelStageKey } from "./types";

// Resolves a single shot order from the (possibly messy) connection graph:
// start from a node with no incoming edge (leftmost by x if there's a tie
// or none), then walk forward following the first outgoing edge each step.
// Anything never reached (orphan nodes, unfollowed branches) gets appended
// at the end sorted by x — so the order is always well-defined even if the
// user's wiring isn't a clean single chain.
export function resolveStoryboardOrder(
  nodes: StoryboardNode[],
  connections: Pick<CanvasConnection, "fromId" | "toId">[]
): StoryboardNode[] {
  const hasIncoming = new Set(connections.map((c) => c.toId));
  const outgoing = new Map<string, string[]>();
  for (const c of connections) {
    if (!outgoing.has(c.fromId)) outgoing.set(c.fromId, []);
    outgoing.get(c.fromId)!.push(c.toId);
  }
  const byX = [...nodes].sort((a, b) => a.x - b.x);
  const starts = byX.filter((n) => !hasIncoming.has(n.id));
  const visited = new Set<string>();
  const ordered: StoryboardNode[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  function walk(startId: string) {
    let cur: string | undefined = startId;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const node = byId.get(cur);
      if (node) ordered.push(node);
      const nexts = outgoing.get(cur);
      cur = nexts?.find((id) => !visited.has(id));
    }
  }

  for (const s of starts.length > 0 ? starts : byX) walk(s.id);
  for (const n of byX) if (!visited.has(n.id)) ordered.push(n);
  return ordered;
}

// ---- Stage gate ("must cover all 6 funnel stages, in order") ----
// The canonical funnel order every finished storyboard has to cover before
// the Generate button unlocks. Same FunnelStageKey funnel used by video
// analysis — kept as one source of truth here so the canvas UI and any
// future server-side check can't drift apart.

export const REQUIRED_STAGE_SEQUENCE: FunnelStageKey[] = [
  "reaction",
  "hook",
  "pain_point",
  "product_intro",
  "desired_outcome",
  "cta",
];

export const STAGE_TAG_LABELS: Record<FunnelStageKey, string> = {
  reaction: "Reaction",
  hook: "Hook",
  pain_point: "Pain Point",
  product_intro: "Product Intro",
  desired_outcome: "Desired Outcome",
  cta: "CTA",
};

export interface StageGateResult {
  ok: boolean;
  missing: FunnelStageKey[]; // required stages with no node tagged for them at all
  outOfOrder: boolean; // all present, but not in increasing order along resolveStoryboardOrder
}

// Every required stage must have at least one node tagged with it, and the
// FIRST node carrying each required tag (by resolved shot order) must appear
// in strictly increasing order matching REQUIRED_STAGE_SEQUENCE. Untagged
// nodes can be freely interspersed anywhere — they're simply ignored by this
// check.
export function checkStageGate(
  nodes: StoryboardNode[],
  connections: Pick<CanvasConnection, "fromId" | "toId">[]
): StageGateResult {
  const order = resolveStoryboardOrder(nodes, connections);
  const firstIndexByStage = new Map<FunnelStageKey, number>();
  order.forEach((n, i) => {
    if (n.stageTag && !firstIndexByStage.has(n.stageTag)) firstIndexByStage.set(n.stageTag, i);
  });
  const missing = REQUIRED_STAGE_SEQUENCE.filter((k) => !firstIndexByStage.has(k));
  let outOfOrder = false;
  if (missing.length === 0) {
    let prevIdx = -1;
    for (const key of REQUIRED_STAGE_SEQUENCE) {
      const idx = firstIndexByStage.get(key)!;
      if (idx <= prevIdx) {
        outOfOrder = true;
        break;
      }
      prevIdx = idx;
    }
  }
  return { ok: missing.length === 0 && !outOfOrder, missing, outOfOrder };
}

// ---- Chain tails ("Generate" button anchor point) ----
// The Generate button used to require all 6 funnel stages tagged in order,
// anchored under the CTA card. That was too rigid — this instead anchors
// the button under the END of any connected sequence of cards (a node with
// at least one incoming connection but no outgoing connection), as soon as
// that sequence has at least MIN_CHAIN_LENGTH cards feeding into it. No
// stage tags required at all — this is about connection topology only, so
// completely untagged freeform boards can still render. A board can have
// several independent chains; each qualifying tail gets its own button.

export const MIN_CHAIN_LENGTH_FOR_GENERATE = 3;

export interface ChainTail {
  node: StoryboardNode;
  chainLength: number; // distinct nodes reachable by walking backward (incoming edges) from this tail, inclusive of the tail itself
}

export function resolveChainTails(
  nodes: StoryboardNode[],
  connections: Pick<CanvasConnection, "fromId" | "toId">[]
): ChainTail[] {
  const hasOutgoing = new Set(connections.map((c) => c.fromId));
  const hasIncoming = new Set(connections.map((c) => c.toId));
  const incomingByTo = new Map<string, string[]>();
  for (const c of connections) {
    if (!incomingByTo.has(c.toId)) incomingByTo.set(c.toId, []);
    incomingByTo.get(c.toId)!.push(c.fromId);
  }

  const tails = nodes.filter((n) => hasIncoming.has(n.id) && !hasOutgoing.has(n.id));

  return tails.map((tail) => {
    // BFS over predecessors (handles fan-in/branches without double-counting
    // a node reachable through more than one path, and can't loop forever
    // even if the user wired a cycle, since `seen` blocks revisits).
    const seen = new Set<string>([tail.id]);
    let frontier = [tail.id];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const pred of incomingByTo.get(id) || []) {
          if (!seen.has(pred)) {
            seen.add(pred);
            next.push(pred);
          }
        }
      }
      frontier = next;
    }
    return { node: tail, chainLength: seen.size };
  });
}
