// ─────────────────────────────────────────────────────────────────────────────
// Normalize a raw Meta webhook payload into a compact feed entry.
// Supports the three products this hub connects: WhatsApp, Messenger, Instagram.
// ─────────────────────────────────────────────────────────────────────────────
import { ChannelType } from "./types";

export interface ParsedWebhook {
  product: ChannelType | "unknown";
  externalId: string | null; // routing key (phone_number_id | page_id | ig_user_id)
  kind: string;
  summary: string;
}

function truncate(s: any, n = 140): string {
  if (s == null || s === "") return "";
  let str: string;
  if (typeof s === "string") str = s;
  else if (typeof s === "number" || typeof s === "boolean") str = String(s);
  else { try { str = JSON.stringify(s); } catch { str = ""; } } // never "[object Object]"
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function parseWaba(body: any): ParsedWebhook {
  const entry = Array.isArray(body.entry) ? body.entry[0] : null;
  const change = entry && Array.isArray(entry.changes) ? entry.changes[0] : null;
  const value = change?.value || {};
  const externalId = value?.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;

  if (Array.isArray(value.messages) && value.messages.length) {
    const m = value.messages[0];
    const from = m.from ? String(m.from) : "?";
    let text = "";
    if (m.type === "text") text = m.text?.body || "";
    else text = `[${m.type}]`;
    return { product: "waba", externalId, kind: "message", summary: `WhatsApp de ${from}: ${truncate(text)}` };
  }
  if (Array.isArray(value.statuses) && value.statuses.length) {
    const st = value.statuses[0];
    return { product: "waba", externalId, kind: "status", summary: `WhatsApp status: ${st.status} (${st.recipient_id || "?"})` };
  }
  return { product: "waba", externalId, kind: change?.field || "event", summary: `WhatsApp: ${change?.field || "evento"}` };
}

function parseMessenger(body: any): ParsedWebhook {
  const entry = Array.isArray(body.entry) ? body.entry[0] : null;
  const externalId = entry?.id ? String(entry.id) : null;
  const ev = entry && Array.isArray(entry.messaging) ? entry.messaging[0] : null;
  if (ev?.message) {
    const from = ev.sender?.id || "?";
    const text = ev.message.text || `[${ev.message.attachments ? "anexo" : "mensagem"}]`;
    return { product: "messenger", externalId, kind: "message", summary: `Messenger de ${from}: ${truncate(text)}` };
  }
  if (ev?.postback) {
    return { product: "messenger", externalId, kind: "postback", summary: `Messenger postback: ${truncate(ev.postback.title || ev.postback.payload || "")}` };
  }
  return { product: "messenger", externalId, kind: "event", summary: "Messenger: evento" };
}

function parseInstagram(body: any): ParsedWebhook {
  const entry = Array.isArray(body.entry) ? body.entry[0] : null;
  const externalId = entry?.id ? String(entry.id) : null;

  // DM (messaging)
  const ev = entry && Array.isArray(entry.messaging) ? entry.messaging[0] : null;
  if (ev?.message) {
    const from = ev.sender?.id || "?";
    const text = ev.message.text || "[anexo]";
    return { product: "instagram", externalId, kind: "message", summary: `Instagram DM de ${from}: ${truncate(text)}` };
  }
  // Comments / mentions (changes)
  const change = entry && Array.isArray(entry.changes) ? entry.changes[0] : null;
  if (change) {
    const field = change.field || "change";
    const v = change.value || {};
    const txt = v.text || v.message?.text || v.message || v.caption || "";
    return { product: "instagram", externalId, kind: field, summary: `Instagram ${field}: ${truncate(txt)}` };
  }
  return { product: "instagram", externalId, kind: "event", summary: "Instagram: evento" };
}

export function parseWebhook(body: any): ParsedWebhook {
  if (!body || typeof body !== "object") {
    return { product: "unknown", externalId: null, kind: "unknown", summary: "Payload vazio" };
  }
  switch (body.object) {
    case "whatsapp_business_account":
      return parseWaba(body);
    case "page":
      return parseMessenger(body);
    case "instagram":
      return parseInstagram(body);
    default:
      return { product: "unknown", externalId: null, kind: "unknown", summary: `Objeto desconhecido: ${body.object || "?"}` };
  }
}
