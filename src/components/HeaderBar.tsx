"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import type { UserRole } from "@/lib/types";
import Logo from "./Logo";
import LanguageToggle from "./LanguageToggle";
import LogoutButton from "./LogoutButton";

export default function HeaderBar({ role = null }: { role?: UserRole | null }) {
  const { t } = useLocale();
  const pathname = usePathname();

  if (pathname === "/login" || pathname === "/register" || pathname === "/onboarding") return null;

  const navItems = [
    { href: "/", label: t("navVideoAnalysis") },
    { href: "/trends", label: t("navTrendAnalysis") },
    { href: "/creators", label: t("navCreatorTracker") },
    { href: "/creation", label: t("navCreation") },
    ...(role === "admin" ? [{ href: "/user-data", label: t("navUserData") }] : []),
  ];

  return (
    // Phase 39: thicker black bottom border + a black-outlined (not just
    // gray-filled) pill nav track, matching the bolder/"framed" chrome the
    // user liked on the register page (image2 in chat) — this header shows
    // on every logged-in page, so it's the single highest-leverage place to
    // carry that look across the whole app without redesigning every
    // individual page's internals.
    <header className="border-b-2 border-zinc-900 bg-ink sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>
        <p className="text-xs text-zinc-500 leading-tight mr-2 hidden lg:block">{t("appTagline")}</p>
        {/* Pill/capsule nav, matching the reference design — a rounded-full
            track holding rounded-full items, the active one filled solid
            black with white text, inactive ones plain dark-gray text. */}
        <nav className="flex items-center gap-0.5 bg-white border-2 border-zinc-900 rounded-full p-1 ml-1">
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
