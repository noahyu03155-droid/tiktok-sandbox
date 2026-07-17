"use client";

import { usePathname } from "next/navigation";

// Same 3 routes HeaderBar.tsx already hides itself on. Those pages build
// their own full-bleed layouts (RegisterLanding's floating navbar + edge-to-
// edge dark showcase band, in particular — see src/app/register/page.tsx)
// that would otherwise get squeezed into the app's normal centered
// max-w-6xl/padded column, breaking the full-width design.
const BARE_ROUTES = ["/login", "/register", "/onboarding"];

export default function MainShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = BARE_ROUTES.includes(pathname);
  return <main className={bare ? "" : "max-w-6xl mx-auto px-6 py-8"}>{children}</main>;
}
