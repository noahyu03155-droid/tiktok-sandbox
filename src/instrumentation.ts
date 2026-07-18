// Next.js App Router server-boot hook (stable since Next 14, no experimental
// flag needed) — register() runs once when the server process starts, in
// every runtime Next.js invokes (nodejs + edge on some platforms). Used here
// purely to kick off the scheduled full-catalog trend refresh (see
// src/lib/fastmossFullRefresh.ts) so it starts checking on a timer without
// needing an external cron service — this app is a single persistent Node
// process on Railway, not serverless, so an in-process setInterval-based
// scheduler is a legitimate/simple fit (no separate infra to set up/pay for).
export async function register() {
  // Guard against the edge runtime invocation (this app doesn't use edge
  // routes, but Next.js may still probe this hook there) — the scheduler
  // touches the filesystem-backed db, which is a Node-only API.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureFullRefreshScheduler } = await import("./lib/fastmossFullRefresh");
  ensureFullRefreshScheduler();
}
