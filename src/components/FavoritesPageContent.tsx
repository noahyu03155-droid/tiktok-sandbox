"use client";

// The favorites library — a member's saved videos and products in one
// place, kept in two separate sections per the original request ("收藏库
// 版面里面分开产品和视频"). Videos reuse the existing VideoCard (same
// component the Video Analysis board uses) so favoriting a card here looks
// and behaves identically to un-favoriting it anywhere else on the site.
// Products get their own lightweight card since a favoriteProducts entry is
// a plain snapshot (title/image/price), not a full EnrichedItem with
// GMV/saturation/AI-analysis data — see the User.favoriteProducts doc
// comment in src/lib/types.ts for why (FastMoss batches rotate out, so
// there's no durable product record left to re-fetch richer data against
// later).

import { useEffect, useState } from "react";
import Link from "next/link";
import VideoCard from "./VideoCard";
import { useLocale } from "@/lib/i18n";
import type { VideoRecord } from "@/lib/types";

interface FavoriteVideoEntry {
  favoriteId: string;
  addedAt: string;
  video: VideoRecord;
}

interface FavoriteProductEntry {
  id: string;
  productId: string;
  title: string;
  imageUrl: string | null;
  price: string | null;
  addedAt: string;
}

function FavoriteProductCard({
  entry,
  onRemove,
}: {
  entry: FavoriteProductEntry;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const [imgFailed, setImgFailed] = useState(false);
  const detailHref = `/trends/product/${encodeURIComponent(entry.productId)}?${new URLSearchParams({
    title: entry.title,
    ...(entry.imageUrl ? { image: entry.imageUrl } : {}),
    ...(entry.price ? { price: entry.price } : {}),
  }).toString()}`;

  return (
    <div className="rounded-xl overflow-hidden bg-panel border border-edge hover:border-brand-500 transition-colors">
      <div className="relative aspect-square bg-panel2">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          title={t("favoriteRemove")}
          className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full flex items-center justify-center leading-none bg-brand-500 text-white hover:bg-brand-600"
        >
          <span className="text-[11px]">★</span>
        </button>
        <Link href={detailHref}>
          {entry.imageUrl && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={entry.imageUrl}
              alt={entry.title}
              className="w-full h-full object-cover"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-4xl">🛍</div>
          )}
        </Link>
      </div>
      <div className="p-3">
        <Link href={detailHref} className="hover:text-brand-500">
          <p className="text-sm text-zinc-900 line-clamp-2 min-h-[2.5rem]" title={entry.title}>
            {entry.title}
          </p>
        </Link>
        {entry.price && <p className="text-sm font-semibold text-brand-400 mt-1">{entry.price}</p>}
      </div>
    </div>
  );
}

export default function FavoritesPageContent() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"videos" | "products">("videos");
  const [videos, setVideos] = useState<FavoriteVideoEntry[] | null>(null);
  const [products, setProducts] = useState<FavoriteProductEntry[] | null>(null);

  useEffect(() => {
    fetch("/api/favorites/videos", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { videos: [] }))
      .then((data) => setVideos(data.videos || []))
      .catch(() => setVideos([]));
    fetch("/api/favorites/products", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { products: [] }))
      .then((data) => setProducts(data.products || []))
      .catch(() => setProducts([]));
  }, []);

  async function removeVideo(videoId: string) {
    setVideos((prev) => (prev ? prev.filter((v) => v.video.id !== videoId) : prev));
    try {
      await fetch(`/api/favorites/videos/${videoId}`, { method: "DELETE" });
    } catch {
      // Best-effort — if this fails the video just reappears on next load.
    }
  }

  async function removeProduct(productId: string) {
    setProducts((prev) => (prev ? prev.filter((p) => p.productId !== productId) : prev));
    try {
      await fetch(`/api/favorites/products/${productId}`, { method: "DELETE" });
    } catch {
      // Best-effort, same as removeVideo above.
    }
  }

  const videoCount = videos?.length ?? 0;
  const productCount = products?.length ?? 0;

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900 mb-1">{t("favoritesPageTitle")}</h1>
      <p className="text-sm text-zinc-500 mb-6">{t("favoritesPageSubtitle")}</p>

      <div className="flex items-center rounded-lg border border-edge overflow-hidden w-fit mb-6">
        <button
          onClick={() => setTab("videos")}
          className={`text-sm px-4 py-2 transition-colors ${
            tab === "videos" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-900"
          }`}
        >
          {t("favoritesTabVideos")} {videos && `(${videoCount})`}
        </button>
        <button
          onClick={() => setTab("products")}
          className={`text-sm px-4 py-2 transition-colors ${
            tab === "products" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-900"
          }`}
        >
          {t("favoritesTabProducts")} {products && `(${productCount})`}
        </button>
      </div>

      {tab === "videos" &&
        (videos === null ? (
          <p className="text-sm text-zinc-500">{t("favoritesLoading")}</p>
        ) : videos.length === 0 ? (
          <div className="text-center py-24 text-zinc-500 text-sm">{t("favoritesEmptyVideos")}</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {videos.map((entry) => (
              <VideoCard
                key={entry.favoriteId}
                video={entry.video}
                favorited
                onToggleFavorite={() => removeVideo(entry.video.id)}
              />
            ))}
          </div>
        ))}

      {tab === "products" &&
        (products === null ? (
          <p className="text-sm text-zinc-500">{t("favoritesLoading")}</p>
        ) : products.length === 0 ? (
          <div className="text-center py-24 text-zinc-500 text-sm">{t("favoritesEmptyProducts")}</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {products.map((entry) => (
              <FavoriteProductCard key={entry.id} entry={entry} onRemove={() => removeProduct(entry.productId)} />
            ))}
          </div>
        ))}
    </div>
  );
}
