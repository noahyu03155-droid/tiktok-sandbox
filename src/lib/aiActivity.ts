// Global in-process tracker of in-flight Claude/AI work, polled by the
// floating robot assistant so it can show "working" vs "done" across the app.
//
// Stored on globalThis rather than as a plain module variable: in Next.js
// dev (and across route bundles) the same module can be instantiated more
// than once, and separate counters would make the robot miss work started
// from a different bundle.

interface AiActivityState {
  active: number;
  lastFinishedAt: number | null;
}

const g = globalThis as typeof globalThis & { __aiActivity?: AiActivityState };
if (!g.__aiActivity) {
  g.__aiActivity = { active: 0, lastFinishedAt: null };
}
const state = g.__aiActivity;

export function getAiActivity(): AiActivityState {
  return { active: state.active, lastFinishedAt: state.lastFinishedAt };
}

/** Wrap an AI call so the robot widget knows work is in progress. */
export async function trackAiTask<T>(task: () => Promise<T>): Promise<T> {
  state.active += 1;
  try {
    return await task();
  } finally {
    state.active = Math.max(0, state.active - 1);
    state.lastFinishedAt = Date.now();
  }
}
