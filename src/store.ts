// oauth-hub — Standalone whitelabel hub for Meta channels.
// Copyright (C) 2026 Comunidade ZDG
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of version 3 of the GNU Affero General Public License as
// published by the Free Software Foundation.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Source: https://github.com/pedroherpeto/oauth-hub-zdg

// ─────────────────────────────────────────────────────────────────────────────
// Tiny file-backed JSON stores (no database dependency).
// Atomic writes via temp file + rename; debounced async save.
// Stores: settings (global), apps (multi-app), channels, events.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Channel, MetaApp, WebhookEvent } from "./types";
import { resolveMetaApiVersion } from "./meta-version";

export const DATA_DIR = path.join(__dirname, "..", "data");
const ENCRYPTED_PREFIX = "enc:v1:";
const DATA_KEY_FILE = ".data-encryption-key";
let dataKeyCache: Buffer | null = null;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

function envSecret(name: string): string {
  return (process.env[name] || "").trim();
}

function dataKey(forWrite: boolean): Buffer {
  if (dataKeyCache) return dataKeyCache;
  const configured = envSecret("DATA_ENCRYPTION_KEY");
  if (configured) {
    dataKeyCache = /^[a-f0-9]{64}$/i.test(configured)
      ? Buffer.from(configured, "hex")
      : crypto.createHash("sha256").update(configured, "utf8").digest();
    return dataKeyCache;
  }
  ensureDir();
  const keyPath = path.join(DATA_DIR, DATA_KEY_FILE);
  if (fs.existsSync(keyPath)) {
    const saved = fs.readFileSync(keyPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(saved)) throw new Error("invalid persisted data-encryption key");
    dataKeyCache = Buffer.from(saved, "hex");
    return dataKeyCache;
  }
  if (!forWrite) throw new Error("data-encryption key is unavailable");
  dataKeyCache = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, dataKeyCache.toString("hex"), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  console.warn("[store] DATA_ENCRYPTION_KEY not set — generated data/.data-encryption-key for local use.");
  return dataKeyCache;
}

function encryptSecret(value: string): string {
  if (!value || value.startsWith(ENCRYPTED_PREFIX)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey(true), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptSecret(value: string): string {
  if (!value || !value.startsWith(ENCRYPTED_PREFIX)) return value;
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") throw new Error("invalid encrypted secret format");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey(false), Buffer.from(parts[2], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("could not decrypt stored secret; check DATA_ENCRYPTION_KEY");
  }
}

const APP_SECRET_FIELDS: Array<keyof MetaApp> = ["appSecret", "instagramAppSecret", "messengerFallbackToken", "webhookVerifyToken"];

function transformSecrets(file: string, data: unknown, encrypt: boolean): unknown {
  const transform = encrypt ? encryptSecret : decryptSecret;
  if (file === "apps.json" && Array.isArray(data)) {
    return data.map((raw) => {
      const app = { ...(raw as MetaApp) } as MetaApp;
      for (const field of APP_SECRET_FIELDS) {
        const value = app[field];
        if (typeof value === "string") (app as any)[field] = transform(value);
      }
      app.forwards = (app.forwards || []).map((forward) => ({ ...forward, url: transform(forward.url) }));
      return app;
    });
  }
  if (file === "channels.json" && Array.isArray(data)) {
    return data.map((raw) => {
      const channel = { ...(raw as Channel) };
      if (typeof channel.accessToken === "string") channel.accessToken = transform(channel.accessToken);
      return channel;
    });
  }
  if (file === "events.json" && Array.isArray(data)) {
    return data.map((raw) => {
      const event = { ...(raw as WebhookEvent) };
      event.forwards = (event.forwards || []).map((forward) => ({ ...forward, url: transform(forward.url) }));
      return event;
    });
  }
  return data;
}

function containsLegacyPlaintext(file: string, data: unknown): boolean {
  if (file === "apps.json" && Array.isArray(data)) {
    return data.some((raw) => {
      const app = raw as any;
      const plainSecret = APP_SECRET_FIELDS.some((field) => {
        const value = app[field];
        return typeof value === "string" && !!value && !value.startsWith(ENCRYPTED_PREFIX);
      });
      const plainForward = Array.isArray(app.forwards) && app.forwards.some(
        (forward: any) => typeof forward?.url === "string" && !!forward.url && !forward.url.startsWith(ENCRYPTED_PREFIX)
      );
      return plainSecret || plainForward;
    });
  }
  if (file === "channels.json" && Array.isArray(data)) {
    return data.some((raw) => typeof (raw as any).accessToken === "string" && !!(raw as any).accessToken && !(raw as any).accessToken.startsWith(ENCRYPTED_PREFIX));
  }
  if (file === "events.json" && Array.isArray(data)) {
    return data.some((raw) => Array.isArray((raw as any).forwards) && (raw as any).forwards.some(
      (forward: any) => typeof forward?.url === "string" && !!forward.url && !forward.url.startsWith(ENCRYPTED_PREFIX)
    ));
  }
  return false;
}

function readJson<T>(file: string, fallback: T): T {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) return fallback;
  try {
    const stored = JSON.parse(fs.readFileSync(full, "utf-8"));
    const needsMigration = containsLegacyPlaintext(file, stored);
    const decoded = transformSecrets(file, stored, false) as T;
    if (needsMigration) writeJson(file, decoded);
    return decoded;
  } catch (err) {
    console.error(`[store] could not safely read ${file}:`, err instanceof Error ? err.message : "unknown error");
    throw new Error(`[store] refusing startup because ${file} could not be read safely`);
  }
}

function serialized(file: string, data: unknown): string {
  return JSON.stringify(transformSecrets(file, data, true), null, 2);
}

function tempPath(full: string, suffix = "tmp"): string {
  return `${full}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.${suffix}`;
}

function removeIfPresent(file: string): void {
  try { fs.unlinkSync(file); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}

function writeJson(file: string, data: unknown): void {
  ensureDir();
  const full = path.join(DATA_DIR, file);
  const tmp = tempPath(full);
  try {
    fs.writeFileSync(tmp, serialized(file, data), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    fs.renameSync(tmp, full);
    try { fs.chmodSync(full, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  } catch (error) {
    try { removeIfPresent(tmp); } catch { /* retain original error */ }
    throw error;
  }
}

function writeJsonBatch(entries: Array<{ file: string; data: unknown }>): void {
  ensureDir();
  const prepared = entries.map(({ file, data }) => {
    const full = path.join(DATA_DIR, file);
    return {
      file,
      full,
      tmp: tempPath(full),
      previous: fs.existsSync(full) ? fs.readFileSync(full) : null,
      content: serialized(file, data),
    };
  });

  try {
    for (const entry of prepared) {
      fs.writeFileSync(entry.tmp, entry.content, { encoding: "utf-8", mode: 0o600 });
      try { fs.chmodSync(entry.tmp, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    }
  } catch (error) {
    for (const entry of prepared) try { removeIfPresent(entry.tmp); } catch { /* retain original error */ }
    throw error;
  }

  const committed: typeof prepared = [];
  try {
    for (const entry of prepared) {
      fs.renameSync(entry.tmp, entry.full);
      try { fs.chmodSync(entry.full, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
      committed.push(entry);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const entry of [...committed].reverse()) {
      try {
        if (entry.previous === null) {
          removeIfPresent(entry.full);
        } else {
          const rollback = tempPath(entry.full, "rollback");
          fs.writeFileSync(rollback, entry.previous, { mode: 0o600 });
          fs.renameSync(rollback, entry.full);
          try { fs.chmodSync(entry.full, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const entry of prepared) try { removeIfPresent(entry.tmp); } catch { /* retain original error */ }
    if (rollbackErrors.length) {
      throw new Error(`Store transaction failed and could not be fully rolled back: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    throw error;
  }
}

// ─── Settings (global, non-app) ───────────────────────────────────────────────

interface GlobalSettings { brandName?: string; updatedAt?: string }
let settingsCache: GlobalSettings = readJson<GlobalSettings>("settings.json", {});

export function getSettings(): GlobalSettings {
  return settingsCache;
}
export function saveSettings(next: GlobalSettings): GlobalSettings {
  const updated = { ...settingsCache, ...next, updatedAt: new Date().toISOString() };
  writeJson("settings.json", updated);
  settingsCache = updated;
  return updated;
}

// ─── Apps ─────────────────────────────────────────────────────────────────────

let apps: MetaApp[] = readJson<MetaApp[]>("apps.json", []).map((app) => ({
  ...app,
  apiVersion: resolveMetaApiVersion(app.apiVersion),
}));

export function listApps(): MetaApp[] {
  return apps;
}
export function findApp(id: string): MetaApp | undefined {
  return apps.find((a) => a.id === id);
}
export function addApp(app: MetaApp): MetaApp {
  const normalized = { ...app, apiVersion: resolveMetaApiVersion(app.apiVersion) };
  const next = [...apps, normalized];
  writeJson("apps.json", next);
  apps = next;
  return normalized;
}
export function updateApp(id: string, patch: Partial<MetaApp>): MetaApp | undefined {
  const idx = apps.findIndex((app) => app.id === id);
  if (idx < 0) return undefined;
  const current = apps[idx];
  const updated = {
    ...current,
    ...patch,
    apiVersion: resolveMetaApiVersion(patch.apiVersion ?? current.apiVersion),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const next = [...apps];
  next[idx] = updated;
  writeJson("apps.json", next);
  apps = next;
  return updated;
}
export function deleteApp(id: string): boolean {
  const idx = apps.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  const nextApps = apps.filter((app) => app.id !== id);
  const nextChannels = channels.filter((channel) => channel.appId !== id);
  const nextEvents = events.filter((event) => event.appId !== id);
  writeJsonBatch([
    { file: "apps.json", data: nextApps },
    { file: "channels.json", data: nextChannels },
    { file: "events.json", data: nextEvents },
  ]);
  apps = nextApps;
  channels = nextChannels;
  events = nextEvents;
  return true;
}

// ─── Channels ─────────────────────────────────────────────────────────────────

let channels: Channel[] = readJson<Channel[]>("channels.json", []);

export function listChannels(): Channel[] {
  return channels;
}
export function findChannelByExternalId(externalId: string, appId?: string): Channel | undefined {
  return channels.find((c) => c.externalId === externalId && (!appId || c.appId === appId));
}
export function findChannelsByExternalId(externalId: string): Channel[] {
  return channels.filter((c) => c.externalId === externalId);
}
export function findChannelById(id: string): Channel | undefined {
  return channels.find((c) => c.id === id);
}
export function countChannelsByApp(appId: string): number {
  return channels.filter((c) => c.appId === appId).length;
}
export function upsertChannel(ch: Channel): Channel {
  const idx = channels.findIndex((c) => c.appId === ch.appId && c.externalId === ch.externalId && c.type === ch.type);
  const next = [...channels];
  let updated: Channel;
  if (idx >= 0) {
    updated = { ...channels[idx], ...ch, id: channels[idx].id, createdAt: channels[idx].createdAt };
    next[idx] = updated;
  } else {
    updated = ch;
    next.push(ch);
  }
  writeJson("channels.json", next);
  channels = next;
  return updated;
}
export function deleteChannel(id: string): Channel | undefined {
  const idx = channels.findIndex((c) => c.id === id);
  if (idx < 0) return undefined;
  const removed = channels[idx];
  const next = channels.filter((channel) => channel.id !== id);
  writeJson("channels.json", next);
  channels = next;
  return removed;
}
export function touchChannelEvent(externalId: string, appId?: string): Channel | undefined {
  const idx = channels.findIndex((channel) => channel.externalId === externalId && (!appId || channel.appId === appId));
  if (idx < 0) return undefined;
  const updated = { ...channels[idx], lastEventAt: new Date().toISOString() };
  const next = [...channels];
  next[idx] = updated;
  writeJson("channels.json", next);
  channels = next;
  return updated;
}

// ─── Events (ring buffer) ──────────────────────────────────────────────────────

const EVENTS_MAX = Math.max(50, Number(process.env.WEBHOOK_EVENTS_MAX) || 500);
let events: WebhookEvent[] = readJson<WebhookEvent[]>("events.json", []).slice(-EVENTS_MAX);

export function addEvent(ev: WebhookEvent): void {
  const next = [...events, ev].slice(-EVENTS_MAX);
  writeJson("events.json", next);
  events = next;
}
export function updateEvent(id: string, patch: Partial<WebhookEvent>): void {
  const idx = events.findIndex((event) => event.id === id);
  if (idx < 0) return;
  const next = [...events];
  next[idx] = { ...events[idx], ...patch };
  writeJson("events.json", next);
  events = next;
}
/** Update one forward-result entry of an event (used as async relays complete). */
export function setEventForward(eventId: string, url: string, ok: boolean, status: number | string): void {
  const eventIdx = events.findIndex((event) => event.id === eventId);
  if (eventIdx < 0) return;
  const event = events[eventIdx];
  let forwardIdx = event.forwards.findIndex((forward) => forward.url === url && forward.status === "pending");
  if (forwardIdx < 0) forwardIdx = event.forwards.findIndex((forward) => forward.url === url);
  if (forwardIdx < 0) return;
  const forwards = [...event.forwards];
  forwards[forwardIdx] = { ...forwards[forwardIdx], ok, status };
  const next = [...events];
  next[eventIdx] = { ...event, forwards };
  writeJson("events.json", next);
  events = next;
}
export function listEvents(sinceTs?: string, limit = 100): WebhookEvent[] {
  let out = events;
  if (sinceTs) out = out.filter((e) => e.ts > sinceTs);
  return out.slice(-limit).reverse();
}
export function clearEvents(): void {
  writeJson("events.json", []);
  events = [];
}

/** Aggregate counts for the overview cards. */
export function eventStats(): { total: number; lastHour: number; forwardsLastHour: number } {
  const hourAgo = Date.now() - 3600_000;
  let lastHour = 0;
  let forwardsLastHour = 0;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!isNaN(t) && t >= hourAgo) {
      lastHour++;
      forwardsLastHour += e.forwards ? e.forwards.length : 0;
    }
  }
  return { total: events.length, lastHour, forwardsLastHour };
}
