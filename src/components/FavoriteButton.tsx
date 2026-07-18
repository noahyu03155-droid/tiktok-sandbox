"use client";

// Small bookmark-star toggle, reused on VideoCard/TrendCard/ProductCard and
// inside the favorites library itself. Purely presentational + click
// plumbing — the parent owns the actual favorited-state Set and the
// add/remove fetch calls (see VideoGrid.tsx / TrendsPageContent.tsx), so
// many cards on one page share a single GET fetch instead of each card
// polling its own status.
export default function FavoriteButton({
  favorited,
  onToggle,
  title,
}: {
  favorited: boolean;
  onToggle: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      title={title}
      aria-pressed={favorited}
      className={`w-6 h-6 rounded-full flex items-center justify-center leading-none transition-colors ${
        favorited ? "bg-brand-500 text-white" : "bg-black/70 text-white hover:bg-black/90"
      }`}
    >
      <span className="text-[11px]">{favorited ? "★" : "☆"}</span>
    </button>
  );
}
