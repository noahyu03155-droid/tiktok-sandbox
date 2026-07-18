import FavoritesPageContent from "@/components/FavoritesPageContent";

export const dynamic = "force-dynamic";

// Always accessible to any signed-in member regardless of accessTier —
// unlike Video Analysis/Trends/Creators/Creation, favorites aren't a
// feature tier, they're personal to whoever saved them (auth itself is
// already enforced globally by middleware.ts, same as every other
// non-public route).
export default function FavoritesPage() {
  return <FavoritesPageContent />;
}
