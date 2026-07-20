"use client";

import { useEffect, useState } from "react";
import type { CreationProject } from "@/lib/types";

// Shared "which canvas project should this go into?" picker — used
// anywhere content is about to be pushed into a Creation project
// (TrendsPageContent.tsx's "Add to Creation", AnalysisTabs.tsx's "Generate
// video — plan the storyboard") so the user always explicitly chooses
// instead of it silently landing in whichever project happened to be most
// recently updated (or a brand-new auto-created one). GET /api/creation/projects
// already scopes the list to the signed-in user's own projects (an admin
// passing ?ownerId= is a different, unrelated code path — not used here),
// so nothing else needs to be filtered client-side.
export default function ProjectPickerModal({
  title = "Add to which canvas project?",
  confirmLabel = "Add here",
  onPick,
  onClose,
}: {
  title?: string;
  confirmLabel?: string;
  onPick: (projectId: string) => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<CreationProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/creation/projects", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const list: CreationProject[] = data.projects || [];
        setProjects(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load your canvas projects — try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createProject() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/creation/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() || "Untitled project" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create project");
      setProjects((prev) => [...(prev || []), data.project]);
      setSelectedId(data.project.id);
      setNewTitle("");
    } catch (e: any) {
      setError(e.message || "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  function confirm() {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    onPick(selectedId);
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-panel rounded-xl border border-edge max-w-md w-full p-5 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-zinc-900 font-semibold">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900 text-sm">
            ✕
          </button>
        </div>

        {error && <p className="text-sm text-red-400 mb-2">{error}</p>}

        <div className="overflow-y-auto flex-1 space-y-1 mb-3 min-h-[80px]">
          {projects === null && !error && <p className="text-sm text-zinc-500">Loading your canvas projects...</p>}
          {projects && projects.length === 0 && (
            <p className="text-sm text-zinc-500">You don't have any canvas projects yet — create one below.</p>
          )}
          {projects?.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedId === p.id ? "bg-brand-500/10 border border-brand-500 text-zinc-900" : "border border-transparent hover:bg-panel2 text-zinc-900"
              }`}
            >
              {p.title}
              <span className="block text-[11px] text-zinc-500">Updated {new Date(p.updatedAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>

        <div className="border-t border-edge pt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createProject();
              }}
              placeholder="New project name..."
              className="flex-1 px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500"
            />
            <button
              onClick={createProject}
              disabled={creating}
              className="px-3 py-2 rounded-lg border border-edge2 text-zinc-700 hover:text-zinc-900 disabled:opacity-40 text-sm font-medium whitespace-nowrap"
            >
              {creating ? "Creating..." : "+ New"}
            </button>
          </div>
          <button
            onClick={confirm}
            disabled={!selectedId || submitting}
            className="w-full py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium"
          >
            {submitting ? "Adding..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
