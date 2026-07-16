"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import type { CreationProject } from "@/lib/types";

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

export default function CreationMemberProjectsContent({
  username,
  projects,
}: {
  username: string;
  projects: CreationProject[];
}) {
  const { t } = useLocale();
  const [list, setList] = useState(projects);

  async function deleteProject(id: string) {
    if (!window.confirm(t("creationConfirmDelete"))) return;
    setList((prev) => prev.filter((p) => p.id !== id));
    await fetch(`/api/creation/projects/${id}`, { method: "DELETE" }).catch(() => {});
  }

  return (
    <div>
      <Link href="/creation" className="text-xs text-zinc-500 hover:text-zinc-900 transition-colors">
        {t("creationBackToOwners")}
      </Link>
      <h1 className="text-xl font-semibold text-zinc-900 mt-3 mb-5">@{username}</h1>

      {list.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("creationMemberProjectsEmpty")}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map((p) => (
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
    </div>
  );
}
