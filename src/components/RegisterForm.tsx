"use client";

// Pulled out of src/app/register/page.tsx unchanged (same fields, same
// /api/register call, same post-submit redirect to /onboarding) so that
// page could become a server component (needed to fetch real showcase
// thumbnails for RegisterLanding.tsx) while this — the actually interactive,
// localized part — stays a client component.
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import Logo from "@/components/Logo";

// FastMoss category tree node, as returned by /api/trends/fastmoss-categories
// (up to 3 levels deep; leaf nodes omit `sub`). Same shape/flatten pattern as
// the picker on the Trend Analysis page (src/components/TrendsPageContent.tsx).
interface CategoryNode {
  c_code: string;
  c_name: string;
  sub?: CategoryNode[];
}

export default function RegisterForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useLocale();

  // Optional category picker — the endpoint is public (see middleware.ts)
  // precisely so this can load before the user has an account. If it fails
  // for any reason we simply hide the picker; registration must never be
  // blocked by it.
  const [categories, setCategories] = useState<CategoryNode[] | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<{ id: string; label: string } | null>(null);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const categoryDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/trends/fastmoss-categories")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setCategoriesError(data.error);
          return;
        }
        setCategories(data.categories || []);
      })
      .catch(() => setCategoriesError("Failed to load categories"));
  }, []);

  // Close the category dropdown on any click outside it.
  useEffect(() => {
    if (!categoryDropdownOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!categoryDropdownRef.current?.contains(e.target as Node)) {
        setCategoryDropdownOpen(false);
      }
    }
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [categoryDropdownOpen]);

  // Registration is meant to be a quick, low-friction pick of a broad
  // interest area — not the fine-grained 3-level drill-down the Trend
  // Analysis page's own category picker offers. So this only surfaces the
  // top two tree levels (major category, and its direct sub-groups, e.g.
  // "Pet Supplies" and "Pet Supplies › Dog & Cat Food") and deliberately
  // drops the noisiest, most granular 3rd level (e.g. "...› Vitamins &
  // Supplements") entirely.
  const flatCategories = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    if (categories) {
      for (const l1 of categories) {
        out.push({ id: l1.c_code, label: l1.c_name });
        for (const l2 of l1.sub || []) {
          out.push({ id: l2.c_code, label: `${l1.c_name} › ${l2.c_name}` });
        }
      }
    }
    return out;
  }, [categories]);

  const filteredCategories = useMemo(() => {
    const q = categoryQuery.trim().toLowerCase();
    if (!q) return flatCategories.slice(0, 50); // cap the no-query list so it isn't 1000s of DOM nodes
    return flatCategories.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 50);
  }, [flatCategories, categoryQuery]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          categoryId: selectedCategory?.id ?? null,
          categoryLabel: selectedCategory?.label ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");
      const next = searchParams.get("next") || "/";
      // New accounts get a short 5-question profile prompt right after
      // registering (see /onboarding) — that page's own submit/skip both
      // forward to this same `next` destination afterward (and call
      // router.refresh() themselves once they do).
      router.push(`/onboarding?next=${encodeURIComponent(next)}`);
    } catch (err: any) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-sm bg-panel border border-edge rounded-2xl shadow-xl shadow-zinc-900/5 p-6"
    >
      <div className="mb-6">
        <Logo />
        <p className="text-xs text-zinc-500 mt-2">{t("registerTitle")}</p>
      </div>
      <label className="block text-xs text-zinc-500 mb-1">{t("usernameLabel")}</label>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full mb-1 px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
        autoFocus
      />
      <p className="text-[11px] text-zinc-600 mb-3">{t("usernameHint")}</p>
      <label className="block text-xs text-zinc-500 mb-1">{t("passwordLabel")}</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full mb-4 px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
      />

      {/* Optional category picker — hidden entirely if the category list
          couldn't load (this field must never block registration). */}
      {!categoriesError && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-zinc-500">{t("registerCategoryLabel")}</label>
            {selectedCategory && (
              <button
                type="button"
                onClick={() => setSelectedCategory(null)}
                className="text-[11px] text-zinc-500 hover:text-zinc-700 underline underline-offset-2"
              >
                {t("registerCategoryClear")}
              </button>
            )}
          </div>
          <div className="relative" ref={categoryDropdownRef}>
            <button
              type="button"
              onClick={() => setCategoryDropdownOpen((v) => !v)}
              className="w-full text-left px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm outline-none hover:border-brand-500 truncate"
              title={selectedCategory?.label || t("trendCategoryPlaceholder")}
            >
              <span className={selectedCategory ? "text-zinc-900" : "text-zinc-500"}>
                {selectedCategory ? selectedCategory.label : t("trendCategoryPlaceholder")}
              </span>
            </button>
            {categoryDropdownOpen && (
              <div className="absolute z-20 top-full left-0 mt-1 w-full rounded-lg border border-edge bg-panel shadow-xl p-2">
                <input
                  autoFocus
                  value={categoryQuery}
                  onChange={(e) => setCategoryQuery(e.target.value)}
                  placeholder={t("trendCategorySearchPlaceholder")}
                  className="w-full px-2 py-1.5 rounded bg-panel2 border border-edge text-xs text-zinc-900 outline-none focus:border-brand-500 mb-2"
                />
                <div className="max-h-64 overflow-y-auto space-y-0.5">
                  {filteredCategories.length === 0 && (
                    <p className="text-[11px] text-zinc-500 px-1 py-2">{t("trendCategoryNoMatches")}</p>
                  )}
                  {filteredCategories.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => {
                        setSelectedCategory(c);
                        setCategoryDropdownOpen(false);
                        setCategoryQuery("");
                      }}
                      className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-600 hover:bg-panel2 hover:text-zinc-900 truncate"
                      title={c.label}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-[11px] text-zinc-600 mt-1">{t("registerCategoryHint")}</p>
        </div>
      )}

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
      >
        {loading ? t("registering") : t("registerButton")}
      </button>
      <p className="text-xs text-zinc-500 mt-4 text-center">
        {t("alreadyHaveAccount")}{" "}
        <a href="/login" className="text-brand-400 hover:text-brand-300 underline">
          {t("loginLink")}
        </a>
      </p>
    </form>
  );
}
