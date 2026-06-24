// ─────────────────────────────────────────────────────────────────────────────
// Evidence engine — runs REAL Graph API calls per Meta permission and captures,
// for each call: HTTP status, x-fb-trace-id, x-fb-request-id and the response
// body. Mirrors docs/gerar-evidencia-*.mjs, but driven by data "suites" and the
// hub's own stored tokens. Nothing is fabricated; tokens are scrubbed on output.
// ─────────────────────────────────────────────────────────────────────────────

const FB_GRAPH = "https://graph.facebook.com";

export interface EvidenceStep {
  group: string;                       // permission this step proves
  label: string;
  method: "GET" | "POST" | "DELETE";
  path: string;                        // supports {waba} {phone} {ig} {page} {recipient} {ts} {self} placeholders
  json?: any;                          // POST body (placeholders substituted)
  write?: boolean;                     // side-effecting — only runs when options.allowWrites
}

export interface EvidenceRecord {
  group: string;
  label: string;
  method: string;
  endpoint: string;
  status: number;
  traceId: string;
  requestId: string;
  ok: boolean;
  skipped?: boolean;
  curl: string;
  response: any;
}

export interface EvidenceCtx {
  token: string;
  apiVersion: string;
  waba_id?: string;
  phone_number_id?: string;
  ig_id?: string;
  page_id?: string;
  recipient?: string;
  ts: string;                          // unique suffix for created assets
}

function mask(t: string): string {
  return t && t.length > 24 ? t.slice(0, 14) + "..." + t.slice(-6) : "[REDACTED]";
}

/** Strip every token shape from a string before it leaves the server. */
export function scrubTokens(s: string, tokens: string[]): string {
  for (const t of tokens) if (t) s = s.split(t).join(mask(t));
  s = s.replace(/(access_token=)[A-Za-z0-9_-]+/g, "$1[REDACTED]");
  s = s.replace(/(input_token=)[A-Za-z0-9_-]+/g, "$1[REDACTED]");
  s = s.replace(/("access_token"\s*:\s*")[^"]+(")/g, "$1[REDACTED]$2");
  s = s.replace(/(Bearer )[A-Za-z0-9_-]{24,}/g, "$1[REDACTED]");
  s = s.replace(/\b(EAA|IGAA)[A-Za-z0-9]{20,}\b/g, (m) => mask(m));
  return s;
}

function subst(s: string, ctx: EvidenceCtx): string {
  return s
    .replace(/\{waba\}/g, ctx.waba_id || "")
    .replace(/\{phone\}/g, ctx.phone_number_id || "")
    .replace(/\{ig\}/g, ctx.ig_id || "")
    .replace(/\{page\}/g, ctx.page_id || "")
    .replace(/\{recipient\}/g, ctx.recipient || "")
    .replace(/\{ts\}/g, ctx.ts)
    .replace(/\{self\}/g, encodeURIComponent(ctx.token));
}

async function runStep(step: EvidenceStep, ctx: EvidenceCtx): Promise<EvidenceRecord> {
  const base = `${FB_GRAPH}/${ctx.apiVersion}`;
  const path = subst(step.path, ctx);
  const url = path.startsWith("http") ? path : `${base}/${path}`;
  const token = ctx.token;
  const opt: any = { method: step.method, headers: { Authorization: `Bearer ${token}` } };
  let json: any = null;
  if (step.json && step.method !== "GET" && step.method !== "DELETE") {
    json = JSON.parse(subst(JSON.stringify(step.json), ctx));
    opt.body = JSON.stringify(json);
    opt.headers["Content-Type"] = "application/json";
  }
  let status = 0, traceId = "", requestId = "", response: any = null, text = "";
  try {
    const res = await fetch(url, opt);
    status = res.status;
    traceId = res.headers.get("x-fb-trace-id") || "";
    requestId = res.headers.get("x-fb-request-id") || "";
    text = await res.text();
    try { response = JSON.parse(text); } catch { response = text; }
  } catch (e: any) {
    text = "FETCH ERROR: " + (e?.message || e);
    response = text;
  }
  const shownUrl = url.split(token).join("{TOKEN}");
  const endpoint = (path.startsWith("http") ? path : `${base}/${path}`).split("?")[0].split(token).join("{TOKEN}");
  const curl = step.method === "GET" || step.method === "DELETE"
    ? `curl -X ${step.method} "${shownUrl}" \\\n  -H "Authorization: Bearer {TOKEN}"`
    : `curl -X ${step.method} "${shownUrl}" \\\n  -H "Authorization: Bearer {TOKEN}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(json)}'`;
  return { group: step.group, label: step.label, method: step.method, endpoint, status, traceId, requestId, ok: status >= 200 && status < 300, curl, response };
}

export async function runSuite(steps: EvidenceStep[], ctx: EvidenceCtx, opts: { allowWrites: boolean }): Promise<EvidenceRecord[]> {
  const out: EvidenceRecord[] = [];
  for (const step of steps) {
    if (step.write && !opts.allowWrites) {
      out.push({ group: step.group, label: step.label, method: step.method, endpoint: subst(step.path, ctx).split("?")[0], status: 0, traceId: "", requestId: "", ok: false, skipped: true, curl: "", response: "(pulado: escrita desativada)" });
      continue;
    }
    out.push(await runStep(step, ctx));
  }
  return out;
}

// ─── Suites (one per product). Read GETs first; writes flagged. ───────────────

export const SUITES: Record<string, { label: string; needs: string[]; steps: EvidenceStep[] }> = {
  whatsapp: {
    label: "WhatsApp Business (Cloud API)",
    needs: ["waba_id", "phone_number_id"],
    steps: [
      { group: "identidade", label: "GET /me", method: "GET", path: "me?fields=id,name" },
      { group: "identidade", label: "GET /me/permissions", method: "GET", path: "me/permissions" },
      { group: "identidade", label: "GET /debug_token", method: "GET", path: "debug_token?input_token={self}" },
      { group: "whatsapp_business_management", label: "GET /{waba} (dados da WABA)", method: "GET", path: "{waba}?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status,business_verification_status,ownership_type" },
      { group: "whatsapp_business_management", label: "GET /{waba}/phone_numbers", method: "GET", path: "{waba}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,name_status,messaging_limit_tier" },
      { group: "whatsapp_business_management", label: "GET /{phone} (detalhes do numero)", method: "GET", path: "{phone}?fields=verified_name,display_phone_number,quality_rating,messaging_limit_tier,platform_type,throughput,code_verification_status,name_status" },
      { group: "whatsapp_business_management", label: "GET /{waba}/message_templates", method: "GET", path: "{waba}/message_templates?fields=id,name,status,category,language&limit=10" },
      { group: "whatsapp_business_management", label: "GET /{phone}/whatsapp_business_profile", method: "GET", path: "{phone}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical" },
      { group: "whatsapp_business_management", label: "GET /{waba}/subscribed_apps", method: "GET", path: "{waba}/subscribed_apps" },
      { group: "whatsapp_business_management", label: "POST /{waba}/message_templates (cria UTILITY)", method: "POST", path: "{waba}/message_templates", write: true, json: { name: "evidencia_waba_mgmt_{ts}", language: "pt_BR", category: "UTILITY", components: [{ type: "BODY", text: "Ola {{1}}, seu atendimento {{2}} foi registrado.", example: { body_text: [["Pedro", "#1234"]] } }] } },
      { group: "whatsapp_business_messaging", label: "POST /{phone}/messages (template hello_world)", method: "POST", path: "{phone}/messages", write: true, json: { messaging_product: "whatsapp", to: "{recipient}", type: "template", template: { name: "hello_world", language: { code: "en_US" } } } },
      { group: "whatsapp_business_messaging", label: "POST /{phone}/messages (texto livre)", method: "POST", path: "{phone}/messages", write: true, json: { messaging_product: "whatsapp", recipient_type: "individual", to: "{recipient}", type: "text", text: { preview_url: false, body: "Evidencia App Review {ts} - whatsapp_business_messaging" } } },
    ],
  },
  messenger: {
    label: "Messenger (Páginas do Facebook)",
    needs: ["page_id"],
    steps: [
      { group: "identidade", label: "GET /me", method: "GET", path: "me?fields=id,name" },
      { group: "identidade", label: "GET /me/permissions", method: "GET", path: "me/permissions" },
      { group: "identidade", label: "GET /debug_token", method: "GET", path: "debug_token?input_token={self}" },
      { group: "pages_show_list", label: "GET /me/accounts (lista de Paginas)", method: "GET", path: "me/accounts?fields=id,name,category,tasks" },
      { group: "pages_read_engagement", label: "GET /{page} (dados da Pagina)", method: "GET", path: "{page}?fields=id,name,category,about,fan_count,link,verification_status,tasks" },
      { group: "pages_manage_metadata", label: "GET /{page}/subscribed_apps (webhook)", method: "GET", path: "{page}/subscribed_apps" },
      { group: "pages_messaging", label: "GET /{page}/conversations", method: "GET", path: "{page}/conversations?fields=id,updated_time,message_count,participants&limit=5" },
      { group: "pages_messaging", label: "POST /{page}/messages (envio, tag ACCOUNT_UPDATE)", method: "POST", path: "{page}/messages", write: true, json: { recipient: { id: "{recipient}" }, messaging_type: "MESSAGE_TAG", tag: "ACCOUNT_UPDATE", message: { text: "Evidencia App Review {ts} - pages_messaging" } } },
    ],
  },
  instagram: {
    label: "Instagram (Graph / mensagens e conteúdo)",
    needs: ["ig_id"],
    steps: [
      { group: "identidade", label: "GET /me", method: "GET", path: "me?fields=id,name" },
      { group: "identidade", label: "GET /me/permissions", method: "GET", path: "me/permissions" },
      { group: "identidade", label: "GET /debug_token", method: "GET", path: "debug_token?input_token={self}" },
      { group: "identidade", label: "GET /me/accounts (instagram_business_account)", method: "GET", path: "me/accounts?fields=id,name,instagram_business_account" },
      { group: "instagram_basic", label: "GET /{ig} (perfil IG)", method: "GET", path: "{ig}?fields=id,username,name,followers_count,follows_count,media_count,profile_picture_url" },
      { group: "instagram_manage_contents", label: "GET /{ig}/media (publicacoes)", method: "GET", path: "{ig}/media?fields=id,caption,media_type,permalink,timestamp,comments_count,like_count,is_comment_enabled&limit=5" },
      { group: "instagram_manage_insights", label: "GET /{ig}/insights", method: "GET", path: "{ig}/insights?metric=reach&period=day" },
      { group: "instagram_content_publish", label: "GET /{ig}/content_publishing_limit", method: "GET", path: "{ig}/content_publishing_limit?fields=config,quota_usage" },
      { group: "instagram_manage_messages", label: "GET /{ig}/conversations (DMs)", method: "GET", path: "{ig}/conversations?platform=instagram&fields=id,updated_time&limit=5" },
      { group: "instagram_content_publish", label: "POST /{ig}/media (container; nao publica)", method: "POST", path: "{ig}/media", write: true, json: { image_url: "https://picsum.photos/600/600", caption: "Evidencia App Review {ts} - instagram_content_publish" } },
    ],
  },
};

/** Build the .txt evidence document, scrubbing tokens. */
export function buildEvidenceDoc(opts: {
  product: string; appId: string; apiVersion: string; ctx: EvidenceCtx; records: EvidenceRecord[]; tokens: string[]; nowIso: string;
}): string {
  const hr = "==============================================================";
  const sub = "--------------------------------------------------------------";
  const L: string[] = [];
  const suite = SUITES[opts.product];
  L.push(hr, `EVIDENCIA: ${suite ? suite.label : opts.product}`, hr, "");
  L.push(`App ID:          ${opts.appId}`);
  if (opts.ctx.waba_id) L.push(`WABA ID:         ${opts.ctx.waba_id}`);
  if (opts.ctx.phone_number_id) L.push(`Phone Number ID: ${opts.ctx.phone_number_id}`);
  if (opts.ctx.recipient) L.push(`Destino do envio: ${opts.ctx.recipient}`);
  L.push(`Data:            ${opts.nowIso}`);
  L.push(`Graph version:   ${opts.apiVersion}`, "");
  L.push("Tokens usados (mascarados):");
  for (const t of opts.tokens) if (t) L.push(`  - ${mask(t)}`);
  L.push("", "NADA neste arquivo foi editado a mao: status HTTP, x-fb-trace-id,", "x-fb-request-id e corpos vieram direto da Meta.", "");
  for (const r of opts.records) {
    if (r.skipped) continue;
    L.push(hr);
    L.push(`[${r.group}] ${r.label}`);
    L.push(`${r.method} ${r.endpoint}`);
    L.push(`HTTP ${r.status}    x-fb-trace-id: ${r.traceId}    x-fb-request-id: ${r.requestId}`);
    L.push("", "Request:", r.curl, "", "Response:");
    L.push(typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2));
    L.push("");
  }
  L.push(hr, "CONCLUSAO", hr, "");
  const groups = Array.from(new Set(opts.records.filter((r) => !r.skipped && r.group !== "identidade").map((r) => r.group)));
  for (const g of groups) {
    L.push(`${g}:`);
    opts.records.filter((r) => r.group === g && r.ok).forEach((r) => L.push(`  - ${r.method} ${r.endpoint}  (HTTP ${r.status}, trace ${r.traceId})`));
    L.push("");
  }
  L.push(sub, "FIM");
  return scrubTokens(L.join("\n"), opts.tokens);
}
