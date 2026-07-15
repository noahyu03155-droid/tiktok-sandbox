export function formatCompactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
}

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Maps a video's status to a translation key (consumed via useLocale().t(...)).
export const STATUS_KEY: Record<string, string> = {
  pending: "statusPending",
  fetching: "statusFetching",
  transcribing: "statusTranscribing",
  analyzing: "statusAnalyzing",
  done: "statusDone",
  error: "statusError",
};
