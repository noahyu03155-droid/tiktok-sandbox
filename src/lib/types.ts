// ---- Accounts (multi-user login, Phase 1 of the "Creation" workspace) ----

export type UserRole = "admin" | "member";

// Feature-visibility tier for a "member" account — separate from UserRole
// above, which is the real login-level admin/member split (controls things
// like the /user-data admin panel and cross-member Creation visibility).
// AccessTier instead just controls which top-level nav tabs a member sees
// (see src/lib/accessTier.ts) — an admin-tagged member still can't see
// /user-data, only the actual UserRole "admin" (the site owner) can. Unset
// (undefined) means "no tier assigned yet" and is treated as "business" (the
// broadest of the three) so existing/untagged members keep seeing what they
// already could before this field existed — see tabsForTier.
export type AccessTier = "business" | "vip" | "admin";

// A handful of short answers collected right after registration (see
// /onboarding) — used purely to nudge the AI script generator's tone,
// persona, and filming-direction detail toward this specific creator
// instead of one generic voice for everyone (see src/lib/scriptgen.ts).
// Every field is optional — the onboarding form can be skipped entirely.
export interface CreatorProfile {
  ageRange: string | null;
  occupation: string | null;
  interests: string | null;
  experienceLevel: string | null;
  contentStyle: string | null;
  completedAt: string | null;
}

export interface User {
  id: string;
  username: string;
  // scrypt hash, formatted "<salt-hex>:<hash-hex>" — see src/lib/password.ts.
  // Never sent to the client.
  passwordHash: string;
  role: UserRole;
  // Which nav tabs this member sees — set from the User Data page's search +
  // tag UI (src/components/UserDataListContent.tsx / UserKeywordGraphPageContent.tsx).
  // See the AccessTier doc comment above for how this differs from `role`.
  accessTier?: AccessTier | null;
  createdAt: string;
  // Optional product category picked at registration (from the FastMoss
  // category tree) — drives the personalized "For You" section on the
  // Trend Analysis page. Both null/absent until the user picks one.
  preferredCategoryId?: string | null;
  preferredCategoryLabel?: string | null;
  // Optional short creator profile collected right after registration —
  // see CreatorProfile above.
  creatorProfile?: CreatorProfile | null;
  // Keywords the AI has extracted over time from this user's journal chat
  // (see src/lib/journal.ts) — free-text personality/habit/interest signals
  // that accumulate across entries. Shown as a "journal" branch on the User
  // Data keyword graph (src/components/UserKeywordGraph.tsx). Capped, see
  // journal.ts for the merge/dedupe logic. undefined/[] until they've
  // journaled at least once.
  journalKeywords?: string[];
  // Short ENGLISH tags the AI has inferred over time from this member's
  // on-platform ACTIONS (breaking down a reference video, generating a
  // product script, etc. — see src/lib/personalityInsights.ts) rather than
  // anything they wrote directly. Unlike journalKeywords (kept in whatever
  // language the user journaled in, since those are an extraction of their
  // own words), these are the AI's own inference and are always English.
  // Shown as an "insights" branch on the User Data keyword graph
  // (src/components/UserKeywordGraph.tsx). Capped, see
  // mergeInsightTags in personalityInsights.ts. undefined/[] until the
  // first action that produces enough signal to infer anything.
  insightTags?: string[];
  // Admin-added freeform tags on this member's User Data keyword graph
  // (src/app/user-data) — a manual observation an admin typed in that the
  // automated signals (registration category, onboarding answers, journal
  // keywords) missed. Rendered as its own node the admin can drag to attach
  // under whichever branch fits (see graphParentOverrides). Unlike the other
  // profile-derived branches, these are pure admin curation with no AI
  // involvement in their content.
  customTags?: { id: string; label: string; createdAt: string }[];
  // Manually-dragged node positions on the User Data keyword-graph canvas
  // (src/components/UserKeywordGraph.tsx), keyed by that component's stable
  // per-node id scheme ("root", "branch:<kind>", "leaf:<kind>:<index>",
  // "custom:<tagId>"). Missing keys fall back to the deterministic radial
  // layout. Persisted per VIEWED user (this describes how THEIR graph looks,
  // independent of which admin is looking at it).
  graphPositions?: Record<string, { x: number; y: number }>;
  // Per-node parent overrides for the same graph, same id scheme as above —
  // lets an admin correct a node that looks miscategorized, or attach a new
  // custom tag to a specific branch, by dragging its connector onto a
  // different node. Missing entry = default parent (a leaf's own branch node;
  // a custom tag defaults to "root" until reassigned; branch nodes are always
  // fixed to "root" and are never reconnectable — see UserKeywordGraph.tsx).
  graphParentOverrides?: Record<string, string>;
}

// ---- Daily journal chat ("write like a diary, AI replies like a friend") ----
// One turn of the per-user journal conversation, stored append-only per
// user (see journalEntries in src/lib/db.ts) and served by /api/journal.
export interface JournalEntry {
  id: string;
  userId: string;
  role: "user" | "ai";
  content: string;
  createdAt: string; // ISO
}

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
  // The member who pasted this in on the Video Analysis home board (only set
  // for source:"manual" — see src/lib/videoAuth.ts). null/absent for
  // "trend"/"creator" sourced videos (shared FastMoss/Creator-Tracker catalog
  // entries, not any one member's private content) and for legacy "manual"
  // records created before this field existed.
  ownerId?: string | null;
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
  // "Generate Video" storyboard canvas — planning only (see StoryboardState),
  // not an actual rendered video. Optional/absent until the user opens the
  // canvas for the first time.
  storyboard?: StoryboardState | null;
}

// ---- Storyboard canvas ("Generate Video") — a draggable planning board that
// turns a generated script's beats into nodes with an attached video/image
// clip each, connected point-to-point, plus one overall editing-direction
// note. Phase 1 is planning only: no Creatomate/FFmpeg render happens yet,
// this just organizes what a human editor (or a later render step) needs.

export type StoryboardClipSource = "upload" | "library" | "ai" | "tiktok";

export interface StoryboardClip {
  source: StoryboardClipSource;
  // Playable/previewable URL. For "upload"/"ai" this is a /api/media/... path
  // this app now owns; for "library" it's the referenced video's own
  // thumbnail/video path (not copied).
  url: string;
  // "video" vs "image" — an uploaded clip or a picked library video is a
  // video; an AI-generated placeholder or an uploaded photo is a still.
  kind: "video" | "image";
  // Set when source === "library" — links back to the VideoRecord this clip
  // references, purely so the canvas can deep-link to it.
  libraryVideoId?: string | null;
}

export interface StoryboardNode {
  id: string;
  // Freeform — nodes are no longer locked 1:1 to the script's stages[].
  // Seeded from a stage's label/script/direction the first time the canvas
  // opens, but editable and independently split/duplicated/deleted from
  // then on, so it owns its own copy of the text.
  label: string;
  instruction: string;
  // A separate, personal note field — the user's own editing/filming
  // suggestions for this specific shot (pacing, framing, tone, whatever
  // they want to remember). Deliberately kept apart from `instruction`
  // (the script text, often pre-filled from an AI breakdown) so the two
  // don't get mixed together. Not read by the render pipeline or any AI
  // call in this pass — purely a personal scratch note, autosaved like
  // everything else on the node.
  editorNotes?: string;
  x: number;
  y: number;
  clip: StoryboardClip | null;
  // Which of the fixed 6 funnel stages this card claims to cover (same
  // FunnelStageKey funnel used by video analysis). undefined/null = an
  // untagged freeform card — always allowed, and freely interspersable; the
  // stage gate (checkStageGate) only cares that each of the 6 required tags
  // exists somewhere and appears in funnel order along the resolved shot
  // order.
  stageTag?: FunnelStageKey | null;
  // Optional per-card custom size, set by dragging the resize handle in the
  // canvas (src/components/StoryboardCanvas.tsx). undefined = use the
  // default NODE_W/derived-height sizing. Persisted with the rest of the
  // node like x/y.
  w?: number;
  h?: number;
  // A card sourced from pasting a TikTok PRODUCT link (distinct from a TikTok
  // VIDEO link, which populates `clip` instead) — see isTikTokProductUrl in
  // StoryboardCanvas.tsx and src/lib/tiktokProduct.ts. Rendered as a 9:16
  // product card with a "Generate script" action once connected into the
  // canvas graph. null/undefined = not a product card.
  productRef?: {
    sourceUrl: string;
    title: string;
    description: string;
    imageUrl: string | null;
    price: string | null;
    // Three more best-effort scraped fields (JSON-LD aggregateRating /
    // brand, see src/lib/tiktokProduct.ts) — null/absent when nothing
    // structured was found, which is the common case for TikTok Shop's
    // JS-rendered pages. soldOrReviews is deliberately generic: a true
    // "sold count" is essentially never scrapeable, so when present this is
    // really an aggregate review-count proxy. All three are plain editable
    // text in the UI, same "user has final say" model as the fields above.
    rating?: string | null;
    soldOrReviews?: string | null;
    storeName?: string | null;
    // True if the best-effort scrape (generic Open Graph meta tags — TikTok
    // Shop has no public product API we have access to, and its product
    // pages are frequently JS-rendered, so this often comes back empty) found
    // too little to trust. The UI shows editable fields either way so the
    // user can fill in/correct details by hand.
    scrapeFailed: boolean;
  } | null;
  // Optional structured filming guidance for this shot — auto-filled by
  // Breakdown (see the breakdown API route) from the viral reference's actual
  // pacing/tone/framing, but freely editable, and can also be filled in by
  // hand on any card. Shown as a small panel next to the Script box in
  // StoryboardCanvas.tsx. undefined/null = not set yet (panel shows empty
  // editable fields with placeholders).
  shootingGuide?: {
    angle: string; // e.g. "Close-up, eye-level, handheld"
    tone: string; // e.g. "Playful and a little chaotic"
    pace: string; // e.g. "Fast cuts, no dead air"
  } | null;
}

export interface StoryboardState {
  nodes: StoryboardNode[];
  connections: CanvasConnection[];
  // Overall cut/editing direction, entered in the fixed textbox docked at
  // the bottom of the canvas.
  direction: string;
  zoom: number;
  pan: { x: number; y: number };
  // "Learn from a reference video" — an editing-style profile extracted
  // from a reference clip the user uploads (empirical cut pacing via ffmpeg
  // scene detection + a vision model's read on transition/caption style).
  // When present, the render route uses it to pick transition preset/
  // duration and scale shot lengths instead of the fixed defaults. Not a
  // real video-generation model imitating the reference — it reads the
  // reference's *editing rhythm*, then applies that rhythm to the user's
  // own footage.
  styleProfile?: StoryboardStyleProfile | null;
}

export type StoryboardPacing = "fast" | "medium" | "slow";

// Kept to ffmpeg's original xfade transition set (added in ffmpeg 4.3),
// verified working in a real ffmpeg build before shipping — newer presets
// like "zoomin" aren't reliably available across ffmpeg versions.
export type StoryboardTransitionPreset =
  | "hard_cut"
  | "fade"
  | "dissolve"
  | "wipeleft"
  | "wiperight"
  | "slideleft"
  | "slideright"
  | "slideup"
  | "slidedown"
  | "circleopen"
  | "circleclose";

export type StoryboardCaptionStyle = "punchy" | "descriptive" | "minimal";

export interface StoryboardStyleProfile {
  sourceLabel: string;
  shotCount: number;
  avgShotSec: number;
  pacing: StoryboardPacing;
  transition: StoryboardTransitionPreset;
  transitionSec: number;
  // Multiplies the estimated speech-duration target for clips —
  // <1 tightens cuts to match a faster reference, >1 loosens them.
  durationMultiplier: number;
  captionStyle: StoryboardCaptionStyle;
  // Short human-readable description from the vision model, shown in the
  // UI so the user can sanity-check what was actually detected.
  notes: string;
}

// ---- Creation workspace — every account gets their own space to run
// multiple independent storyboard projects at once. Deliberately NOT
// nested under a VideoRecord/GeneratedScript like the original storyboard
// canvas was — a creation project owns its own StoryboardState outright, so
// a member isn't required to first break down someone else's video in
// Video Analysis before they can start creating. Reuses the exact same
// StoryboardState/StoryboardNode/etc. shape, and the same StoryboardCanvas
// component (see src/components/StoryboardCanvas.tsx's apiBase prop).

export interface CreationProject {
  id: string;
  ownerId: string; // User.id
  title: string;
  shopifyProductId?: string | null;
  shopifyProductTitle?: string | null;
  storyboard: StoryboardState | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Trend analysis (e.g. FastMoss top pet-food/treat videos, rolling 7-day window) ----

export interface TrendItem {
  rank: number;
  fastmoss_url: string;
  fastmoss_title: string | null;
  product_name: string | null;
  // FastMoss's product id for this item's linked product, if any — used to
  // look up a real sales-trend chart / saturation count on demand, see
  // /api/trends/analyze-product.
  product_id: string | null;
  // Product cover image + display price, straight from FastMoss's
  // product_info block (see FastMossProductInfo in fastmoss.ts) — used to
  // render an actual PRODUCT card (image + name + price) for the "Top 20
  // Viral Products" section, instead of reusing the video-card layout.
  // Hotlinked straight from FastMoss/TikTok's own CDN (not cached locally
  // like video thumbnails), so the UI must tolerate it 404ing/expiring.
  product_image: string | null;
  product_price: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  gmv: string | null; // revenue over the ranking window (e.g. this week)
  gmv_28d: string | null; // trailing 28-day GMV for the product, for scale/context
  sales: number | string | null;
  video_id: string | null;
  // The @handle of the video's creator, if known — used to look up creator
  // 28-day GMV stats on demand alongside the product analysis, see
  // /api/trends/analyze-product.
  creator_handle: string | null;
  // 1-100 "how well does this match what COTORX has learned about the
  // requesting user" score, computed on-demand and per-request by
  // /api/trends/top-products (see productRelevance.ts) — NOT persisted on
  // the shared TrendBatch/TrendItem in db.json, since it's specific to
  // whoever asked. Optional/undefined on every other TrendItem in the app;
  // null when scoring was attempted but skipped (no user signal available).
  recommendationScore?: number | null;
}

export interface TrendBatch {
  id: string;
  category: string;
  // FastMoss product_category_id used for this batch's search, if a specific
  // category was picked (vs the legacy keyword-fallback sweep). Lets a future
  // "Update" re-run reuse the same category by default.
  category_id: string | null;
  date_from: string; // YYYY-MM-DD
  date_to: string; // YYYY-MM-DD
  // The date-range window (7/28/90) this batch was pulled with.
  days: number;
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
