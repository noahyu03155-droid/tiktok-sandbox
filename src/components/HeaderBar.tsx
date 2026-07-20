"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import type { AccessTier, UserRole } from "@/lib/types";
import { canSeeTab } from "@/lib/accessTier";
import Logo from "./Logo";
import LanguageToggle from "./LanguageToggle";
import LogoutButton from "./LogoutButton";

export default function HeaderBar({
  role = null,
  accessTier = null,
}: {
  role?: UserRole | null;
  // Feature-visibility tier (business/vip/admin-tag) — see src/lib/accessTier.ts.
  // Only meaningful for role:"member"; a real admin bypasses it entirely.
  accessTier?: AccessTier | null;
}) {
  const { t } = useLocale();
  const pathname = usePathname();

  if (pathname === "/login" || pathname === "/register" || pathname === "/onboarding" || pathname === "/pricing") return null;

  const isSuperAdmin = role === "admin";
  // Built as a plain push list (rather than filter/concat on object
  // literals) purely to keep the item shape trivial to type — see
  // src/lib/accessTier.ts for what canSeeTab actually gates.
  const navItems: { href: string; label: string }[] = [];
  if (canSeeTab("video", isSuperAdmin, accessTier)) navItems.push({ href: "/", label: t("navVideoAnalysis") });
  if (canSeeTab("trends", isSuperAdmin, accessTier)) navItems.push({ href: "/trends", label: t("navTrendAnalysis") });
  if (canSeeTab("creators", isSuperAdmin, accessTier)) navItems.push({ href: "/creators", label: t("navCreatorTracker") });
  if (canSeeTab("creation", isSuperAdmin, accessTier)) navItems.push({ href: "/creation", label: t("navCreation") });
  // Favorites is personal, not a feature tier — always visible to any
  // signed-in member, unlike the tabs above which are gated by canSeeTab.
  navItems.push({ href: "/favorites", label: t("navFavorites") });
  if (isSuperAdmin) navItems.push({ href: "/user-data", label: t("navUserData") });

  return (
    // Phase 41: reverted Phase 39's thick black border/outlined nav pill —
    // the newer reference (Packify.ai) uses a plain, borderless white
    // navbar, so this went back to a thin subtle border for consistency.
    <header className="border-b border-edge bg-ink/90 backdrop-blur sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>
        <p className="text-xs text-zinc-500 leading-tight mr-2 hidden lg:block">{t("appTagline")}</p>
        {/* Pill/capsule nav, matching the reference design — a rounded-full
            track holding rounded-full items, the active one filled solid
            black with white text, inactive ones plain dark-gray text. */}
        <nav className="flex items-center gap-0.5 bg-zinc-100 rounded-full p-1 ml-1">
          {navItems.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm px-3.5 py-1.5 rounded-full transition-colors whitespace-nowrap ${
                  active ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LanguageToggle />
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
