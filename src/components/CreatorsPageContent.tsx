"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import { formatCompactNumber } from "@/lib/format";
import type { TrackedCreator } from "@/lib/types";

interface EnrichedCreator extends TrackedCreator {
  videos_7d: number;
  products_7d: number;
  archived_count: number;
}

type SortMode = "recent" | "7d" | "az";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function CreatorCard({
  creator,
  onDelete,
  selectMode,
  selected,
  onToggleSelect,
}: {
  creator: EnrichedCreator;
  onDelete: (id: string) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const { t } = useLocale();
  const isBusy = creator.status === "pending" || creator.status === "scanning";

  const inner = (
    <>
      <div className="flex items-center gap-3 pr-6">
        {creator.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={creator.avatar_url} alt={creator.handle} className="w-10 h-10 rounded-full object-cover border border-edge shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-panel2 shrink-0" />
        )}
        <p className="text-sm font-medium text-zinc-900 truncate">@{creator.handle}</p>
      </div>

      {isBusy ? (
        <p className="mt-4 text-xs text-brand-400 animate-pulse">
          {t(creator.status === "scanning" ? "creatorStatusScanning" : "creatorStatusPending")}
        </p>
      ) : creator.status === "error" ? (
        <p className="mt-4 text-xs text-red-400">{t("creatorStatusErrorBadge")}</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 mt-4 text-center">
          <div>
            <p className="text-xl font-semibold text-zinc-900">{creator.videos_7d}</p>
            <p className="text-[10px] text-zinc-500 mt-0.5 uppercase tracking-wide">{t("creatorVideos7d")}</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-zinc-900">{creator.products_7d}</p>
            <p className="text-[10px] text-zinc-500 mt-0.5 uppercase tracking-wide">{t("creatorProducts7d")}</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-zinc-900">{formatCompactNumber(creator.archived_count)}</p>
            <p className="text-[10px] text-zinc-500 mt-0.5 uppercase tracking-wide">{t("creatorArchived")}</p>
          </div>
        </div>
      )}

      <p className="text-[11px] text-zinc-500 mt-3">
        {t("creatorLastUpdated", { date: formatDate(creator.last_scanned_at) })}
      </p>
    </>
  );

  return (
    <div
      className={`relative rounded-xl border bg-panel p-4 transition-colors ${
        selectMode && selected ? "border-brand-500" : "border-edge hover:border-brand-500"
      }`}
    >
      {selectMode ? (
        <div
          className={`absolute top-3 right-3 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
            selected ? "bg-brand-500 border-brand-500" : "bg-black/50 border-zinc-400"
          }`}
        >
          {selected && <span className="text-white text-[10px] leading-none">✓</span>}
        </div>
      ) : (
        <button
          onClick={(e) => {
            e.preventDefault();
            onDelete(creator.id);
          }}
          title={t("creatorDeleteButton")}
          className="absolute top-3 right-3 text-zinc-600 hover:text-red-400 text-sm"
        >
          ✕
        </button>
      )}
      {selectMode ? (
        <div className="block cursor-pointer" onClick={() => onToggleSelect(creator.id)}>
          {inner}
        </div>
      ) : (
        <Link href={`/creators/${creator.id}`} className="block">
          {inner}
        </Link>
      )}
    </div>
  );
}

export default function CreatorsPageContent() {
  const { t } = useLocale();
  const [creators, setCreators] = useState<EnrichedCreator[] | null>(null);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sort, setSort] = useState<SortMode>("recent");
  const [showTrackModal, setShowTrackModal] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    const res = await fetch("/api/creators", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setCreators(data.creators);
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const hasBusy = (creators || []).some((c) => c.status === "pending" || c.status === "scanning");
    if (hasBusy) {
      timerRef.current = setInterval(load, 4000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creators]);

  async function handleTrack(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/creators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: input.trim() }),
      });
      if (res.ok) {
        setInput("");
        setShowTrackModal(true);
        load();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("creatorDeleteConfirm"))) return;
    const res = await fetch(`/api/creators/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(t("deleteSelectedConfirm", { count: selected.size }))) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/creators", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (res.ok) {
        await load();
        exitSelectMode();
      }
    } finally {
      setDeleting(false);
    }
  }

  function handleSelectAll() {
    setSelected(new Set(sorted.map((c) => c.id)));
  }

  const sorted = useMemo(() => {
    if (!creators) return [];
    const copy = [...creators];
    if (sort === "recent") {
      copy.sort((a, b) => new Date(b.last_scanned_at || b.created_at).getTime() - new Date(a.last_scanned_at || a.created_at).getTime());
    } else if (sort === "7d") {
      copy.sort((a, b) => b.videos_7d - a.videos_7d);
    } else {
      copy.sort((a, b) => a.handle.localeCompare(b.handle));
    }
    return copy;
  }, [creators, sort]);

  const SORTS: { key: SortMode; label: string }[] = [
    { key: "recent", label: t("creatorSortRecent") },
    { key: "7d", label: t("creatorSort7d") },
    { key: "az", label: t("creatorSortAZ") },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-zinc-900 mb-1">{t("creatorPageHeading")}</h2>
        <p className="text-sm text-zinc-500">{t("creatorPageSubheading")}</p>
      </div>

      <form onSubmit={handleTrack} className="flex gap-2 max-w-xl">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("creatorTrackPlaceholder")}
          className="flex-1 bg-panel border border-edge rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 outline-none focus:border-brand-500"
        />
        <button
          type="submit"
          disabled={submitting || !input.trim()}
          className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium whitespace-nowrap"
        >
          {submitting ? "..." : t("creatorTrackButton")}
        </button>
      </form>

      <div className="flex items-center justify-between gap-4 flex-wrap border-t border-edge pt-4">
        <p className="text-sm text-zinc-500">{t("creatorTrackedCount", { count: creators?.length ?? 0 })}</p>
        <div className="flex items-center gap-2 flex-wrap">
          {selectMode && (
            <>
              <button onClick={handleSelectAll} className="text-xs text-zinc-500 hover:text-zinc-900 rounded-lg px-2 py-1.5">
                {t("selectAll")}
              </button>
              <span className="text-xs text-zinc-500">{t("selectedCount", { count: selected.size })}</span>
              {selected.size > 0 && (
                <button
                  onClick={handleDeleteSelected}
                  disabled={deleting}
                  className="text-xs text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg px-3 py-1.5"
                >
                  {deleting ? "..." : t("deleteSelected")}
                </button>
              )}
            </>
          )}
          {sorted.length > 0 && (
            <button
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`text-xs rounded-lg px-3 py-1.5 border whitespace-nowrap ${
                selectMode ? "bg-zinc-900 text-white border-zinc-900" : "text-zinc-500 hover:text-zinc-900 border-edge"
              }`}
            >
              {selectMode ? t("selectModeExit") : t("selectMode")}
            </button>
          )}
          <div className="flex items-center gap-1 bg-panel border border-edge rounded-lg p-1">
            {SORTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                  sort === s.key ? "bg-brand-500 text-white" : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {sorted.length === 0 && creators !== null && (
        <div className="text-center py-24 text-zinc-500 text-sm">{t("creatorEmptyState")}</div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {sorted.map((c) => (
          <CreatorCard
            key={c.id}
            creator={c}
            onDelete={handleDelete}
            selectMode={selectMode}
            selected={selected.has(c.id)}
            onToggleSelect={toggleSelect}
          />
        ))}
      </div>

      {showTrackModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-panel rounded-xl border border-edge max-w-md w-full p-6">
            <h3 className="text-zinc-900 font-semibold mb-2">{t("creatorTrackModalTitle")}</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">{t("creatorTrackModalBody")}</p>
            <button
              onClick={() => setShowTrackModal(false)}
              className="mt-5 w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
            >
              {t("creatorTrackModalClose")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
