"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import Logo from "./Logo";
import LanguageToggle from "./LanguageToggle";
import LogoutButton from "./LogoutButton";

export default function HeaderBar() {
  const { t } = useLocale();
  const pathname = usePathname();

  if (pathname === "/login" || pathname === "/register") return null;

  const navItems = [
    { href: "/", label: t("navVideoAnalysis") },
    { href: "/trends", label: t("navTrendAnalysis") },
    { href: "/creators", label: t("navCreatorTracker") },
    { href: "/creation", label: t("navCreation") },
  ];

  return (
    <header className="border-b border-edge bg-ink/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>
        <p className="text-xs text-zinc-500 leading-tight ml-1 mr-2 hidden sm:block">{t("appTagline")}</p>
        <nav className="flex items-center gap-1 ml-2">
          {navItems.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
                  active ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-white"
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
