export interface VideoStats {
  play_count: number | null;
  digg_count: number | null;
  comment_count: number | null;
  share_count: number | null;
}

// Creator/profile info as shown on FastMoss's video detail page (avatar,
// follower count, average views/likes across their recent videos). yt-dlp
// doesn't expose most of this for TikTok, so it's populated separately when
// available (e.g. from a FastMoss scrape at trend-import time) rather than
// by the fetch_tiktok.py pipeline.
export interface CreatorInfo {
  name: string | null;
  handle: string | null; // TikTok @handle, no leading @
  avatar_url: string | null;
  followers: number | null;
  avg_views: number | null;
  avg_likes: number | null;
  profile_url: string | null; // real TikTok profile link, e.g. https://www.tiktok.com/@handle
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface HookAnalysis {
  hook_text: string;
  duration_sec: number;
  techniques: string[];
  why_it_works: string;
}

// Fixed 6-stage e-commerce funnel breakdown (used for both Video Analysis
// and Trend Analysis videos): Reaction -> Hook -> Pain point / old solution
// -> Product intro -> Desired outcome -> CTA.
export type FunnelStageKey =
  | "reaction"
  | "hook"
  | "pain_point"
  | "product_intro"
  | "desired_outcome"
  | "cta";

export interface FunnelStage {
  key: FunnelStageKey;
  label: string;
  start_time: number;
  end_time: number;
  summary: string;
  quote: string;
}

export interface SellingPoints {
  product_claims: string[];
  emotional_triggers: string[];
  copywriting_techniques: string[];
  key_phrases: string[];
  call_to_action: string;
}

export interface AnalysisResult {
  summary: string;
  hook: HookAnalysis;
  structure: FunnelStage[];
  selling_points: SellingPoints;
}

// ---- Draggable "canvas" board state (per video) ----

export interface CanvasCardPosition {
  x: number;
  y: number;
  color: string | null;
}

export type NoteFontSize = "sm" | "md" | "lg";

export interface CanvasNote {
  id: string;
  x: number;
  y: number;
  // Simple HTML (produced by a contentEditable + execCommand('bold') /
  // execCommand('hiliteColor')) — rendered with dangerouslySetInnerHTML.
  // This is an internal team tool with a trusted, small user base, so we
  // don't sanitize beyond what the browser's own editing commands produce.
  text: string;
  color: string;
  fontSize: NoteFontSize;
}

export interface CanvasImage {
  id: string;
  x: number;
  y: number;
  dataUrl: string;
}

export interface CanvasConnection {
  id: string;
  fromId: string;
  toId: string;
}

// A plain, headerless text block dropped anywhere on the canvas via the
// toolbar's Text tool — distinct from CanvasNote, which is the colored
// sticky-note card with its own header/color/delete controls.
export interface CanvasTextBox {
  id: string;
  x: number;
  y: number;
  text: string; // simple HTML, same trust model as CanvasNote.text
  fontSize: NoteFontSize;
}

export type DrawingTool = "line" | "arrow" | "pen";

// A freeform drawing entity made with the toolbar's Line / Arrow / Pen
// tools. Lines and arrows are always exactly 2 points; pen strokes can have
// any number of points collected while dragging.
export interface CanvasDrawing {
  id: string;
  tool: DrawingTool;
  points: { x: number; y: number }[];
  color: string;
}

export interface CanvasState {
  // keyed by transcript segment index (as string)
  cardPositions: Record<string, CanvasCardPosition>;
  notes: CanvasNote[];
  images: CanvasImage[];
  connections: CanvasConnection[];
  videoPosition: { x: number; y: number } | null;
  zoom: number;
  pan: { x: number; y: number };
  // Optional so older saved canvases (without these fields) still load fine.
  textBoxes?: CanvasTextBox[];
  drawings?: CanvasDrawing[];
}

export interface VideoRecord {
  id: string;
  source_url: string;
  webpage_url: string | null;
  title: string;
  description: string;
  author: string;
  author_id: string;
  duration_sec: number | null;
  stats: VideoStats;
  hashtags: string[];
  video_path: string | null;
  thumbnail_path: string | null;
  transcript_text: string;
  transcript_segments: TranscriptSegment[];
  analysis: AnalysisResult | null;
  canvas: CanvasState | null;
  is_reference: boolean;
  reference_of: string | null;
  // FastMoss creator/profile stats, when known — see CreatorInfo above.
  creator: CreatorInfo | null;
  // "trend" = imported via the Trend Analysis FastMoss pull; "creator" =
  // lazily hydrated from a Creator Tracker video stub the first time
  // someone clicks into it for the full AI breakdown. Both are excluded
  // from the Video Analysis home board, which only shows videos pasted in
  // directly by the team.
  source: "manual" | "trend" | "creator";
  // Set when source is "creator" — links back to the TrackedCreator this
  // video was hydrated from, purely for display/traceability.
  tracked_creator_id?: string | null;
  generated_scripts: GeneratedScript[];
  status: "pending" | "fetching" | "transcribing" | "analyzing" | "done" | "error";
  error_message: string | null;
  created_at: string;
}

// ---- AI-generated scripts (adapts a viral video's breakdown to one of our own products) ----

export interface GeneratedScriptStage {
  label: string;
  script: string;
  direction: string;
  // When the user gives feedback on this one beat and asks the AI to
  // rewrite it, we keep the version it's replacing here rather than
  // discarding it, so the UI can offer an Old/New toggle instead of
  // silently overwriting what might have been the better take.
  previousScript?: string | null;
  previousDirection?: string | null;
  // Which version counts as "final" right now. Defaults to "current" (the
  // newest one) when unset/absent.
  selectedVersion?: "current" | "previous";
}

export interface GeneratedScript {
  id: string;
  shopify_product_id: string;
  shopify_product_title: string;
  stages: GeneratedScriptStage[];
  created_at: string;
}

// ---- Trend analysis (e.g. FastMoss top pet-food/treat videos, rolling 7-day window) ----

export interface TrendItem {
  rank: number;
  fastmoss_url: string;
  fastmoss_title: string | null;
  product_name: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  gmv: string | null; // revenue over the ranking window (e.g. this week)
  gmv_28d: string | null; // trailing 28-day GMV for the product, for scale/context
  sales: number | string | null;
  video_id: string | null;
}

export interface TrendBatch {
  id: string;
  category: string;
  date_from: string; // YYYY-MM-DD
  date_to: string; // YYYY-MM-DD
  top_by_views: TrendItem[];
  top_by_sales: TrendItem[];
  created_at: string;
}

// ---- Creator Tracker (yt-dlp-based: lightweight metadata scan of a
// creator's full video history, no per-video download/transcription until
// someone actually clicks in — see src/lib/creatorPipeline.ts) ----

// A single video as pulled by the metadata-only scan. Deliberately NOT a
// full VideoRecord — a tracked creator can have hundreds of videos, and
// downloading + transcribing all of them up front doesn't scale. This is
// just enough to render the list/stats/product-grouping views; clicking
// into one lazily hydrates a real VideoRecord (see tracked_creator_id
// above) the same way Trend Analysis videos do.
export interface CreatorVideoStub {
  id: string; // TikTok's own video id
  url: string; // https://www.tiktok.com/@handle/video/id — the real TikTok
  // link, used to lazily hydrate a full VideoRecord on click-through.
  fastmoss_url: string | null; // FastMoss's own video-detail page, for reference
  title: string;
  thumbnail_url: string | null; // remote CDN url — not downloaded locally
  create_timestamp: number | null; // unix seconds — drives the 7D/14D/30D/60D filter
  stats: VideoStats;
  // The actual TikTok Shop product this video is tagged with, as scraped
  // from FastMoss's creator page — real product data, not a guess (unlike
  // yt-dlp, which has no notion of "which shop product is linked").
  product_name: string | null;
  // Pet-relevance is decided by keyword-matching product_name (falling back
  // to the video title if a video has no tagged product) against
  // src/lib/petCategories.ts. Non-pet videos are dropped entirely at import
  // time (see importCreatorScan) rather than stored with an empty array —
  // this field records WHICH category label(s) matched, for the product
  // grid's grouping.
  pet_categories: string[];
  // Set once someone clicks through and we hydrate a full VideoRecord for
  // the AI breakdown (see tracked_creator_id on VideoRecord).
  linked_video_id: string | null;
}

export type CreatorTrackStatus = "pending" | "scanning" | "done" | "error";

// Audience gender/age breakdown, as shown on TikTok Shop Seller Center's
// Affiliate Center creator-detail page (Followers tab). Percentages, 0-100.
export interface CreatorAudienceDemographics {
  male_pct: number | null;
  female_pct: number | null;
  age_18_24_pct: number | null;
  age_25_34_pct: number | null;
  age_35_44_pct: number | null;
  age_45_54_pct: number | null;
  age_55_plus_pct: number | null;
}

// Aggregate performance stats pulled from TikTok Shop's own Seller
// Center -> Affiliate Center -> Find creators -> creator detail page
// (affiliate-us.tiktok.com/connection/creator/detail?...). This is TikTok's
// own first-party advertiser-facing data — a different (and for these
// aggregate numbers, more authoritative) source than FastMoss, which is
// used for the per-video product breakdown instead (see CreatorVideoStub).
// Requires an authenticated TikTok Shop seller session, same live-scrape
// constraint as FastMoss.
export interface CreatorAffiliateStats {
  pps_score: number | null; // Promotion Performance Score, out of 5.0
  window_from: string | null; // the date range this snapshot covers, e.g. "2026-06-10"
  window_to: string | null;
  gmv: number | null; // in the window above, as a plain number (parsed from e.g. "$97.8K")
  items_sold: number | null;
  gpm: number | null; // GMV per thousand views, $
  video_gpm: number | null;
  videos_count: number | null; // shoppable videos posted in the window ("monthly video count")
  avg_video_views: number | null;
  avg_engagement_rate: number | null; // %
  est_post_rate: number | null; // %
  avg_commission_rate: number | null; // %
  products_count: number | null; // distinct products they've promoted
  brand_collaborations: number | null;
  demographics: CreatorAudienceDemographics | null;
  scraped_at: string | null;
}

export interface TrackedCreator {
  id: string;
  handle: string; // no leading @
  profile_url: string;
  name: string | null;
  avatar_url: string | null;
  followers: number | null;
  tags: string[];
  status: CreatorTrackStatus;
  error_message: string | null;
  last_scanned_at: string | null;
  created_at: string;
  videos: CreatorVideoStub[];
  // TikTok Shop Affiliate Center data — separate from the FastMoss video
  // scan above, populated (and refreshed) independently. Null until scraped.
  affiliate: CreatorAffiliateStats | null;
}
