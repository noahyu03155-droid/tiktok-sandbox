"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLocale } from "@/lib/i18n";

export default function LogoutButton() {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useLocale();

  if (pathname === "/login") return null;

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      className="text-xs text-zinc-500 hover:text-zinc-900 border border-edge rounded-full px-3 py-1.5 transition-colors"
    >
      {t("logout")}
    </button>
  );
}
