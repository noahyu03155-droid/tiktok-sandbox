import { fetchAndTranscribe } from "./pipeline";

/**
 * Throttled queue for fetchAndTranscribe. The trends import can enqueue up
 * to ~40 videos (Top 20 views + Top 20 sales, deduped) in a single request.
 * Firing all of those as concurrent `spawn("python3", ...)` child processes
 * at once is what was crashing the dev server (empty 500 response, process
 * restart) — Windows chokes on that many near-simultaneous subprocess
 * spawns. This runs them a few at a time instead so the batch completes
 * reliably; it just takes a bit longer to finish in the background.
 */
const CONCURRENCY = 3;
let active = 0;
const queue: Array<() => void> = [];

function runNext() {
  if (active >= CONCURRENCY) return;
  const job = queue.shift();
  if (!job) return;
  active++;
  job();
}

export function queueFetchAndTranscribe(id: string, url: string) {
  queue.push(() => {
    fetchAndTranscribe(id, url)
      .catch((err) => {
        // fetchAndTranscribe already catches internally and records
        // status:"error" on the video record — this is just an extra
        // safety net so a queue worker can never throw unhandled.
        console.error(`queueFetchAndTranscribe failed for ${id}:`, err);
      })
      .finally(() => {
        active--;
        runNext();
      });
  });
  runNext();
}
