import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { VideoRecord, TrendBatch, CreatorInfo, TrackedCreator, User, UserRole, CreationProject, JournalEntry, ReactionEmotion } from "./types";
import { hashPassword } from "./password";

const DATA_DIR = path.join(process.cwd(), "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const DB_FILE = path.join(DATA_DIR, "db.json");

const STALE_TMP_DIR_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// Every render/breakdown/generate-product-script/style-analyze route creates
// a `_<name>_<timestamp>` working directory under MEDIA_DIR and cleans it up
// in a `finally` block — reliable in the normal case, but if the server
// process itself crashes or gets killed mid-request, that `finally` never
// runs and the directory is orphaned forever, silently eating disk space.
// This runs once at startup and removes anything `_`-prefixed and older
// than STALE_TMP_DIR_MAX_AGE_MS (age-gated so a tmp dir from a request
// that's still genuinely in progress is never touched). Recurses one level
// at a time rather than assuming a fixed folder depth, since these tmp
// dirs can live under data/media/storyboard/<id>/ at varying nesting.
function sweepStaleTmpDirs(dir: string) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith("_")) {
      try {
        const stat = fs.statSync(fullPath);
        if (Date.now() - stat.mtimeMs > STALE_TMP_DIR_MAX_AGE_MS) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log(`[db] Removed stale temp directory left over from a previous crashed request: ${fullPath}`);
        }
      } catch (err) {
        console.error(`[db] Failed to inspect/remove candidate stale temp directory ${fullPath}:`, err);
      }
    } else {
      sweepStaleTmpDirs(fullPath);
    }
  }
}

fs.mkdirSync(MEDIA_DIR, { recursive: true });
try {
  sweepStaleTmpDirs(MEDIA_DIR);
} catch (err) {
  console.error("[db] Startup tmp-dir sweep failed (non-fatal, continuing):", err);
}

interface Store {
  videos: Record<string, VideoRecord>;
  trendBatches: Record<string, TrendBatch>;
  creators: Record<string, TrackedCreator>;
  users: Record<string, User>;
  creationProjects: Record<string, CreationProject>;
  // Per-user daily journal chat log ("write like a diary, AI replies like a
  // friend" — see src/lib/journal.ts and /api/journal), keyed by userId.
  journalEntries: Record<string, JournalEntry[]>;
  shopifyAccessToken?: string | null;
  // Cached result of the last full FastMoss category-tree scan (see
  // src/lib/fastmossCategoryScan.ts) — which category ids actually returned
  // any trending videos, so the category picker on Trend Analysis can hide
  // dead-end categories instead of the user discovering them by trial and
  // error. Scanning the whole tree costs real paid API credits per node, so
  // this is deliberately cached to disk rather than re-derived on every
  // page load — only a fresh scan (user-triggered) updates it.
  fastmossCategoryValidity?: {
    validIds: string[];
    scannedAt: string; // ISO timestamp
    totalNodes: number; // how many category nodes existed in the tree at scan time
    totalTested: number; // how many were actually successfully tested (may be < totalNodes if some errored/skipped)
  } | null;
  // Last completed run of the scheduled full-catalog trend refresh (see
  // src/lib/fastmossFullRefresh.ts) — every confirmed-valid FastMoss
  // category re-pulled on a fixed cadence (TREND_REFRESH_INTERVAL_MS in
  // trends.ts) so the Trend Analysis page has a broad, already-processed
  // video library instead of making the first visitor of the day wait on a
  // live pull. Persisted (not just kept in memory) so the schedule survives
  // a server restart/redeploy.
  lastTrendFullRefresh?: {
    finishedAt: string; // ISO timestamp
    categoriesProcessed: number;
    categoriesTotal: number;
    status: "done" | "error";
    error?: string | null;
  } | null;
}

// Simple JSON-file-backed store. This app is a small internal team tool with
// low write concurrency, so a synchronous read-modify-write is sufficient and
// avoids depending on a native SQLite module (which needs a compiler toolchain
// and can be finicky across hosting environments).
let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  if (fs.existsSync(DB_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
      if (!cache!.trendBatches) cache!.trendBatches = {};
      if (!cache!.creators) cache!.creators = {};
      if (!cache!.users) cache!.users = {};
      if (!cache!.creationProjects) cache!.creationProjects = {};
      if (!cache!.journalEntries) cache!.journalEntries = {};
    } catch (err) {
      // db.json exists but couldn't be parsed — this must never happen
      // silently. Back up the unreadable file (its bytes might still be
      // partially recoverable by hand even though JSON.parse rejects it)
      // before falling back to an empty store, and log loudly so this is
      // impossible to miss in the deploy logs.
      const backupPath = `${DB_FILE}.corrupt.${Date.now()}`;
      try {
        fs.copyFileSync(DB_FILE, backupPath);
        console.error(
          `[db] db.json failed to parse — backed up the unreadable file to ${backupPath} before starting from an empty store. This should be investigated; data may be recoverable from the backup. Original error:`,
          err
        );
      } catch (backupErr) {
        console.error(
          `[db] db.json failed to parse AND could not be backed up (both must be investigated immediately — the original file is still at ${DB_FILE}, do not delete it). Parse error:`,
          err,
          "Backup error:",
          backupErr
        );
      }
      cache = { videos: {}, trendBatches: {}, creators: {}, users: {}, creationProjects: {}, journalEntries: {} };
    }
  } else {
    cache = { videos: {}, trendBatches: {}, creators: {}, users: {}, creationProjects: {}, journalEntries: {} };
  }
  seedAdminUser(cache as Store);
  grandfatherPreExistingAccounts(cache as Store);
  return cache as Store;
}

// One-time grandfathering for the /pricing plan-gate feature (see
// src/middleware.ts + src/lib/auth.ts's planActive). Accounts created
// before this feature shipped never had a planStatus field at all, so it
// reads as `undefined` — distinct from a freshly-registered member, who
// always gets an explicit "none" from createUser() below. Only rows with
// the field truly absent get grandfathered to "active" here, so brand-new
// signups are never accidentally let in for free. Safe to call on every
// load(): once a user's planStatus is set to anything, this becomes a
// no-op for them.
function grandfatherPreExistingAccounts(store: Store) {
  let changed = false;
  for (const user of Object.values(store.users)) {
    if (user.planStatus === undefined) {
      user.planStatus = "active";
      changed = true;
    }
  }
  if (changed) persist();
}

// The app originally had exactly one account, authenticated straight
// against ADMIN_USERNAME/ADMIN_PASSWORD env vars (no user table at all).
// Multi-user login replaces that with a real users store, but shouldn't
// break anyone's existing login — the first time this runs against a store
// with no users yet, it creates an "admin" role user from those same env
// vars so the existing credentials keep working with zero config changes.
// Safe to call on every load(): it only acts when store.users is empty.
// Called from inside load() itself, after `cache` has already been
// assigned, so the shared persist() below (same OneDrive-lock retry logic
// as every other write in this file) already has something to write.
function seedAdminUser(store: Store) {
  if (Object.keys(store.users).length > 0) return;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;
  const id = crypto.randomUUID();
  store.users[id] = {
    id,
    username,
    passwordHash: hashPassword(password),
    role: "admin",
    createdAt: new Date().toISOString(),
  };
  persist();
}

// Synchronous sleep, used only for the retry backoff below. Fine to block
// the event loop briefly here — this only fires on the rare occasion a
// write collides with a lock (see persist()).
function sleepSync(ms: number) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

// Writing db.json can transiently fail with EBUSY/EPERM when this project
// folder lives inside a OneDrive (or similar) sync client — OneDrive briefly
// locks files while scanning/uploading them, the same issue that shows up
// as "resource busy or locked" against .next during dev. A bulk import (the
// trend pull creates/updates dozens of video records in one request, each
// triggering a persist()) used to hit this often enough to crash the whole
// request with an uncaught exception. Retry with backoff instead of letting
// one transient lock take down the request.
function persist() {
  if (!cache) return;
  const json = JSON.stringify(cache, null, 2);
  const tmpFile = `${DB_FILE}.tmp.${process.pid}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.writeFileSync(tmpFile, json, "utf-8");
      fs.renameSync(tmpFile, DB_FILE);
      return;
    } catch (err: any) {
      lastErr = err;
      if (err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOENT")) {
        sleepSync(120);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function getMediaDir() {
  return MEDIA_DIR;
}

export function createVideoRecord(
  id: string,
  source_url: string,
  opts?: {
    isReference?: boolean;
    referenceOf?: string | null;
    source?: "manual" | "trend" | "creator";
    creator?: CreatorInfo | null;
    trackedCreatorId?: string | null;
    ownerId?: string | null;
  }
) {
  const store = load();
  store.videos[id] = {
    id,
    ownerId: opts?.ownerId ?? null,
    source_url,
    webpage_url: null,
    title: "",
    description: "",
    author: "",
    author_id: "",
    duration_sec: null,
    stats: { play_count: null, digg_count: null, comment_count: null, share_count: null },
    hashtags: [],
    video_path: null,
    thumbnail_path: null,
    transcript_text: "",
    transcript_segments: [],
    analysis: null,
    canvas: { cardPositions: {}, notes: [], images: [], connections: [], videoPosition: null, zoom: 1, pan: { x: 0, y: 0 } },
    is_reference: opts?.isReference ?? false,
    generated_scripts: [],
    reference_of: opts?.referenceOf ?? null,
    source: opts?.source ?? "manual",
    creator: opts?.creator ?? null,
    tracked_creator_id: opts?.trackedCreatorId ?? null,
    status: "pending",
    error_message: null,
    created_at: new Date().toISOString(),
  };
  persist();
}

// Look up an existing video record by its original source URL. Used by the
// trend importer to avoid re-fetching/re-transcribing a video that was
// already pulled in a previous week's (or the same week's) FastMoss batch.
export function findVideoByUrl(source_url: string): VideoRecord | null {
  const store = load();
  return Object.values(store.videos).find((v) => v.source_url === source_url) || null;
}

export function updateVideoRecord(id: string, patch: Partial<VideoRecord>) {
  const store = load();
  const existing = store.videos[id];
  if (!existing) return;
  store.videos[id] = { ...existing, ...patch };
  persist();
}

export function getVideo(id: string): VideoRecord | null {
  const store = load();
  return store.videos[id] || null;
}

export function listVideos(): VideoRecord[] {
  const store = load();
  return Object.values(store.videos).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

// Removes a video record and best-effort deletes its downloaded media
// (video/thumbnail/extracted-audio) from disk. Any of those files may be
// missing (e.g. a video that errored before download finished) — failures
// there are swallowed rather than blocking the record deletion itself.
export function deleteVideoRecord(id: string) {
  const store = load();
  const video = store.videos[id];
  if (!video) return;
  for (const p of [video.video_path, video.thumbnail_path]) {
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore — file may not exist, or still be locked (OneDrive, etc.)
    }
  }
  try {
    fs.unlinkSync(path.join(MEDIA_DIR, `${id}.mp3`));
  } catch {
    // ignore
  }
  delete store.videos[id];
  persist();
}

export function createTrendBatch(batch: TrendBatch) {
  const store = load();
  store.trendBatches[batch.id] = batch;
  persist();
}

export function deleteTrendBatch(id: string) {
  const store = load();
  delete store.trendBatches[id];
  persist();
}

export function updateTrendBatch(id: string, patch: Partial<TrendBatch>) {
  const store = load();
  const existing = store.trendBatches[id];
  if (!existing) return;
  store.trendBatches[id] = { ...existing, ...patch };
  persist();
}

export function listTrendBatches(): TrendBatch[] {
  const store = load();
  return Object.values(store.trendBatches).sort(
    (a, b) => new Date(b.date_to).getTime() - new Date(a.date_to).getTime()
  );
}

// Most-recently-created stored batch for a given FastMoss category_id, if
// any — lets the personalized "For You" section on Trend Analysis reuse a
// recent pull (see FRESH_MS in /api/trends/personalized) instead of hitting
// FastMoss's paid API again every time a user with that saved category
// visits the page. Any user (or the admin's manual "Update" button) that
// already refreshed this exact category recently benefits everyone who has
// it saved.
export function getLatestTrendBatchByCategory(categoryId: string): TrendBatch | null {
  const store = load();
  const matches = Object.values(store.trendBatches)
    .filter((b) => b.category_id === categoryId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return matches[0] || null;
}

// One batch per distinct category (whichever was created most recently) —
// the source data for the "All Categories · Top Selling" aggregated feed
// (see /api/trends/top-videos-all), which merges every category's latest
// pull into one globally-sorted list instead of showing them as separate
// per-category sections. Falls back to grouping by the raw category label
// for older batches ingested before category_id existed (manually-pasted
// ones, mainly).
export function listLatestTrendBatchPerCategory(): TrendBatch[] {
  const store = load();
  const byCategory = new Map<string, TrendBatch>();
  for (const b of Object.values(store.trendBatches)) {
    const key = b.category_id || b.category;
    const existing = byCategory.get(key);
    if (!existing || new Date(b.created_at).getTime() > new Date(existing.created_at).getTime()) {
      byCategory.set(key, b);
    }
  }
  return Array.from(byCategory.values());
}

// ---- Scheduled full-catalog trend refresh (see fastmossFullRefresh.ts) ----

export function setLastTrendFullRefresh(data: {
  finishedAt: string;
  categoriesProcessed: number;
  categoriesTotal: number;
  status: "done" | "error";
  error?: string | null;
}) {
  const store = load();
  store.lastTrendFullRefresh = data;
  persist();
}

export function getLastTrendFullRefresh() {
  const store = load();
  return store.lastTrendFullRefresh || null;
}

// ---- Creator Tracker ----

export function createTrackedCreator(id: string, handle: string, profileUrl: string) {
  const store = load();
  store.creators[id] = {
    id,
    handle,
    profile_url: profileUrl,
    name: null,
    avatar_url: null,
    followers: null,
    tags: [],
    status: "pending",
    error_message: null,
    last_scanned_at: null,
    created_at: new Date().toISOString(),
    videos: [],
    affiliate: null,
  };
  persist();
}

export function updateTrackedCreator(id: string, patch: Partial<TrackedCreator>) {
  const store = load();
  const existing = store.creators[id];
  if (!existing) return;
  store.creators[id] = { ...existing, ...patch };
  persist();
}

export function getTrackedCreator(id: string): TrackedCreator | null {
  const store = load();
  return store.creators[id] || null;
}

export function listTrackedCreators(): TrackedCreator[] {
  const store = load();
  return Object.values(store.creators).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export function findCreatorByHandle(handle: string): TrackedCreator | null {
  const store = load();
  const lower = handle.toLowerCase();
  return Object.values(store.creators).find((c) => c.handle.toLowerCase() === lower) || null;
}

export function deleteTrackedCreator(id: string) {
  const store = load();
  delete store.creators[id];
  persist();
}

// Shopify OAuth access token, obtained once via the /api/shopify/oauth
// install flow and persisted here so the app doesn't need a manually
// copy-pasted token in .env (which for dev-dashboard-created apps isn't
// available as a simple static value — it requires completing OAuth).
export function setShopifyToken(token: string) {
  const store = load();
  store.shopifyAccessToken = token;
  persist();
}

export function getShopifyToken(): string | null {
  const store = load();
  return store.shopifyAccessToken || null;
}

// ---- FastMoss category-tree scan cache ----

export function setFastmossCategoryValidity(data: {
  validIds: string[];
  scannedAt: string;
  totalNodes: number;
  totalTested: number;
}) {
  const store = load();
  store.fastmossCategoryValidity = data;
  persist();
}

export function getFastmossCategoryValidity() {
  const store = load();
  return store.fastmossCategoryValidity || null;
}

// ---- Users (multi-user login) ----

export function createUser(username: string, password: string, role: UserRole = "member"): User {
  const store = load();
  const id = crypto.randomUUID();
  const user: User = {
    id,
    username,
    passwordHash: hashPassword(password),
    role,
    // Every freshly self-registered member starts on the Starter tab set
    // (Video Analysis / Trend Analysis / Creation — see
    // src/lib/accessTier.ts) rather than the "unset -> treated as business"
    // fallback used for pre-existing accounts. An admin can still upgrade
    // to Pro/Business (adds Creator Tracker) from User Data.
    accessTier: role === "member" ? "starter" : null,
    createdAt: new Date().toISOString(),
    // Every freshly self-registered member starts gated at /pricing (see
    // src/middleware.ts) — role "admin" bypasses the plan gate entirely
    // regardless of this field, so it's harmless left "none" here too.
    planStatus: role === "member" ? "none" : "active",
  };
  store.users[id] = user;
  persist();
  return user;
}

export function getUserByUsername(username: string): User | null {
  const store = load();
  const lower = username.toLowerCase();
  return Object.values(store.users).find((u) => u.username.toLowerCase() === lower) || null;
}

export function getUserById(id: string): User | null {
  const store = load();
  return store.users[id] || null;
}

export function listUsers(): User[] {
  const store = load();
  return Object.values(store.users).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function updateUser(id: string, patch: Partial<User>) {
  const store = load();
  const existing = store.users[id];
  if (!existing) return;
  store.users[id] = { ...existing, ...patch };
  persist();
}

// Bumps this member's usage count for one reaction emotion by 1 (see
// User.reactionEmotionUsage / REACTION_EMOTIONS in types.ts) — called by the
// script-generation routes right after a successful generation that had an
// emotion selected. Returns the updated usage map so the caller can hand it
// straight back in the response without a second read. No-op (returns {})
// if the user doesn't exist.
export function incrementReactionEmotionUsage(userId: string, emotion: ReactionEmotion): Partial<Record<ReactionEmotion, number>> {
  const store = load();
  const user = store.users[userId];
  if (!user) return {};
  const usage = { ...(user.reactionEmotionUsage || {}) };
  usage[emotion] = (usage[emotion] || 0) + 1;
  store.users[userId] = { ...user, reactionEmotionUsage: usage };
  persist();
  return usage;
}

// ---- Journal chat (per-user diary-style chat, see /api/journal) ----

export function addJournalEntry(userId: string, entry: JournalEntry) {
  const store = load();
  if (!store.journalEntries[userId]) store.journalEntries[userId] = [];
  store.journalEntries[userId].push(entry);
  persist();
  return entry;
}

export function listJournalEntries(userId: string, limit = 100): JournalEntry[] {
  const store = load();
  const entries = store.journalEntries[userId] || [];
  return entries.slice(-limit);
}

// ---- Creation projects ----

export function createCreationProject(ownerId: string, title: string): CreationProject {
  const store = load();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const project: CreationProject = {
    id,
    ownerId,
    title,
    shopifyProductId: null,
    shopifyProductTitle: null,
    storyboard: null,
    createdAt: now,
    updatedAt: now,
  };
  store.creationProjects[id] = project;
  persist();
  return project;
}

export function getCreationProject(id: string): CreationProject | null {
  const store = load();
  return store.creationProjects[id] || null;
}

export function listCreationProjectsByOwner(ownerId: string): CreationProject[] {
  const store = load();
  return Object.values(store.creationProjects)
    .filter((p) => p.ownerId === ownerId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// Every account's implicit "single canvas" — used both by the /creation
// page redirect (members skip the project list entirely and land straight
// on this) and by the trend-video "Add to Creation" import route. Reuses
// whichever project the account already has (their most-recently-updated
// one, since listCreationProjectsByOwner is sorted that way) so repeated
// visits/imports keep landing in the same place instead of spawning a new
// canvas every time; auto-creates one named "My Canvas" the very first time
// an account has none yet. This is intentionally the same resolution logic
// regardless of role — an admin calling this also just gets their own
// most-recent project, same as anyone; admins still separately have the
// full multi-project list UI for themselves, this helper is just for
// "give me *a* canvas to act on" call sites like the trend importer.
export function getOrCreateDefaultCreationProject(ownerId: string): CreationProject {
  const existing = listCreationProjectsByOwner(ownerId);
  if (existing.length > 0) return existing[0];
  return createCreationProject(ownerId, "My Canvas");
}

// For the admin overview grid — every member who owns at least one project,
// plus their project count, without needing the admin to open each one.
export function listCreationOwnersSummary(): { ownerId: string; projectCount: number; lastUpdatedAt: string }[] {
  const store = load();
  const byOwner = new Map<string, { count: number; lastUpdatedAt: string }>();
  for (const p of Object.values(store.creationProjects)) {
    const existing = byOwner.get(p.ownerId);
    if (!existing) {
      byOwner.set(p.ownerId, { count: 1, lastUpdatedAt: p.updatedAt });
    } else {
      existing.count += 1;
      if (new Date(p.updatedAt).getTime() > new Date(existing.lastUpdatedAt).getTime()) existing.lastUpdatedAt = p.updatedAt;
    }
  }
  return Array.from(byOwner.entries())
    .map(([ownerId, v]) => ({ ownerId, projectCount: v.count, lastUpdatedAt: v.lastUpdatedAt }))
    .sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
}

export function updateCreationProject(id: string, patch: Partial<CreationProject>) {
  const store = load();
  const existing = store.creationProjects[id];
  if (!existing) return;
  store.creationProjects[id] = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  persist();
}

export function deleteCreationProject(id: string) {
  const store = load();
  delete store.creationProjects[id];
  persist();
}
