// Full FastMoss category-tree scan: walks every node (branch AND leaf —
// not just leaves, since a mid-level category's product_category_id might
// itself be a valid, broader filter that returns results even if none of
// its narrower children individually do) and probes each one via
// categoryHasVideos(). Runs as an in-process background job so the
// triggering HTTP request can return immediately; progress is polled via
// getCategoryScanStatus(). Only one scan can run at a time.
//
// Rate-limit resilience: FastMoss WILL throttle a burst of hundreds of
// sequential probes. A rate-limited node gets retried with backoff rather
// than aborting the whole scan — and a node that still fails after retries
// is left as "unknown" (kept in the tree, not marked dead) rather than
// wrongly treated as having no data. Only nodes we affirmatively confirmed
// return zero results get filtered out downstream.

import { fetchFastMossCategories, categoryHasVideos } from "./fastmoss";
import { setFastmossCategoryValidity } from "./db";

interface CategoryNode {
  c_code: string;
  c_name: string;
  sub?: CategoryNode[];
}

export type CategoryScanStatus = {
  status: "idle" | "running" | "done" | "error";
  total: number;
  tested: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

let scanState: CategoryScanStatus = {
  status: "idle",
  total: 0,
  tested: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

export function getCategoryScanStatus(): CategoryScanStatus {
  return { ...scanState };
}

function flattenTree(nodes: CategoryNode[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  function walk(list: CategoryNode[]) {
    for (const n of list) {
      if (!seen.has(n.c_code)) {
        seen.add(n.c_code);
        out.push({ id: n.c_code, name: n.c_name });
      }
      if (n.sub && n.sub.length > 0) walk(n.sub);
    }
  }
  walk(nodes);
  return out;
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("code 30002") || msg.includes("code 30003");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONCURRENCY = 3;
const MAX_RETRIES = 3;

async function probeWithRetry(id: string): Promise<boolean | null> {
  // Returns true/false if confirmed, null if we couldn't get a confirmed
  // answer even after retries (caller must treat null as "unknown, keep").
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await categoryHasVideos(id);
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        await sleep(1500 * (attempt + 1)); // 1.5s, 3s, 4.5s backoff
        continue;
      }
      console.error(`[fastmossCategoryScan] Probe failed for category ${id} (attempt ${attempt + 1}):`, err);
      return null;
    }
  }
  return null;
}

// Fire-and-forget — the caller (the API route) should call this without
// awaiting it, then let the client poll getCategoryScanStatus() via a
// separate GET route. Returns immediately with true if a scan was actually
// started, false if one was already running (no-op, not an error).
export function startCategoryScan(): boolean {
  if (scanState.status === "running") return false;

  scanState = {
    status: "running",
    total: 0,
    tested: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  (async () => {
    try {
      const raw = (await fetchFastMossCategories()) as CategoryNode[];
      const nodes = flattenTree(raw || []);
      scanState.total = nodes.length;

      const validIds: string[] = [];
      let confirmedTestedCount = 0;
      let cursor = 0;

      async function worker() {
        while (cursor < nodes.length) {
          const node = nodes[cursor++];
          const result = await probeWithRetry(node.id);
          if (result === true) validIds.push(node.id);
          if (result !== null) confirmedTestedCount++;
          scanState.tested++;
        }
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, nodes.length) }, () => worker());
      await Promise.all(workers);

      setFastmossCategoryValidity({
        validIds,
        scannedAt: new Date().toISOString(),
        totalNodes: nodes.length,
        totalTested: confirmedTestedCount,
      });

      scanState = { ...scanState, status: "done", finishedAt: new Date().toISOString() };
    } catch (err: any) {
      console.error("[fastmossCategoryScan] Scan failed:", err);
      scanState = {
        ...scanState,
        status: "error",
        finishedAt: new Date().toISOString(),
        error: err?.message || "Category scan failed",
      };
    }
  })();

  return true;
}
