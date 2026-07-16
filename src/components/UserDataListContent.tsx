"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n";

interface MemberSummary {
  id: string;
  username: string;
  createdAt: string;
  hasProfile: boolean;
  preferredCategoryLabel: string | null;
}

// Admin-only grid of every member account — mirrors the styling of the
// existing member-folders grid on /creation (src/components/CreationPageContent.tsx)
// for visual consistency, but links into /user-data/[id]'s keyword graph
// instead of a project list.
export default function UserDataListContent({ members }: { members: MemberSummary[] }) {
  const { t } = useLocale();
  return (
    <div>
      <h1 className="text-xl font-semibold text-white mb-1">{t("userDataHeading")}</h1>
      <p className="text-sm text-zinc-500 mb-6">{t("userDataHeadingHint")}</p>
      {members.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("userDataEmpty")}</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {members.map((m) => (
            <Link
              key={m.id}
              href={`/user-data/${m.id}`}
              className="rounded-xl border border-edge bg-panel p-4 hover:border-brand-500 transition-colors block"
            >
              <div className="w-10 h-10 rounded-full bg-panel2 flex items-center justify-center text-zinc-300 text-sm font-semibold mb-3">
                {m.username.slice(0, 1).toUpperCase()}
              </div>
              <p className="text-sm font-medium text-zinc-100 truncate">@{m.username}</p>
              {m.preferredCategoryLabel && (
                <p className="text-[11px] text-zinc-500 mt-1 truncate">{m.preferredCategoryLabel}</p>
              )}
              <p className={`text-[11px] mt-1 ${m.hasProfile ? "text-emerald-400" : "text-zinc-600"}`}>
                {m.hasProfile ? t("userDataProfileComplete") : t("userDataProfileIncomplete")}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
