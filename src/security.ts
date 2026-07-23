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
// Security primitives: signed tokens (HMAC), OAuth state, panel sessions,
// webhook signature verification, and the admin-auth middleware.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { SESSION_SECRET, ADMIN_PASSWORD, IS_PRODUCTION, PUBLIC_URL } from "./config";
import { ChannelType, OAuthState } from "./types";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64: string): string {
  return b64url(crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest());
}

/** Generic signed token: `<payloadB64>.<sigB64>`. Returns payload or null. */
function verifyToken<T>(token: string, maxAgeMs: number): (T & { iat: number }) | null {
  if (!token || token.indexOf(".") < 0) return null;
  const [payloadB64, sig] = token.split(".");
  const expected = sign(payloadB64);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data: any;
  try {
    data = JSON.parse(b64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof data.iat !== "number") return null;
  if (Date.now() - data.iat > maxAgeMs) return null;
  return data;
}

function makeToken(payload: Record<string, any>): string {
  const body = { ...payload, iat: Date.now() };
  const payloadB64 = b64url(JSON.stringify(body));
  return `${payloadB64}.${sign(payloadB64)}`;
}

// ─── OAuth state (CSRF protection for the connect flow) ───────────────────────

const STATE_TTL_MS = 30 * 60 * 1000; // 30 min

export function encodeState(channel: ChannelType, appId: string, lang: string): string {
  return makeToken({ channel, appId, lang: lang || "pt", nonce: crypto.randomBytes(8).toString("hex") });
}

export function decodeState(token: string): OAuthState | null {
  const data = verifyToken<OAuthState>(token, STATE_TTL_MS);
  if (!data) return null;
  if (data.channel !== "waba" && data.channel !== "messenger" && data.channel !== "instagram") return null;
  if (!data.appId || typeof data.appId !== "string") return null;
  return { channel: data.channel, appId: data.appId, lang: data.lang || "pt", nonce: data.nonce, iat: data.iat };
}

const consumedOAuthNonces = new Map<string, number>();

/** Validate and atomically consume an OAuth state nonce. A replay returns null. */
export function consumeState(token: string): OAuthState | null {
  const state = decodeState(token);
  if (!state) return null;
  const now = Date.now();
  for (const [nonce, consumedAt] of consumedOAuthNonces) {
    if (now - consumedAt > STATE_TTL_MS) consumedOAuthNonces.delete(nonce);
  }
  if (consumedOAuthNonces.has(state.nonce)) return null;
  consumedOAuthNonces.set(state.nonce, now);
  return state;
}

// ─── Panel session token ──────────────────────────────────────────────────────

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
export const SESSION_COOKIE_NAME = "hub_session";

export function issueSession(): string {
  return makeToken({ role: "admin" });
}

export function isValidSession(token: string): boolean {
  return verifyToken<{ role: string }>(token, SESSION_TTL_MS)?.role === "admin";
}

function cookieValue(req: Request, name: string): string {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
  }
  return "";
}

function secureCookieRequired(): boolean {
  if (IS_PRODUCTION) return true;
  try { return new URL(PUBLIC_URL).protocol === "https:"; } catch { return false; }
}

export function setSessionCookie(res: Response, token: string): void {
  const secure = secureCookieRequired() ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
  );
}

export function clearSessionCookie(res: Response): void {
  const secure = secureCookieRequired() ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

/** Constant-time password compare. */
export function passwordMatches(input: string): boolean {
  if (!ADMIN_PASSWORD) return true; // auth disabled
  const a = Buffer.from(String(input || ""));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Express middleware — protects panel/admin APIs. Open when no ADMIN_PASSWORD. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_PASSWORD) return next(); // open mode (dev)
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const token = cookieValue(req, SESSION_COOKIE_NAME) || bearer;
  if (token && isValidSession(token)) return next();
  res.status(401).json({ error: "UNAUTHORIZED" });
}

// ─── Webhook signature (X-Hub-Signature-256) ──────────────────────────────────

/**
 * Returns true/false when an app secret is available, or null when it cannot be
 * checked (no secret configured). Compares against the raw request body.
 */
export function verifyWebhookSignature(
  rawBody: string | undefined,
  signatureHeader: string | undefined,
  appSecret: string
): boolean | null {
  if (!appSecret) return null;
  if (!rawBody || !signatureHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function newId(): string {
  return crypto.randomBytes(12).toString("hex");
}
