// NeuroHub Meta — partner forwarding signatures.
// Copyright (C) 2026 @goldneuron.io
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of version 3 of the GNU Affero General Public License as
// published by the Free Software Foundation.
//
// See <https://www.gnu.org/licenses/>.

import crypto from "crypto";

const MIN_FORWARD_SIGNING_SECRET_BYTES = 32;
const MAX_FORWARD_SIGNING_SECRET_BYTES = 512;

export class InvalidForwardSigningSecretError extends Error {
  constructor(message = "forward signing secret must be at least 32 bytes") {
    super(message);
    this.name = "InvalidForwardSigningSecretError";
  }
}

/** Normalize and validate a dedicated partner secret; never use the Meta App Secret here. */
export function normalizeForwardSigningSecret(value: unknown): string {
  if (typeof value !== "string") throw new InvalidForwardSigningSecretError();
  const secret = value.trim();
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MIN_FORWARD_SIGNING_SECRET_BYTES) {
    throw new InvalidForwardSigningSecretError("forward signing secret must be at least 32 bytes");
  }
  if (bytes > MAX_FORWARD_SIGNING_SECRET_BYTES) {
    throw new InvalidForwardSigningSecretError("forward signing secret must be at most 512 bytes");
  }
  return secret;
}

/** Sign `${timestamp}.${rawBody}` so receivers can reject stale/replayed deliveries. */
export function signForwardPayload(rawBody: string, signingSecret: string, timestamp: string): string {
  const digest = crypto.createHmac("sha256", signingSecret)
    .update(`${timestamp}.`, "utf8")
    .update(rawBody, "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

export function buildForwardHeaders(
  appId: string,
  rawBody: string,
  originalMetaSignature: string | undefined,
  signingSecret: string | undefined,
  timestamp = Math.floor(Date.now() / 1000).toString()
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hub-App": appId,
  };
  if (originalMetaSignature) headers["X-Hub-Signature-256"] = originalMetaSignature;
  if (signingSecret) {
    headers["X-NeuroHub-Timestamp"] = timestamp;
    headers["X-NeuroHub-Signature-256"] = signForwardPayload(rawBody, signingSecret, timestamp);
  }
  return headers;
}
