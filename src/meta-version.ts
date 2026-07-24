// Canonical Meta Graph API version handling shared by storage, HTTP input and SDK consumers.

export const FALLBACK_META_API_VERSION = "v25.0";

/**
 * Accept the common v25.0, v25, 25.0 and 25 forms used in Meta dashboards.
 * Meta Graph API versions always use a zero minor component.
 */
export function normalizeMetaApiVersion(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).trim().match(/^v?(\d{1,3})(?:\.0)?$/i);
  if (!match) return null;
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major) || major < 1) return null;
  return `v${major}.0`;
}

export function resolveMetaApiVersion(value: unknown, fallback = FALLBACK_META_API_VERSION): string {
  return normalizeMetaApiVersion(value) || normalizeMetaApiVersion(fallback) || FALLBACK_META_API_VERSION;
}
