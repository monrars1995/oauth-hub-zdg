const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
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

test("the legacy default brand migrates to NeuroHub Meta without overriding custom brands", async () => {
  const server = await startServer({ BRAND_NAME: "NeuroHub Meta" });
  try {
    const session = await login(server.base);
    const legacy = await request(server.base, "/api/settings", {
      method: "POST",
      headers: session.authHeaders,
      body: { brandName: "Meta AppHub" },
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.brandName, "NeuroHub Meta");

    const custom = await request(server.base, "/api/settings", {
      method: "POST",
      headers: session.authHeaders,
      body: { brandName: "Hub do Cliente" },
    });
    assert.equal(custom.status, 200);
    assert.equal(custom.body.brandName, "Hub do Cliente");
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

test("production accepts Docker-style secret files without direct secret env values", async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-apphub-secrets-"));
  const adminFile = path.join(secretsDir, "admin-password");
  const sessionFile = path.join(secretsDir, "session-secret");
  const encryptionFile = path.join(secretsDir, "data-encryption-key");
  fs.writeFileSync(adminFile, "file-backed-admin-password");
  fs.writeFileSync(sessionFile, "file-backed-session-secret-that-is-long-enough");
  fs.writeFileSync(encryptionFile, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  let server;
  try {
    server = await startServer({
      NODE_ENV: "production",
      PUBLIC_URL: "https://provider.neuros.my",
      ADMIN_PASSWORD: "",
      SESSION_SECRET: "",
      DATA_ENCRYPTION_KEY: "",
      ADMIN_PASSWORD_FILE: adminFile,
      SESSION_SECRET_FILE: sessionFile,
      DATA_ENCRYPTION_KEY_FILE: encryptionFile,
    });
    const response = await request(server.base, "/api/login", {
      method: "POST",
      body: { password: "file-backed-admin-password" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("strict-transport-security") || "", /max-age=31536000/i);
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/i);
  } finally {
    if (server) await server.stop();
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
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

test("store write failures propagate and roll back the in-memory mutation", async () => {
  const dir = makeSandbox();
  const store = require(path.join(dir, "dist", "store.js"));
  const originalRename = fs.renameSync;
  let attempted = false;
  fs.renameSync = function failAppsRename(source, destination) {
    if (String(destination).endsWith("apps.json")) {
      attempted = true;
      const error = new Error("simulated persistence failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRename.call(this, source, destination);
  };
  let thrown = null;
  try {
    try {
      store.addApp({
        id: "must-rollback", name: "Rollback", appId: "meta-rollback", appSecret: "secret", apiVersion: "v25.0",
        wabaConfigId: "", messengerConfigId: "", instagramAppId: "", instagramAppSecret: "",
        messengerFallbackToken: "", webhookVerifyToken: "", forwards: [], storeEvents: true,
        embedEnabled: false, createdAt: new Date().toISOString(),
      });
    } catch (error) {
      thrown = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(attempted, true);
    assert.ok(thrown instanceof Error);
    assert.equal(store.findApp("must-rollback"), undefined);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("admin API returns 500 and keeps cache unchanged when persistence is unavailable", async () => {
  const server = await startServer({ DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" });
  const dataDir = path.join(server.dir, "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dataDir, "apps.json"));
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders);
    assert.equal(created.status, 500);
    assert.deepEqual(created.body, { error: "INTERNAL_ERROR" });
    assert.doesNotMatch(created.text, /apps\.json|EISDIR|rename/i);
    const listed = await request(server.base, "/api/apps", { headers: session.authHeaders });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.apps, []);
  } finally {
    await server.stop();
  }
});

test("a signed webhook returns 500 and is not cached when event persistence fails", async () => {
  const server = await startServer({ DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" });
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders);
    const eventsPath = path.join(server.dir, "data", "events.json");
    fs.mkdirSync(eventsPath);
    const raw = JSON.stringify(whatsappPayload());
    const response = await request(server.base, `/webhook/app/${created.body.app.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature("main-app-secret", raw),
      },
      body: raw,
    });
    assert.equal(response.status, 500);
    const listed = await request(server.base, "/api/events", { headers: session.authHeaders });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.events, []);
  } finally {
    await server.stop();
  }
});

test("cascading app deletion restores every file when a batch rename fails", () => {
  const dir = makeSandbox();
  const store = require(path.join(dir, "dist", "store.js"));
  const now = new Date().toISOString();
  store.addApp({
    id: "app-rollback", name: "Rollback", appId: "meta-rollback", appSecret: "secret", apiVersion: "v25.0",
    wabaConfigId: "", messengerConfigId: "", instagramAppId: "", instagramAppSecret: "",
    messengerFallbackToken: "", webhookVerifyToken: "", forwards: [], storeEvents: true, embedEnabled: false, createdAt: now,
  });
  store.upsertChannel({
    id: "channel-rollback", appId: "app-rollback", type: "waba", name: "WA", externalId: "phone-rollback",
    accessToken: "token", meta: {}, subscribed: true, createdAt: now,
  });
  store.addEvent({
    id: "event-rollback", ts: now, appId: "app-rollback", appName: "Rollback", product: "waba",
    externalId: "phone-rollback", channelId: "channel-rollback", kind: "message", direction: "in",
    summary: "test", signatureValid: true, forwards: [], raw: {},
  });
  const dataDir = path.join(dir, "data");
  const paths = ["apps.json", "channels.json", "events.json"].map((file) => path.join(dataDir, file));
  const before = paths.map((file) => fs.readFileSync(file));
  const originalRename = fs.renameSync;
  let failed = false;
  fs.renameSync = function failSecondRename(source, destination) {
    if (!failed && String(destination).endsWith("channels.json")) {
      failed = true;
      const error = new Error("simulated batch failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRename.call(this, source, destination);
  };
  try {
    assert.throws(() => store.deleteApp("app-rollback"), /simulated batch failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(store.findApp("app-rollback").id, "app-rollback");
  assert.equal(store.findChannelById("channel-rollback").id, "channel-rollback");
  assert.equal(store.listEvents()[0].id, "event-rollback");
  paths.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  assert.equal(fs.readdirSync(dataDir).some((file) => file.endsWith(".tmp") || file.endsWith(".rollback")), false);
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

test("Meta signup pages allow only the SDK dependencies they need and serve the official favicon", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders, {
      wabaConfigId: "waba-config",
      messengerConfigId: "messenger-config",
    });
    assert.equal(created.status, 200);

    for (const channel of ["waba", "messenger"]) {
      const initialized = await request(server.base, `/api/connect/${channel}/init`, {
        method: "POST",
        headers: session.authHeaders,
        body: { appId: created.body.app.id, lang: "pt" },
      });
      assert.equal(initialized.status, 200);
      const signupUrl = new URL(initialized.body.url);
      const page = await request(server.base, signupUrl.pathname + signupUrl.search);
      assert.equal(page.status, 200);
      assert.match(page.text, /https:\/\/connect\.facebook\.net\/en_US\/sdk\.js/);
      const csp = page.headers.get("content-security-policy") || "";
      assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/connect\.facebook\.net/);
      assert.match(csp, /frame-src https:\/\/www\.facebook\.com https:\/\/web\.facebook\.com https:\/\/business\.facebook\.com/);
      assert.match(csp, /connect-src 'self' https:\/\/www\.facebook\.com https:\/\/graph\.facebook\.com/);
      assert.match(csp, /img-src 'self' data: https:\/\/www\.facebook\.com https:\/\/static\.xx\.fbcdn\.net/);
    }

    const panel = await request(server.base, "/");
    assert.doesNotMatch(panel.headers.get("content-security-policy") || "", /facebook\.com|facebook\.net|fbcdn\.net/);

    const favicon = await request(server.base, "/favicon.ico");
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(favicon.text, /<svg\b/);
    assert.doesNotMatch(favicon.text, /<script\b|on[a-z]+\s*=|<foreignObject\b/i);
  } finally {
    await server.stop();
  }
});

test("all app secret fields support the __clear__ sentinel", async () => {
  const server = await startServer();
  try {
    const session = await login(server.base);
    const created = await createApp(server, session.authHeaders, { messengerFallbackToken: "messenger-secret" });
    const response = await request(server.base, `/api/apps/${created.body.app.id}`, {
      method: "PUT",
      headers: session.authHeaders,
      body: {
        appSecret: "__clear__",
        instagramAppSecret: "__clear__",
        messengerFallbackToken: "__clear__",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.app.hasAppSecret, false);
    assert.equal(response.body.app.hasInstagramAppSecret, false);
    assert.equal(response.body.app.hasMessengerFallbackToken, false);
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

test("legal pages are public and identify the responsible company", async () => {
  const server = await startServer();
  try {
    for (const route of ["/politica-privacidade", "/termos-servico", "/lgpd"]) {
      const response = await request(server.base, route);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type") || "", /text\/html/i);
      assert.match(response.text, /GOLDNEURON\.IO INOVA SIMPLES I\.S\. - ME/);
      assert.match(response.text, /63\.173\.644\/0001-00/);
      assert.match(response.text, /NeuroHub Meta/);
    }
  } finally {
    await server.stop();
  }
});

test("the authentication page exposes accessible public legal links", async () => {
  const server = await startServer();
  try {
    const response = await request(server.base, "/");
    assert.equal(response.status, 200);
    assert.match(response.text, /<label[^>]+for="loginPass"/i);
    assert.match(response.text, /href="\/politica-privacidade"/);
    assert.match(response.text, /href="\/termos-servico"/);
    assert.match(response.text, /href="\/lgpd"/);
  } finally {
    await server.stop();
  }
});

test("the dark visual system is matte, warm-neutral and keeps brand marks transparent", () => {
  const styles = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  const legalStyles = fs.readFileSync(path.join(ROOT, "public", "legal.css"), "utf8");
  const logo = fs.readFileSync(path.join(ROOT, "public", "assets", "goldneuron_logo_mark.svg"), "utf8");

  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*--bg:\s*oklch\([^)]*\s55\)/);
  assert.doesNotMatch(styles, /#07090f|#11141d|#0b0e15/i);
  assert.doesNotMatch(styles, /radial-gradient|backdrop-filter|filter:\s*blur|\bglow\b/i);
  assert.match(styles, /html\s*\{[^}]*min-height:\s*100%/s);
  assert.match(styles, /body\s*\{[^}]*min-height:\s*100vh/s);
  assert.doesNotMatch(styles, /html\s*,\s*body\s*\{[^}]*height:\s*100%/s);
  assert.doesNotMatch(logo, /softGlow|feGaussianBlur|feDropShadow/i);

  assert.match(styles, /\.login-logo\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(styles, /\.wc-logo\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(styles, /\.side-brand \.logo\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(styles, /\.brand-mark\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(legalStyles, /\.legal-brand img\s*\{[\s\S]*?background:\s*transparent;/);
});

test("the welcome screen is a responsive institutional manifesto with persistent panel access", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  const pt = JSON.parse(fs.readFileSync(path.join(ROOT, "locales", "pt.json"), "utf8"));

  assert.match(html, /<header class="wc-masthead">[\s\S]*id="welcomeEnter"[\s\S]*<\/header>/);
  assert.match(html, /<main class="wc-manifesto"[\s\S]*<\/main>/);
  assert.match(html, /<footer class="wc-rail"[\s\S]*<\/footer>/);
  assert.doesNotMatch(html, /class="welcome-card"/);
  assert.match(styles, /\.welcome-shell\s*\{[^}]*max-width:\s*1240px/s);
  assert.match(styles, /@media\s*\(max-width:\s*700px\)[\s\S]*\.wc-manifesto\s*\{[^}]*text-align:\s*left/s);
  assert.equal(pt["welcome.title"], "Inteligência aplicada às conexões que movem sua operação.");
  assert.match(pt["welcome.lead"], /WhatsApp Business, Messenger e Instagram/);
  assert.equal(pt["welcome.foot"], "Integrações oficiais Meta");
});

test("visible surfaces use NeuroHub Meta and the login omits redundant trust copy", () => {
  const visibleFiles = [
    "public/index.html",
    "public/politica-privacidade.html",
    "public/termos-servico.html",
    "public/lgpd.html",
    "locales/pt.json",
    "locales/en.json",
    "locales/es.json",
  ];
  const visible = visibleFiles.map((name) => fs.readFileSync(path.join(ROOT, name), "utf8")).join("\n");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  assert.match(visible, /NeuroHub Meta/);
  assert.doesNotMatch(visible, /Meta AppHub/);
  assert.doesNotMatch(html, /login-purpose|login-access-state|login-security-note/);
  for (const locale of ["pt", "en", "es"]) {
    const copy = JSON.parse(fs.readFileSync(path.join(ROOT, "locales", `${locale}.json`), "utf8"));
    assert.equal(Object.hasOwn(copy, "login.purpose"), false);
    assert.equal(Object.hasOwn(copy, "login.restricted"), false);
    assert.equal(Object.hasOwn(copy, "login.securityNote"), false);
  }
});

test("the NeuroCircuit family replaces generic product icons with one safe reusable sprite", () => {
  const spritePath = path.join(ROOT, "public", "assets", "neuro-icons.svg");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  const design = fs.readFileSync(path.join(ROOT, "DESIGN.md"), "utf8");
  const names = ["overview", "events", "channels", "apps", "forwarding", "config", "guide", "evidence"];

  assert.equal(fs.existsSync(spritePath), true, "the local NeuroCircuit sprite must exist");
  const sprite = fs.readFileSync(spritePath, "utf8");

  for (const name of names) {
    assert.equal((sprite.match(new RegExp(`id="ng-${name}"`, "g")) || []).length, 1, `${name} must have one symbol`);
    assert.match(sprite, new RegExp(`<symbol id="ng-${name}" viewBox="0 0 24 24"`));
    assert.match(html, new RegExp(`/assets/neuro-icons\\.svg#ng-${name}`));
  }

  assert.doesNotMatch(sprite, /<script\b|on[a-z]+\s*=|<filter\b|<foreignObject\b|<image\b|(?:xlink:)?href\s*=|url\(/i);
  assert.doesNotMatch(sprite, /linearGradient|radialGradient|feGaussianBlur|feDropShadow/i);
  assert.match(app, /function neuroIcon\(name\)/);
  assert.match(app, /Object\.prototype\.hasOwnProperty\.call\(NEURO_ICONS, name\)/);
  assert.match(app, /emptyState\(name, title, sub\)[\s\S]*neuroIcon\(name\)/);
  assert.doesNotMatch(app, /emptyState\("(?:grid|plug|inbox)"/);

  const helperSource = app.match(/  var NEURO_ICONS = [^\n]+;\n  function neuroIcon\(name\) \{[\s\S]*?\n  \}/);
  assert.ok(helperSource, "the NeuroCircuit helper must remain directly testable");
  const sandbox = {};
  vm.runInNewContext(`${helperSource[0]}\nresult = {
    valid: neuroIcon("apps"),
    inherited: neuroIcon("constructor"),
    prototype: neuroIcon("__proto__"),
    invalid: neuroIcon("../external"),
  };`, sandbox);
  assert.match(sandbox.result.valid, /neuro-icons\.svg#ng-apps/);
  assert.equal(sandbox.result.inherited, "");
  assert.equal(sandbox.result.prototype, "");
  assert.equal(sandbox.result.invalid, "");
  assert.match(app, /plug:\s*'<path/);
  assert.match(app, /function icon\(name\)/);

  const navSymbols = {
    overview: "overview",
    events: "events",
    channels: "channels",
    apps: "apps",
    config: "config",
    guide: "guide",
    evidence: "evidence",
  };
  for (const [tab, symbol] of Object.entries(navSymbols)) {
    assert.match(html, new RegExp(`data-tab="${tab}"[\\s\\S]*?/assets/neuro-icons\\.svg#ng-${symbol}[\\s\\S]*?<span class="lbl"`));
  }

  const kpiSymbols = ["apps", "channels", "events", "forwarding"];
  for (const symbol of kpiSymbols) {
    assert.match(html, new RegExp(`class="kpi-ico [^"]+"[\\s\\S]*?/assets/neuro-icons\\.svg#ng-${symbol}`));
  }

  assert.match(styles, /\.neuro-icon\s*\{/);
  assert.match(styles, /\.side-nav button \.neuro-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/s);
  assert.match(styles, /\.kpi \.kpi-ico \.neuro-icon\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/s);
  assert.match(styles, /\.empty-ico \.neuro-icon\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/s);
  assert.match(design, /## Iconografia NeuroCircuit[\s\S]*grade óptica `24×24`[\s\S]*### Decision log da iconografia/);
});

test("the application footer is a single by @goldneuron.io signature while source remains available", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const footer = html.match(/<footer class="app-footer">([\s\S]*?)<\/footer>/);

  assert.ok(footer, "the application footer must exist");
  assert.match(footer[1], /data-i18n="footer\.by">by @goldneuron\.io<\/a>/);
  assert.doesNotMatch(footer[1], /footerOffered|footerSource|class="dot"|Mantido pela|Código-fonte|AGPL-3\.0/);
  assert.equal((footer[1].match(/<a\b/g) || []).length, 1);

  assert.match(html, /id="aboutSource"[^>]*data-i18n="config\.sourceBtn"/);
  assert.match(app, /\$\("aboutSource"\)[\s\S]*?c\.sourceUrl/);
  assert.doesNotMatch(app, /footerOffered|footerSource|footer\.offered/);
  assert.match(readme, /Repositório público[^\n]*Configuração → Sobre|Configuração → Sobre[\s\S]*Repositório público/);
  assert.doesNotMatch(readme, /link \*\*"Código-fonte"\*\* no rodapé/);

  for (const locale of ["pt", "en", "es"]) {
    const copy = JSON.parse(fs.readFileSync(path.join(ROOT, "locales", `${locale}.json`), "utf8"));
    assert.equal(copy["footer.by"], "by @goldneuron.io");
    assert.equal(Object.hasOwn(copy, "footer.offered"), false);
    assert.equal(Object.hasOwn(copy, "footer.zpro"), false);
    assert.equal(Object.hasOwn(copy, "footer.source"), false);
    assert.equal(typeof copy["config.sourceBtn"], "string");
  }
});

test("visible application surfaces use only the @goldneuron.io brand", () => {
  const files = [
    "public/index.html",
    "public/app.js",
    "public/connect-waba.html",
    "public/connect-messenger.html",
    "public/connect-instagram.html",
    "public/politica-privacidade.html",
    "public/termos-servico.html",
    "public/lgpd.html",
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
