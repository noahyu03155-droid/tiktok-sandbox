import { getTrackedCreator, updateTrackedCreator } from "./db";
import { matchPetCategories } from "./petCategories";
import type { CreatorVideoStub } from "./types";

// Raw shape submitted by a live FastMoss scrape (see /api/creators/[id]/import)
// — mirrors the same "Claude scrapes it live, then POSTs the result" pattern
// already used for Trend Analysis, since FastMoss requires an authenticated
// browser session and can't be pulled headlessly on a schedule.
export interface RawCreatorVideo {
  id: string; // TikTok video id
  url: string; // real tiktok.com/@handle/video/id link
  fastmoss_url?: string | null;
  title?: string | null;
  thumbnail_url?: string | null;
  create_timestamp?: number | null;
  stats?: {
    play_count?: number | null;
    digg_count?: number | null;
    comment_count?: number | null;
    share_count?: number | null;
  };
  product_name?: string | null;
}

export interface CreatorImportPayload {
  name?: string | null;
  avatar_url?: string | null;
  followers?: number | null;
  videos: RawCreatorVideo[];
}

/**
 * Merges a freshly-scraped batch of a creator's videos into their stored
 * record. Only videos whose tagged TikTok Shop product (or, failing that,
 * title) matches a known pet-product category are kept — per "only track
 * pet products," everything else is dropped rather than stored inert. A
 * rescan MERGES into the existing list (by video id) rather than replacing
 * it wholesale, since a given scrape pass may only cover a creator's most
 * recent videos rather than their full history every time — older videos
 * from a prior full scan shouldn't disappear just because this pass didn't
 * re-see them. A video that was already clicked-through in a previous scan
 * keeps its `linked_video_id` (the full VideoRecord it hydrated into).
 */
export function importCreatorScan(creatorId: string, payload: CreatorImportPayload): { added: number; updated: number; skippedNonPet: number } {
  const creator = getTrackedCreator(creatorId);
  if (!creator) throw new Error("creator not found");

  const merged = new Map(creator.videos.map((v) => [v.id, v]));
  let added = 0;
  let updated = 0;
  let skippedNonPet = 0;

  for (const v of payload.videos) {
    if (!v.id || !v.url) continue;
    const matchText = v.product_name || v.title || "";
    const categories = matchPetCategories(matchText);
    if (categories.length === 0) {
      skippedNonPet++;
      continue;
    }
    const prev = merged.get(v.id);
    const stub: CreatorVideoStub = {
      id: v.id,
      url: v.url,
      fastmoss_url: v.fastmoss_url ?? null,
      title: v.title ?? "",
      thumbnail_url: v.thumbnail_url ?? null,
      create_timestamp: v.create_timestamp ?? null,
      stats: {
        play_count: v.stats?.play_count ?? null,
        digg_count: v.stats?.digg_count ?? null,
        comment_count: v.stats?.comment_count ?? null,
        share_count: v.stats?.share_count ?? null,
      },
      product_name: v.product_name ?? null,
      pet_categories: categories,
      linked_video_id: prev?.linked_video_id ?? null,
    };
    merged.set(v.id, stub);
    if (prev) updated++;
    else added++;
  }

  const videos = Array.from(merged.values()).sort(
    (a, b) => (b.create_timestamp ?? 0) - (a.create_timestamp ?? 0)
  );

  updateTrackedCreator(creatorId, {
    status: "done",
    error_message: null,
    videos,
    name: payload.name ?? creator.name,
    avatar_url: payload.avatar_url ?? creator.avatar_url,
    followers: payload.followers ?? creator.followers,
    last_scanned_at: new Date().toISOString(),
  });

  return { added, updated, skippedNonPet };
}
