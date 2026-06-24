// ─────────────────────────────────────────────────────────────────────────────
// Thin wrappers over the Meta Graph API used by the connect flows.
// All calls use the server-held App Secret; nothing here runs in the browser.
// ─────────────────────────────────────────────────────────────────────────────

const FB_GRAPH = "https://graph.facebook.com";
const IG_GRAPH = "https://graph.instagram.com";
const IG_OAUTH = "https://api.instagram.com";

export interface TokenResult {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string; type?: string; code?: number };
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  return r.json();
}

/**
 * Exchange an OAuth `code` for an access token (Facebook/WhatsApp flows).
 * Embedded Signup codes work WITHOUT a redirect_uri — pass null in that case.
 */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string | null,
  apiVersion: string
): Promise<TokenResult> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);
  if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);
  return getJson(url.toString());
}

/** Exchange a short-lived user token for a long-lived one (≈60 days). */
export async function getLongLivedUserToken(
  shortToken: string,
  appId: string,
  appSecret: string,
  apiVersion: string
): Promise<string> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", shortToken);
  const data = (await getJson(url.toString())) as TokenResult;
  return data.access_token || shortToken;
}

export interface FbPage {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
}

/** Fetch the Facebook Pages the user manages (id, name, page token). */
export async function getUserPages(userToken: string, apiVersion: string): Promise<{ pages: FbPage[]; error?: any }> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,tasks");
  url.searchParams.set("access_token", userToken);
  const data = await getJson(url.toString());
  return { pages: data.data || [], error: data.error };
}

/** Which permissions the user granted/declined (diagnostics for "no pages"). */
export async function getMePermissions(token: string, apiVersion: string): Promise<{ granted: string[]; declined: string[] }> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/me/permissions`);
  url.searchParams.set("access_token", token);
  const data = await getJson(url.toString());
  const list: Array<{ permission: string; status: string }> = data.data || [];
  return {
    granted: list.filter((p) => p.status === "granted").map((p) => p.permission),
    declined: list.filter((p) => p.status === "declined").map((p) => p.permission),
  };
}

/**
 * Fallback page discovery via Business Manager — for Pages managed in a Business
 * that don't show up under /me/accounts (common with Login for Business tokens).
 */
export async function getBusinessPages(token: string, apiVersion: string): Promise<FbPage[]> {
  const out: FbPage[] = [];
  const seen = new Set<string>();
  try {
    const bizUrl = new URL(`${FB_GRAPH}/${apiVersion}/me/businesses`);
    bizUrl.searchParams.set("fields", "id,name");
    bizUrl.searchParams.set("access_token", token);
    const biz = await getJson(bizUrl.toString());
    for (const b of biz.data || []) {
      for (const edge of ["owned_pages", "client_pages"]) {
        const u = new URL(`${FB_GRAPH}/${apiVersion}/${b.id}/${edge}`);
        u.searchParams.set("fields", "id,name,access_token,tasks");
        u.searchParams.set("access_token", token);
        const r = await getJson(u.toString());
        for (const p of r.data || []) {
          if (p.id && p.access_token && !seen.has(p.id)) {
            seen.add(p.id);
            out.push(p as FbPage);
          }
        }
      }
    }
  } catch {
    /* best effort */
  }
  return out;
}

export interface GranularScope {
  scope: string;
  target_ids?: string[];
}

/**
 * Inspect a user/system token via /debug_token (app-secret authed). Returns the
 * flat scopes plus the granular scopes — the latter carry the asset IDs the user
 * actually granted under Facebook Login for Business (e.g. the chosen Page IDs
 * under `pages_messaging`, the WhatsApp Business IDs under `whatsapp_business_*`).
 */
export async function debugToken(
  userToken: string,
  appId: string,
  appSecret: string,
  apiVersion: string
): Promise<{ scopes: string[]; granularScopes: GranularScope[]; data: any; error?: any }> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/debug_token`);
  url.searchParams.set("input_token", userToken);
  url.searchParams.set("access_token", `${appId}|${appSecret}`);
  const data = await getJson(url.toString());
  const d = data?.data || {};
  return { scopes: d.scopes || [], granularScopes: d.granular_scopes || [], data: d, error: data?.error };
}

/**
 * Page discovery via Login-for-Business granular scopes. With Login for Business,
 * `pages_show_list` is frequently NOT in the configuration, so /me/accounts comes
 * back empty even though the user picked a Page. The page-related granular scopes
 * (pages_messaging, pages_manage_metadata, …) still list the selected Page IDs in
 * `target_ids`; resolve each one to a Page access token directly.
 *
 * Also reports whether the token only carried WhatsApp scopes (no Page scopes) —
 * the signature of a WhatsApp Embedded Signup config_id used by mistake for the
 * Messenger flow, which can never yield a Facebook Page.
 */
export async function getPagesViaGranularScopes(
  userToken: string,
  appId: string,
  appSecret: string,
  apiVersion: string
): Promise<{ pages: FbPage[]; pageScopeFound: boolean; wabaScopeFound: boolean; scopes: string[]; granularScopeNames: string[] }> {
  const out: FbPage[] = [];
  const seen = new Set<string>();
  let pageScopeFound = false;
  let wabaScopeFound = false;
  let scopes: string[] = [];
  let granularScopeNames: string[] = [];
  try {
    const dbg = await debugToken(userToken, appId, appSecret, apiVersion);
    scopes = dbg.scopes;
    granularScopeNames = dbg.granularScopes.map((g) => g.scope);
    const ids = new Set<string>();
    for (const g of dbg.granularScopes) {
      if (/^whatsapp_business_/.test(g.scope)) wabaScopeFound = true;
      if (/^pages_/.test(g.scope)) {
        pageScopeFound = true;
        for (const id of g.target_ids || []) ids.add(String(id));
      }
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      const u = new URL(`${FB_GRAPH}/${apiVersion}/${id}`);
      u.searchParams.set("fields", "id,name,access_token,tasks");
      u.searchParams.set("access_token", userToken);
      const p = await getJson(u.toString());
      if (p?.id && p?.access_token) {
        seen.add(p.id);
        out.push({ id: p.id, name: p.name, access_token: p.access_token, tasks: p.tasks });
      }
    }
  } catch {
    /* best effort */
  }
  return { pages: out, pageScopeFound, wabaScopeFound, scopes, granularScopeNames };
}

/** Resolve the Instagram Business Account attached to a Page (if any). */
export async function getPageInstagramAccount(
  pageId: string,
  pageToken: string,
  apiVersion: string
): Promise<{ id: string; username?: string } | null> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/${pageId}`);
  url.searchParams.set("fields", "instagram_business_account{id,username}");
  url.searchParams.set("access_token", pageToken);
  const data = await getJson(url.toString());
  return data?.instagram_business_account || null;
}

/**
 * Subscribe the app to a Facebook Page's webhooks (Messenger).
 * Returns { ok, error }.
 */
export async function subscribePageApp(
  pageId: string,
  pageToken: string,
  apiVersion: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/${pageId}/subscribed_apps`);
  url.searchParams.set("access_token", pageToken);
  url.searchParams.set(
    "subscribed_fields",
    [
      "messages",
      "messaging_postbacks",
      "messaging_optins",
      "message_deliveries",
      "message_reads",
      "messaging_referrals",
      "messaging_handovers",
    ].join(",")
  );
  const r = await fetch(url.toString(), { method: "POST" });
  const data = await r.json();
  if (data?.success) return { ok: true };
  return { ok: false, error: data?.error?.message || "subscribe_failed" };
}

/**
 * Subscribe the app to a WhatsApp Business Account's webhooks.
 * Uses the business integration system-user token from Embedded Signup.
 */
export async function subscribeWabaApp(
  wabaId: string,
  token: string,
  apiVersion: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(`${FB_GRAPH}/${apiVersion}/${wabaId}/subscribed_apps`);
  url.searchParams.set("access_token", token);
  const r = await fetch(url.toString(), { method: "POST" });
  const data = await r.json();
  if (data?.success) return { ok: true };
  return { ok: false, error: data?.error?.message || "subscribe_failed" };
}

/**
 * Discover WhatsApp Business Accounts (+ their phone numbers) reachable by a
 * token — fallback for when the Embedded Signup didn't return waba_id/phone id.
 * WABA IDs come from the token's whatsapp_business_* granular scope and from
 * Business Manager (owned/client WABAs); each WABA's phone numbers are listed.
 */
export async function getWabasViaToken(
  token: string,
  appId: string,
  appSecret: string,
  apiVersion: string
): Promise<Array<{ waba_id: string; phone_number_id: string; display: string; name: string }>> {
  const wabaIds = new Set<string>();
  try {
    const dbg = await debugToken(token, appId, appSecret, apiVersion);
    for (const g of dbg.granularScopes) {
      if (/^whatsapp_business_/.test(g.scope)) for (const id of g.target_ids || []) wabaIds.add(String(id));
    }
  } catch { /* best effort */ }
  try {
    const bizUrl = new URL(`${FB_GRAPH}/${apiVersion}/me/businesses`);
    bizUrl.searchParams.set("fields", "id");
    bizUrl.searchParams.set("access_token", token);
    const biz = await getJson(bizUrl.toString());
    for (const b of biz.data || []) {
      for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
        const u = new URL(`${FB_GRAPH}/${apiVersion}/${b.id}/${edge}`);
        u.searchParams.set("fields", "id");
        u.searchParams.set("access_token", token);
        const r = await getJson(u.toString());
        for (const w of r.data || []) if (w.id) wabaIds.add(String(w.id));
      }
    }
  } catch { /* best effort */ }
  const out: Array<{ waba_id: string; phone_number_id: string; display: string; name: string }> = [];
  for (const wabaId of wabaIds) {
    try {
      const u = new URL(`${FB_GRAPH}/${apiVersion}/${wabaId}/phone_numbers`);
      u.searchParams.set("fields", "id,display_phone_number,verified_name");
      u.searchParams.set("access_token", token);
      const r = await getJson(u.toString());
      for (const p of r.data || []) {
        if (p.id) out.push({ waba_id: wabaId, phone_number_id: String(p.id), display: p.display_phone_number || "", name: p.verified_name || "" });
      }
    } catch { /* best effort */ }
  }
  return out;
}

/**
 * Discover Instagram Business accounts linked to the token's Pages — fallback for
 * the Instagram connect. Returns the IG account id/username plus the parent Page
 * (whose token + app subscription carry the Instagram messaging webhooks).
 */
export async function getInstagramViaToken(
  token: string,
  apiVersion: string
): Promise<Array<{ ig_id: string; username: string; page_id: string; page_name: string; page_token: string }>> {
  const out: Array<{ ig_id: string; username: string; page_id: string; page_name: string; page_token: string }> = [];
  try {
    const { pages } = await getUserPages(token, apiVersion);
    for (const p of pages) {
      const iga = await getPageInstagramAccount(p.id, p.access_token, apiVersion);
      if (iga && iga.id) {
        out.push({ ig_id: String(iga.id), username: iga.username || `instagram_${iga.id}`, page_id: p.id, page_name: p.name, page_token: p.access_token });
      }
    }
  } catch { /* best effort */ }
  return out;
}

export interface ChannelDetails {
  avatar: string;
  fields: Array<{ k: string; v: string }>;
}

/**
 * Fetch display details (avatar + a few fields) for a connected channel, using
 * the channel's own access token. Best-effort: any failure yields what it could.
 */
export async function getChannelDetails(
  type: string,
  externalId: string,
  chMeta: any,
  token: string,
  apiVersion: string
): Promise<ChannelDetails> {
  const out: ChannelDetails = { avatar: "", fields: [] };
  const base = `${FB_GRAPH}/${apiVersion}`;
  const tk = encodeURIComponent(token);
  try {
    if (type === "waba") {
      const phone = String(chMeta?.phone_number_id || externalId);
      const d = await getJson(`${base}/${phone}?fields=verified_name,display_phone_number,quality_rating,messaging_limit_tier&access_token=${tk}`);
      if (d && !d.error) {
        if (d.display_phone_number) out.fields.push({ k: "number", v: d.display_phone_number });
        if (d.verified_name) out.fields.push({ k: "name", v: d.verified_name });
        if (d.quality_rating) out.fields.push({ k: "quality", v: d.quality_rating });
        if (d.messaging_limit_tier) out.fields.push({ k: "tier", v: String(d.messaging_limit_tier) });
      }
      const prof = await getJson(`${base}/${phone}/whatsapp_business_profile?fields=profile_picture_url&access_token=${tk}`);
      const p = prof?.data?.[0];
      if (p?.profile_picture_url) out.avatar = p.profile_picture_url;
    } else if (type === "messenger") {
      const page = String(chMeta?.page_id || externalId);
      const d = await getJson(`${base}/${page}?fields=name,username,category,fan_count,picture.type(large){url}&access_token=${tk}`);
      if (d && !d.error) {
        if (d.picture?.data?.url) out.avatar = d.picture.data.url;
        if (d.username) out.fields.push({ k: "username", v: "@" + d.username });
        if (d.category) out.fields.push({ k: "category", v: d.category });
        if (typeof d.fan_count === "number") out.fields.push({ k: "fans", v: String(d.fan_count) });
      }
    } else if (type === "instagram") {
      const d = chMeta?.viaPage
        ? await getJson(`${base}/${String(chMeta?.ig_user_id || externalId)}?fields=username,profile_picture_url,followers_count,media_count&access_token=${tk}`)
        : await getJson(`${IG_GRAPH}/me?fields=username,profile_picture_url,followers_count,media_count,account_type&access_token=${tk}`);
      if (d && !d.error) {
        if (d.profile_picture_url) out.avatar = d.profile_picture_url;
        if (d.username) out.fields.push({ k: "username", v: "@" + d.username });
        if (typeof d.followers_count === "number") out.fields.push({ k: "followers", v: String(d.followers_count) });
        if (typeof d.media_count === "number") out.fields.push({ k: "posts", v: String(d.media_count) });
      }
    }
  } catch { /* best effort */ }
  return out;
}

// ─── Instagram Login (graph.instagram.com) ───────────────────────────────────

export interface IgExchangeResult {
  accessToken: string;
  userId: string;     // IBAID (matches entry[0].id on webhooks)
  username: string;
  error?: string;
}

/**
 * Full Instagram Login code → long-lived token → profile resolution.
 * Mirrors the documented Instagram API with Instagram Login flow.
 */
export async function exchangeInstagramCode(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string
): Promise<IgExchangeResult> {
  // 1. code → short-lived token (+ app-scoped user id)
  const form = new URLSearchParams();
  form.set("client_id", appId);
  form.set("client_secret", appSecret);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", redirectUri);
  form.set("code", code);

  const shortResp = await fetch(`${IG_OAUTH}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const shortData = (await shortResp.json()) as {
    access_token?: string;
    user_id?: number | string;
    error_message?: string;
    error_type?: string;
  };
  if (!shortData.access_token) {
    return { accessToken: "", userId: "", username: "", error: shortData.error_message || shortData.error_type || "token_exchange_failed" };
  }
  const asid = String(shortData.user_id ?? "");

  // 2. short → long-lived token (≈60 days)
  const longUrl = new URL(`${IG_GRAPH}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("access_token", shortData.access_token);
  const longData = (await getJson(longUrl.toString())) as TokenResult;
  const accessToken = longData.access_token || shortData.access_token;

  // 3. resolve IBAID + username. user_id field = IBAID (webhook entry id).
  const meUrl = new URL(`${IG_GRAPH}/me`);
  meUrl.searchParams.set("fields", "id,user_id,username,name");
  meUrl.searchParams.set("access_token", accessToken);
  const me = (await getJson(meUrl.toString())) as {
    id?: string;
    user_id?: string;
    username?: string;
    name?: string;
  };
  const userId = me.user_id ? String(me.user_id) : asid;

  return {
    accessToken,
    userId,
    username: me.username || me.name || `instagram_${userId}`,
  };
}

/** Subscribe the app to an Instagram account's webhooks (Instagram Login). */
export async function subscribeInstagramApp(
  igUserToken: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(`${IG_GRAPH}/me/subscribed_apps`);
  url.searchParams.set("access_token", igUserToken);
  url.searchParams.set(
    "subscribed_fields",
    ["messages", "messaging_postbacks", "messaging_seen", "comments", "live_comments", "message_reactions"].join(",")
  );
  const r = await fetch(url.toString(), { method: "POST" });
  const data = await r.json();
  if (data?.success) return { ok: true };
  return { ok: false, error: data?.error?.message || "subscribe_failed" };
}
