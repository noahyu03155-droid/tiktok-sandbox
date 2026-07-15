// Keyword-based pet-product classifier for Creator Tracker videos.
//
// We deliberately do NOT try to identify the exact TikTok Shop product tag
// on a video — that data isn't exposed by yt-dlp (TikTok's public metadata
// has no notion of "which shop product is linked"; only a real TikTok Shop
// API or a third-party analytics site like FastMoss has that). Instead we
// read each video's title/description/hashtags and bucket it into one or
// more broad pet-product categories by keyword match. It's a heuristic, not
// a guarantee — but it's enough to answer "what kind of pet products is
// this creator actually posting about" without needing a live scrape.
export interface PetCategory {
  label: string;
  keywords: string[];
}

export const PET_CATEGORIES: PetCategory[] = [
  { label: "Flea & Tick", keywords: ["flea", "tick", "pest control"] },
  {
    label: "Grooming",
    keywords: ["groom", "brush", "shed", "deshed", "de-shed", "fur remover", "shampoo", "bath time", "nail trim", "clipper"],
  },
  {
    label: "Treats & Food",
    keywords: ["treat", "chew", "kibble", "dog food", "cat food", "freeze-dried", "freeze dried", "snack", "jerky"],
  },
  { label: "Toys", keywords: ["toy", "puzzle feeder", "fetch", "chew toy", "plush toy", "squeaky"] },
  {
    label: "Health & Wellness",
    keywords: ["supplement", "vitamin", "joint", "omega", "probiotic", "wellness", "calming chew", "allergy relief"],
  },
  { label: "Water & Feeding", keywords: ["water bowl", "fountain", "feeder", "food bowl", "slow feeder"] },
  { label: "Training & Behavior", keywords: ["training", "potty pad", "crate training", "clicker", "behavior"] },
  {
    label: "Apparel & Accessories",
    keywords: ["collar", "leash", "harness", "bandana", "pet sweater", "pet costume", "id tag"],
  },
  { label: "Litter & Waste", keywords: ["litter", "poop bag", "waste bag", "poop scoop", "litter odor"] },
  { label: "Beds & Furniture", keywords: ["pet bed", "dog bed", "cat bed", "carrier", "scratching post", "crate"] },
];

// Generic pet-adjacent words that don't map to a specific category above but
// still signal "this is a pet video" — used so a video isn't silently
// dropped just because it doesn't match one of the narrower buckets.
const GENERIC_PET_WORDS = ["dog", "puppy", "cat", "kitten", "pet ", "pets ", "#pet", "#dog", "#cat", "#puppy", "#kitten"];

function normalize(text: string): string {
  return (text || "").toLowerCase();
}

export function matchPetCategories(text: string): string[] {
  const lower = normalize(text);
  return PET_CATEGORIES.filter((cat) => cat.keywords.some((kw) => lower.includes(kw))).map((cat) => cat.label);
}

export function isPetRelevant(text: string): boolean {
  const lower = normalize(text);
  if (matchPetCategories(text).length > 0) return true;
  return GENERIC_PET_WORDS.some((w) => lower.includes(w));
}
