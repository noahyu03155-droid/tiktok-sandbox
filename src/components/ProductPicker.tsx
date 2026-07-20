"use client";

import { useEffect, useState } from "react";

interface ShopifyProductLite {
  id: string;
  title: string;
  productType: string;
  imageUrl: string | null;
}

type Mode = "catalog" | "link";

export default function ProductPicker({
  onSelect,
  onSelectLink,
  onClose,
}: {
  onSelect: (product: ShopifyProductLite) => void;
  // Alternative to picking from the Shopify catalog — the caller scrapes
  // the pasted URL server-side (same generic Open Graph/JSON-LD scrape the
  // Creation canvas's "paste a product link" card uses) and generates the
  // script from that instead of a real Shopify product. Optional — a
  // caller that doesn't pass this just doesn't get the "Paste a link" tab.
  onSelectLink?: (url: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("catalog");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ShopifyProductLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");

  useEffect(() => {
    if (mode !== "catalog") return;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/shopify/products?q=${encodeURIComponent(query)}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Search failed");
        setResults(data.products);
      } catch (e: any) {
        setError(e.message || "Search failed");
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [query, mode]);

  function submitLink() {
    const trimmed = linkUrl.trim();
    if (!trimmed || !onSelectLink) return;
    onSelectLink(trimmed);
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-panel rounded-xl border border-edge max-w-lg w-full p-5 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-zinc-900 font-semibold">Pick a product</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900 text-sm">
            ✕
          </button>
        </div>

        {onSelectLink && (
          <div className="flex gap-1 mb-3 rounded-lg bg-panel2 p-1">
            <button
              onClick={() => setMode("catalog")}
              className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-colors ${
                mode === "catalog" ? "bg-brand-500 text-white" : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              Search catalog
            </button>
            <button
              onClick={() => setMode("link")}
              className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-colors ${
                mode === "link" ? "bg-brand-500 text-white" : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              Paste a link
            </button>
          </div>
        )}

        {mode === "catalog" ? (
          <>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your Shopify products..."
              className="w-full mb-3 px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500"
            />
            <div className="overflow-y-auto flex-1 space-y-1">
              {error && <p className="text-sm text-red-400">{error}</p>}
              {!error && loading && <p className="text-sm text-zinc-500">Searching...</p>}
              {!error && !loading && results.length === 0 && (
                <p className="text-sm text-zinc-500">No products found.</p>
              )}
              {results.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelect(p)}
                  className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-panel2 text-left"
                >
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.imageUrl} alt="" className="w-10 h-10 object-cover rounded shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-panel2 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-900 truncate">{p.title}</p>
                    {p.productType && <p className="text-xs text-zinc-500 truncate">{p.productType}</p>}
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-zinc-500">
              Paste a link to any product page — your own store, a marketplace listing, a TikTok Shop link — and
              we'll pull its title, description, image, and price to write the script around.
            </p>
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitLink();
              }}
              placeholder="https://..."
              className="w-full px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500"
            />
            <button
              onClick={submitLink}
              disabled={!linkUrl.trim()}
              className="w-full py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium"
            >
              Use this product
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
