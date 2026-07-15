import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { VideoRecord, TrendBatch, CreatorInfo, TrackedCreator, User, UserRole, CreationProject } from "./types";
import { hashPassword } from "./password";

const DATA_DIR = path.join(process.cwd(), "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(MEDIA_DIR, { recursive: true });

interface Store {
  videos: Record<string, VideoRecord>;
  trendBatches: Record<string, TrendBatch>;
  creators: Record<string, TrackedCreator>;
  users: Record<string, User>;
  creationProjects: Record<string, CreationProject>;
  shopifyAccessToken?: string | null;
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
    } catch {
      cache = { videos: {}, trendBatches: {}, creators: {}, users: {}, creationProjects: {} };
    }
  } else {
    cache = { videos: {}, trendBatches: {}, creators: {}, users: {}, creationProjects: {} };
  }
  seedAdminUser(cache as Store);
  return cache as Store;
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
  }
) {
  const store = load();
  store.videos[id] = {
    id,
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

// ---- Users (multi-user login) ----

export function createUser(username: string, password: string, role: UserRole = "member"): User {
  const store = load();
  const id = crypto.randomUUID();
  const user: User = {
    id,
    username,
    passwordHash: hashPassword(password),
    role,
    createdAt: new Date().toISOString(),
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
