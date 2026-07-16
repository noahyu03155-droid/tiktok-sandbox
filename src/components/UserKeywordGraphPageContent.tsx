"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import UserKeywordGraph from "./UserKeywordGraph";
import type { ProfileBranch } from "@/lib/userGraph";

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

export default function UserKeywordGraphPageContent({
  username,
  joinedAt,
  projectCount,
  lastActiveAt,
  branches,
}: {
  username: string;
  joinedAt: string;
  projectCount: number;
  lastActiveAt: string | null;
  branches: ProfileBranch[];
}) {
  const { t } = useLocale();
  return (
    <div>
      <Link href="/user-data" className="text-xs text-zinc-500 hover:text-zinc-300 mb-4 inline-block">
        {t("userDataBackToList")}
      </Link>
      <h1 className="text-xl font-semibold text-white mb-1">@{username}</h1>
      <p className="text-xs text-zinc-500 mb-6">
        {t("userDataJoinedAt", { date: formatDate(joinedAt) })}
        {" · "}
        {t("userDataProjectCount", { count: projectCount })}
        {lastActiveAt && (
          <>
            {" · "}
            {t("userDataLastActive", { date: formatDate(lastActiveAt) })}
          </>
        )}
      </p>
      <UserKeywordGraph username={username} branches={branches} />
    </div>
  );
}
