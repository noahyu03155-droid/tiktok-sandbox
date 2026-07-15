// Shared between StoryboardCanvas.tsx (renders order-number badges) and the
// render route (decides what order to concatenate clips in) — kept in one
// place so the two can't drift apart, same reasoning as trends.ts.

import type { StoryboardNode, CanvasConnection } from "./types";

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
