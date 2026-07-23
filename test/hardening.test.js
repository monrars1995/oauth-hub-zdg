const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-apphub-test-"));
  for (const name of ["dist", "public", "locales"]) {
    fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  }
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(base, child, logs) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready\n${logs()}`);
}

async function startServer(extraEnv = {}) {
  const dir = makeSandbox();
  const port = await freePort();
  let output = "";
  const child = spawn(process.execPath, [path.join(dir, "dist", "index.js")], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NODE_PATH: path.join(ROOT, "node_modules"),
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      SESSION_SECRET: "test-session-secret-that-is-long-enough",
      ADMIN_PASSWORD: "test-admin-password",
      META_API_VERSION: "v25.0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child, () => output);
  return {
    base,
    child,
    dir,
    logs: () => output,
    async stop() {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function request(base, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body !== undefined && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${pathname}`, { ...options, headers, body });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, headers: response.headers, text, body: json };
}

async function login(base) {
  const response = await request(base, "/api/login", {
    method: "POST",
    body: { password: "test-admin-password" },
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  const token = response.body && response.body.token;
  const headers = cookie
    ? { Cookie: cookie }
    : { Authorization: `Bearer ${token}` };
  return { ...response, cookie, token, authHeaders: headers };
}

async function createApp(server, authHeaders, overrides = {}) {
  const response = await request(server.base, "/api/apps", {
    method: "POST",
    headers: authHeaders,
    body: {
      name: "Test app",
      appId: `app-${crypto.randomBytes(4).toString("hex")}`,
      appSecret: "main-app-secret",
      instagramAppSecret: "instagram-app-secret",
      webhookVerifyToken: "verify-token",
      apiVersion: "v25.0",
      ...overrides,
    },
  });
  return response;
}

function whatsappPayload(phone = "phone-1") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: phone },
          messages: [{ id: "m-1", from: "5511999999999", type: "text", text: { body: "oi" } }],
        },
      }],
    }],
  };
}

function signature(secret, rawBody) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

test("login uses an HttpOnly SameSite cookie and does not expose the session token", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const setCookie = session.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.ok(session.cookie.startsWith("hub_session="));
    assert.equal(Object.prototype.hasOwnProperty.call(session.body || {}, "token"), false);

    const denied = await request(server.base, "/api/config");
    assert.equal(denied.status, 401);
    const allowed = await request(server.base, "/api/config", { headers: { Cookie: session.cookie } });
    assert.equal(allowed.status, 200);
  } finally {
    await server.stop();
  }
});

test("production refuses to start without an admin password", async () => {
  const dir = makeSandbox();
  const port = await freePort();
  let output = "";
  const child = spawn(process.execPath, [path.join(dir, "dist", "index.js")], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NODE_PATH: path.join(ROOT, "node_modules"),
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      SESSION_SECRET: "test-session-secret-that-is-long-enough",
      ADMIN_PASSWORD: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve({ exited: true, code }))),
    new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 700)),
  ]);
  if (!result.exited) child.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.exited, true, `server stayed open\n${output}`);
  assert.notEqual(result.code, 0);
  assert.match(output, /ADMIN_PASSWORD/i);
  assert.match(output, /DATA_ENCRYPTION_KEY/i);
});

test("CORS rejects a foreign browser origin", async () => {
  const server = await startServer();
  try {
    const response = await request(server.base, "/api/bootstrap", {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const ownOrigin = await request(server.base, "/api/bootstrap", {
      headers: { Origin: server.base },
    });
    assert.equal(ownOrigin.status, 200);
    assert.equal(ownOrigin.headers.get("access-control-allow-origin"), server.base);
    assert.equal(ownOrigin.headers.get("access-control-allow-credentials"), "true");
  } finally {
    await server.stop();
  }
});

test("webhooks fail closed for missing, malformed and invalid signatures", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders);
    assert.equal(created.status, 200);
    const appKey = created.body.app.id;
    const raw = JSON.stringify(whatsappPayload());

    for (const header of [undefined, "sha256=bad", `sha256=${"0".repeat(64)}`]) {
      const headers = { "Content-Type": "application/json" };
      if (header) headers["X-Hub-Signature-256"] = header;
      const response = await request(server.base, `/webhook/app/${appKey}`, {
        method: "POST",
        headers,
        body: raw,
      });
      assert.equal(response.status, 401);
    }

    const events = await request(server.base, "/api/events", { headers: session.authHeaders });
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 0);
  } finally {
    await server.stop();
  }
});

test("a valid raw-body HMAC is accepted and recorded", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders);
    const raw = JSON.stringify(whatsappPayload());
    const response = await request(server.base, `/webhook/app/${created.body.app.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature("main-app-secret", raw),
      },
      body: raw,
    });
    assert.equal(response.status, 200);
    const events = await request(server.base, "/api/events", { headers: session.authHeaders });
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].signatureValid, true);
  } finally {
    await server.stop();
  }
});

test("the generic webhook resolves the matching app by signature", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    await createApp(server, session.authHeaders, { name: "First", appSecret: "secret-first" });
    const second = await createApp(server, session.authHeaders, { name: "Second", appSecret: "secret-second" });
    const raw = JSON.stringify(whatsappPayload("unmapped-phone"));
    const response = await request(server.base, "/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature("secret-second", raw),
      },
      body: raw,
    });
    assert.equal(response.status, 200);
    const events = await request(server.base, "/api/events", { headers: session.authHeaders });
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].appId, second.body.app.id);
  } finally {
    await server.stop();
  }
});

test("apps without a signing secret cannot accept webhook events", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders, { appSecret: "" });
    const raw = JSON.stringify(whatsappPayload());
    const response = await request(server.base, `/webhook/app/${created.body.app.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    assert.equal(response.status, 401);
  } finally {
    await server.stop();
  }
});

test("forward destinations reject localhost and private-network SSRF targets", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    for (const url of [
      "http://127.0.0.1:8080/hook",
      "http://localhost/hook",
      "http://169.254.169.254/latest/meta-data",
      "https://127.0.0.1/hook",
      "https://10.0.0.1/hook",
      "https://[::1]/hook",
      "https://[fc00::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[64:ff9b::7f00:1]/hook",
    ]) {
      const response = await createApp(server, session.authHeaders, {
        forwards: [{ url, products: ["all"], enabled: true }],
      });
      assert.equal(response.status, 400, url);
      assert.equal(response.body.error, "UNSAFE_FORWARD_URL");
    }
  } finally {
    await server.stop();
  }
});

test("forward delivery pins the validated DNS address on the outbound socket", async () => {
  const dir = makeSandbox();
  const dns = require("node:dns");
  const https = require("node:https");
  const { EventEmitter } = require("node:events");
  const originalLookup = dns.promises.lookup;
  const originalRequest = https.request;
  const previousNodeEnv = process.env.NODE_ENV;
  let pinned = null;
  try {
    process.env.NODE_ENV = "test";
    dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    https.request = (_url, options, onResponse) => {
      options.lookup("example.test", { all: false }, (error, address, family) => {
        assert.ifError(error);
        pinned = { address, family };
      });
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => { if (error) request.emit("error", error); };
      request.end = () => onResponse({ statusCode: 204, destroy() {} });
      return request;
    };
    const forwarding = require(path.join(dir, "dist", "forward-security.js"));
    const response = await forwarding.postSafeForwardUrl("https://example.test/hook", "{}", { "Content-Type": "application/json" }, 1000);
    assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
    assert.deepEqual(response, { ok: true, status: 204 });
  } finally {
    dns.promises.lookup = originalLookup;
    https.request = originalRequest;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-app channel storage keys by app, type and external id", async () => {
  const dir = makeSandbox();
  const store = require(path.join(dir, "dist", "store.js"));
  const base = {
    id: "channel-a",
    type: "waba",
    name: "WhatsApp",
    externalId: "phone-shared",
    accessToken: "token",
    meta: {},
    subscribed: true,
    createdAt: new Date().toISOString(),
  };
  store.upsertChannel({ ...base, appId: "app-a" });
  store.upsertChannel({ ...base, id: "channel-b", appId: "app-b" });
  assert.equal(store.listChannels().length, 2);
  assert.equal(store.findChannelByExternalId("phone-shared", "app-b").appId, "app-b");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deleting an app cascades its channels and retained events", async () => {
  const dir = makeSandbox();
  const store = require(path.join(dir, "dist", "store.js"));
  const now = new Date().toISOString();
  store.addApp({
    id: "app-a", name: "A", appId: "meta-a", appSecret: "secret", apiVersion: "v25.0",
    wabaConfigId: "", messengerConfigId: "", instagramAppId: "", instagramAppSecret: "",
    messengerFallbackToken: "", webhookVerifyToken: "verify", forwards: [], storeEvents: true,
    embedEnabled: false, createdAt: now,
  });
  store.upsertChannel({
    id: "channel-a", appId: "app-a", type: "waba", name: "WA", externalId: "phone-a",
    accessToken: "token", meta: {}, subscribed: true, createdAt: now,
  });
  store.addEvent({
    id: "event-a", ts: now, appId: "app-a", appName: "A", product: "waba",
    externalId: "phone-a", channelId: "channel-a", kind: "message", direction: "in",
    summary: "test", signatureValid: true, forwards: [], raw: {},
  });
  assert.equal(store.deleteApp("app-a"), true);
  assert.equal(store.countChannelsByApp("app-a"), 0);
  assert.equal(store.listEvents().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("secret-bearing JSON files are encrypted and written with owner-only permissions", async () => {
  const dir = makeSandbox();
  const storePath = path.join(dir, "dist", "store.js");
  const store = require(storePath);
  store.addApp({
    id: "app-a", name: "A", appId: "meta-a", appSecret: "main-secret-must-not-leak", apiVersion: "v25.0",
    wabaConfigId: "", messengerConfigId: "", instagramAppId: "", instagramAppSecret: "",
    messengerFallbackToken: "", webhookVerifyToken: "verify-token-must-not-leak",
    forwards: [{ url: "https://hooks.example.test/inbox?token=app-forward-token-must-not-leak", products: ["all"], enabled: true }], storeEvents: true,
    embedEnabled: false, createdAt: new Date().toISOString(),
  });
  store.upsertChannel({
    id: "channel-a", appId: "app-a", type: "waba", name: "WA", externalId: "phone-a",
    accessToken: "channel-token-must-not-leak", meta: {}, subscribed: true, createdAt: new Date().toISOString(),
  });
  store.addEvent({
    id: "event-a", ts: new Date().toISOString(), appId: "app-a", appName: "A", product: "waba",
    externalId: "phone-a", channelId: "channel-a", kind: "message", direction: "in", summary: "test",
    signatureValid: true, forwards: [{ url: "https://hooks.example.test/event?token=event-forward-token-must-not-leak", ok: true, status: 200 }], raw: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const appPath = path.join(dir, "data", "apps.json");
  const channelPath = path.join(dir, "data", "channels.json");
  const eventPath = path.join(dir, "data", "events.json");
  assert.equal(fs.statSync(appPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(channelPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(eventPath).mode & 0o777, 0o600);
  const appFile = fs.readFileSync(appPath, "utf8");
  const channelFile = fs.readFileSync(channelPath, "utf8");
  const eventFile = fs.readFileSync(eventPath, "utf8");
  assert.doesNotMatch(appFile, /main-secret-must-not-leak|verify-token-must-not-leak|app-forward-token-must-not-leak/);
  assert.doesNotMatch(channelFile, /channel-token-must-not-leak/);
  assert.doesNotMatch(eventFile, /event-forward-token-must-not-leak/);
  assert.match(appFile, /enc:v1:/);
  assert.match(channelFile, /enc:v1:/);
  assert.match(eventFile, /enc:v1:/);
  const keyPath = path.join(dir, "data", ".data-encryption-key");
  const promotedKey = fs.readFileSync(keyPath, "utf8").trim();
  const previousDataKey = process.env.DATA_ENCRYPTION_KEY;
  fs.rmSync(keyPath);
  process.env.DATA_ENCRYPTION_KEY = promotedKey;
  delete require.cache[require.resolve(storePath)];
  try {
    const reloaded = require(storePath);
    assert.equal(reloaded.findApp("app-a").appSecret, "main-secret-must-not-leak");
    assert.equal(reloaded.findChannelById("channel-a").accessToken, "channel-token-must-not-leak");
    assert.match(reloaded.findApp("app-a").forwards[0].url, /app-forward-token-must-not-leak/);
    assert.match(reloaded.listEvents()[0].forwards[0].url, /event-forward-token-must-not-leak/);
  } finally {
    if (previousDataKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previousDataKey;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy plaintext secrets are migrated to encrypted storage on load", async () => {
  const dir = makeSandbox();
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const legacy = [{
    id: "legacy-app", name: "Legacy", appId: "meta-legacy", appSecret: "legacy-plaintext-secret", apiVersion: "v25.0",
    wabaConfigId: "", messengerConfigId: "", instagramAppId: "", instagramAppSecret: "",
    messengerFallbackToken: "", webhookVerifyToken: "legacy-verify-token", forwards: [], storeEvents: true,
    embedEnabled: false, createdAt: new Date().toISOString(),
  }];
  fs.writeFileSync(path.join(dataDir, "apps.json"), JSON.stringify(legacy, null, 2));
  const store = require(path.join(dir, "dist", "store.js"));
  assert.equal(store.findApp("legacy-app").appSecret, "legacy-plaintext-secret");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const migrated = fs.readFileSync(path.join(dataDir, "apps.json"), "utf8");
  assert.doesNotMatch(migrated, /legacy-plaintext-secret|legacy-verify-token/);
  assert.match(migrated, /enc:v1:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("OAuth state can be consumed only once", () => {
  const dir = makeSandbox();
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  const security = require(path.join(dir, "dist", "security.js"));
  const state = security.encodeState("waba", "app-a", "pt");
  assert.equal(typeof security.consumeState, "function");
  assert.ok(security.consumeState(state));
  assert.equal(security.consumeState(state), null);
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("OAuth state is bound to its intended channel", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders);
    const initialized = await request(server.base, "/api/connect/instagram/init", {
      method: "POST",
      headers: session.authHeaders,
      body: { appId: created.body.app.id, lang: "pt" },
    });
    assert.equal(initialized.status, 200);
    const state = new URL(initialized.body.url).searchParams.get("state");
    const wrongExchange = await request(server.base, "/api/connect/waba/exchange", {
      method: "POST",
      body: { state },
    });
    assert.equal(wrongExchange.status, 403);
    assert.equal(wrongExchange.body.error, "INVALID_STATE");
  } finally {
    await server.stop();
  }
});

test("evidence writes require an explicit second confirmation before any external call", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders, { messengerFallbackToken: "fake-token" });
    const response = await request(server.base, "/api/evidence/run", {
      method: "POST",
      headers: session.authHeaders,
      body: {
        appId: created.body.app.id,
        product: "whatsapp",
        source: "fallback",
        allowWrites: true,
        params: {},
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "WRITE_CONFIRMATION_REQUIRED");
  } finally {
    await server.stop();
  }
});

test("visible application surfaces use only the @goldneuron.io brand", () => {
  const files = [
    "public/index.html",
    "public/app.js",
    "public/connect-waba.html",
    "public/connect-messenger.html",
    "public/connect-instagram.html",
    "locales/pt.json",
    "locales/en.json",
    "locales/es.json",
  ];
  const joined = files.map((name) => fs.readFileSync(path.join(ROOT, name), "utf8")).join("\n");
  const visibleSurfaces = joined.replaceAll("oauth-hub-zdg", ""); // legal/source repository slug is retained
  assert.doesNotMatch(visibleSurfaces, /ZDG|Z-PRO|zpro\.zdg|Comunidade ZDG|ZDG Community|Comunidad ZDG/i);
  assert.doesNotMatch(visibleSurfaces, /youtu(?:\.be|be\.com)|img\.youtube\.com/i);
  assert.match(visibleSurfaces, /@goldneuron\.io/);
  assert.equal(fs.existsSync(path.join(ROOT, "public", "assets", "goldneuron_logo_mark.svg")), true);
});

test("the default Graph API target is v25.0", () => {
  const config = fs.readFileSync(path.join(ROOT, "src", "config.ts"), "utf8");
  const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.match(config, /DEFAULT_API_VERSION[\s\S]*"v25\.0"/);
  assert.match(envExample, /META_API_VERSION=v25\.0/);
});
