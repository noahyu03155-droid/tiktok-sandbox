"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import type { CreationProject, UserRole } from "@/lib/types";

interface OwnerSummary {
  ownerId: string;
  username: string;
  projectCount: number;
  lastUpdatedAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

export default function CreationPageContent({
  role,
  myProjects,
  owners,
}: {
  role: UserRole;
  myProjects: CreationProject[];
  owners: OwnerSummary[];
}) {
  const { t } = useLocale();
  const router = useRouter();
  const [projects, setProjects] = useState(myProjects);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/creation/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() || "Untitled project" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create project");
      router.push(`/creation/${data.project.id}`);
    } catch (err: any) {
      setError(err.message || "Failed to create project");
      setCreating(false);
    }
  }

  async function deleteProject(id: string) {
    if (!window.confirm(t("creationConfirmDelete"))) return;
    setProjects((prev) => prev.filter((p) => p.id !== id));
    await fetch(`/api/creation/projects/${id}`, { method: "DELETE" }).catch(() => {});
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900 mb-5">{t("creationHeading")}</h1>

      <div className="flex items-center gap-2 mb-6">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !creating && createProject()}
          placeholder={t("creationNewProjectPlaceholder")}
          className="flex-1 max-w-xs px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
        />
        <button
          onClick={createProject}
          disabled={creating}
          className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium transition-colors shrink-0"
        >
          {creating ? t("creationCreating") : t("creationNewProjectButton")}
        </button>
      </div>
      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      {projects.length === 0 ? (
        <p className="text-sm text-zinc-500 mb-10">{t("creationNoProjects")}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
          {projects.map((p) => (
            <div key={p.id} className="rounded-xl border border-edge bg-panel p-4 hover:border-brand-500 transition-colors">
              <p className="text-sm font-medium text-zinc-900 truncate mb-1">{p.title}</p>
              <p className="text-[11px] text-zinc-500 mb-3">{t("creationUpdatedAt", { date: formatDate(p.updatedAt) })}</p>
              <div className="flex items-center gap-2">
                <Link
                  href={`/creation/${p.id}`}
                  className="text-xs px-3 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white transition-colors"
                >
                  {t("creationOpen")}
                </Link>
                <button
                  onClick={() => deleteProject(p.id)}
                  className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:text-red-500 transition-colors"
                >
                  {t("creationDelete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {role === "admin" && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 mb-3">{t("creationMemberFoldersHeading")}</h2>
          {owners.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("creationMemberFoldersEmpty")}</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {owners.map((o) => (
                <Link
                  key={o.ownerId}
                  href={`/creation/member/${o.ownerId}`}
                  className="rounded-xl border border-edge bg-panel p-4 hover:border-brand-500 transition-colors block"
                >
                  <div className="w-10 h-10 rounded-full bg-panel2 flex items-center justify-center text-zinc-700 text-sm font-semibold mb-3">
                    {o.username.slice(0, 1).toUpperCase()}
                  </div>
                  <p className="text-sm font-medium text-zinc-900 truncate">@{o.username}</p>
                  <p className="text-[11px] text-zinc-500 mt-1">{t("creationProjectCount", { count: o.projectCount })}</p>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
