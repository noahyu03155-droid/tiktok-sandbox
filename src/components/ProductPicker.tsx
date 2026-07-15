"use client";

import { useEffect, useState } from "react";

interface ShopifyProductLite {
  id: string;
  title: string;
  productType: string;
  imageUrl: string | null;
}

export default function ProductPicker({
  onSelect,
  onClose,
}: {
  onSelect: (product: ShopifyProductLite) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ShopifyProductLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [query]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-panel rounded-xl border border-edge max-w-lg w-full p-5 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-semibold">Pick a product</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-white text-sm">
            ✕
          </button>
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your Shopify products..."
          className="w-full mb-3 px-3 py-2 rounded-lg bg-panel2 border border-edge text-sm text-zinc-100 outline-none focus:border-brand-500"
        />
        <div className="overflow-y-auto flex-1 space-y-1">
          {error && <p className="text-sm text-red-400">{error}</p>}
          {!error && loading && <p className="text-sm text-zinc-400">Searching...</p>}
          {!error && !loading && results.length === 0 && (
            <p className="text-sm text-zinc-400">No products found.</p>
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
                <p className="text-sm text-zinc-100 truncate">{p.title}</p>
                {p.productType && <p className="text-xs text-zinc-500 truncate">{p.productType}</p>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
