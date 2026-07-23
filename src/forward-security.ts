// NeuroHub Meta — secure forwarding for Meta webhooks.
// Copyright (C) 2026 @goldneuron.io
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of version 3 of the GNU Affero General Public License as
// published by the Free Software Foundation.
//
// See <https://www.gnu.org/licenses/>.

import dns from "dns";
import http from "http";
import https from "https";
import net from "net";
import {
  ALLOW_INSECURE_FORWARD_URLS,
  FORWARD_ALLOWED_HOSTS,
  IS_PRODUCTION,
} from "./config";

export class UnsafeForwardUrlError extends Error {
  constructor(message = "Unsafe forward URL") {
    super(message);
    this.name = "UnsafeForwardUrlError";
  }
}

const blockedIpv6 = new net.BlockList();
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96],
  ["100::", 64], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as Array<[string, number]>) {
  blockedIpv6.addSubnet(address, prefix, "ipv6");
}

function unsafeIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function unsafeIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  try {
    return blockedIpv6.check(normalized, "ipv6");
  } catch {
    return true;
  }
}

export function isUnsafeNetworkAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return unsafeIpv4(address);
  if (family === 6) return unsafeIpv6(address);
  return true;
}

function hostAllowed(hostname: string): boolean {
  if (!FORWARD_ALLOWED_HOSTS.length) return true;
  return FORWARD_ALLOWED_HOSTS.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

/** Synchronous validation used when saving configuration. */
export function validateForwardUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeForwardUrlError("Forward URL is invalid");
  }
  if (url.protocol !== "https:") {
    const developmentHttp = !IS_PRODUCTION && ALLOW_INSECURE_FORWARD_URLS && url.protocol === "http:";
    if (!developmentHttp) throw new UnsafeForwardUrlError("Forward URL must use HTTPS");
  }
  if (url.username || url.password) throw new UnsafeForwardUrlError("Forward URL cannot contain credentials");
  if (url.hash) throw new UnsafeForwardUrlError("Forward URL cannot contain a fragment");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new UnsafeForwardUrlError("Forward URL hostname is not allowed");
  }
  if (!hostAllowed(hostname)) throw new UnsafeForwardUrlError("Forward URL hostname is outside the allowlist");
  if (net.isIP(hostname) && isUnsafeNetworkAddress(hostname)) {
    throw new UnsafeForwardUrlError("Forward URL resolves to a private or reserved address");
  }
  return url;
}

function timeoutError(): Error {
  const error = new Error("Forward request timed out");
  error.name = "AbortError";
  return error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SafeDestination {
  url: URL;
  address: string;
  family: number;
}

/** Resolve once, reject every unsafe answer and return an address to pin on the socket. */
async function resolveSafeDestination(raw: string, timeoutMs: number): Promise<SafeDestination> {
  const url = validateForwardUrl(raw);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const literalFamily = net.isIP(hostname);
  if (literalFamily) return { url, address: hostname, family: literalFamily };

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await withTimeout(dns.promises.lookup(hostname, { all: true, verbatim: true }), timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new UnsafeForwardUrlError("Forward URL hostname could not be resolved safely");
  }
  if (!addresses.length || addresses.some(({ address }) => isUnsafeNetworkAddress(address))) {
    throw new UnsafeForwardUrlError("Forward URL resolves to a private or reserved address");
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

/** DNS-aware validation repeated immediately before every outbound request. */
export async function assertSafeForwardUrl(raw: string): Promise<string> {
  return (await resolveSafeDestination(raw, 10_000)).url.toString();
}

export interface SafeForwardResponse {
  ok: boolean;
  status: number;
}

/**
 * POST through a socket pinned to the already validated DNS answer. Native
 * http(s).request does not follow redirects, closing both redirect and DNS
 * rebinding paths that a second resolver pass in fetch() would reopen.
 */
export async function postSafeForwardUrl(
  raw: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<SafeForwardResponse> {
  const startedAt = Date.now();
  const destination = await resolveSafeDestination(raw, timeoutMs);
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw timeoutError();
  const transport = destination.url.protocol === "https:" ? https : http;
  const requestHeaders = { ...headers, "Content-Length": String(Buffer.byteLength(body)) };

  return new Promise<SafeForwardResponse>((resolve, reject) => {
    const lookup = ((_hostname: string, options: any, callback: any) => {
      if (options?.all) callback(null, [{ address: destination.address, family: destination.family }]);
      else callback(null, destination.address, destination.family);
    }) as any;
    const request = transport.request(destination.url, {
      method: "POST",
      headers: requestHeaders,
      lookup,
    }, (response) => {
      const status = response.statusCode || 0;
      response.destroy();
      resolve({ ok: status >= 200 && status < 300, status });
    });
    request.setTimeout(remainingMs, () => request.destroy(timeoutError()));
    request.once("error", reject);
    request.end(body);
  });
}
