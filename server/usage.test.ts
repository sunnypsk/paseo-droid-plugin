import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createDroidUsageSource } from "./usage";

const key = Buffer.alloc(32, 7);
const now = Date.parse("2026-10-17T08:00:00Z");
// All filesystem access below uses an in-memory store. Match the runtime's
// native path format without reading or creating real credential files.
const syntheticHome = resolve("/synthetic");
const factoryDirectory = join(syntheticHome, ".factory");
const loginPath = (name: string) => join(factoryDirectory, name);
function token(subject = "synthetic-user", expiration = now / 1000 + 3600, organization?: string) {
  return `header.${Buffer.from(JSON.stringify({ sub: subject, exp: expiration, org_id: organization })).toString("base64url")}.signature`;
}
function encryptValue(value: unknown) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(":");
}
function encrypted(accessToken = token(), region = "global", organization = "synthetic-org") {
  return encryptValue({ access_token: accessToken, refresh_token: "NEVER_TRANSMIT_REFRESH", active_organization_id: organization, whoami: { region } });
}
function fixture(env: Record<string, string> = { HOME: syntheticHome }, platform = "darwin") {
  const stores = new Map<string, string>([[loginPath("auth.v2.loginkeychain"), encrypted()]]);
  const requests: Array<{url: string; init?: RequestInit}> = [];
  const reads: string[] = [];
  const keychainRequests: boolean[] = [];
  let response = () => new Response(JSON.stringify({ limits: { standard: { fiveHour: { usedPercent: 25, windowEnd: "2026-10-17T10:00:00Z" } } } }), { status: 200 });
  const source = createDroidUsageSource({
    env, home: () => resolve("/wrong-default"), platform, now: () => now,
    exists: async (path) => stores.has(path),
    readText: async (path) => { reads.push(path); if (!stores.has(path)) throw new Error("private-file-error"); return stores.get(path)!; },
    keychainKey: async (development) => { keychainRequests.push(development); return key.toString("base64"); },
    fetch: async (input, init) => { requests.push({ url: String(input), init }); return response(); },
  });
  return { source, stores, requests, reads, keychainRequests, response: (next: typeof response) => { response = next; } };
}

test("Usage discovery scopes the session login to its launch home and ignores other providers/API-key sessions", async () => {
  const f = fixture();
  assert.deepEqual(await f.source.discover({ kind: "session", provider: "codex", env: { HOME: syntheticHome } }), []);
  assert.deepEqual(await f.source.discover({ kind: "session", provider: "droid-native", env: { HOME: syntheticHome, FACTORY_API_KEY: "different-account-secret" } }), []);
  assert.deepEqual(await f.source.discover({ kind: "session", provider: "droid-native", env: {} }), []);
  assert.deepEqual(await f.source.discover({ kind: "session", provider: "droid-native", env: { HOME: syntheticHome, FACTORY_API_BASE_URL: "https://unrelated.invalid" } }), []);
  assert.deepEqual(await f.source.discover({ kind: "session", provider: "droid-native", env: { HOME: syntheticHome, FACTORY_AIRGAP_ENABLED: "TRUE" } }), []);
  assert.deepEqual(f.reads, []);
  const global = await f.source.discover({ kind: "global" });
  const session = await f.source.discover({ kind: "session", provider: "droid-native", env: { HOME: syntheticHome } });
  assert.equal(global.length, 1); assert.deepEqual(session, global);
  assert.match(global[0].key, /^[A-Za-z0-9._-]{1,128}$/);
  assert(!JSON.stringify(global).includes("synthetic-user"));
  assert(!JSON.stringify(global).includes("access_token"));
  assert(!JSON.stringify(global).includes(token()));
  assert.deepEqual(await fixture({ HOME: syntheticHome, FACTORY_API_KEY: "different-account" }).source.discover({ kind: "global" }), []);
});

test("Windows encrypted file login supports global and session quota without Keychain", async () => {
  const f = fixture({ HOME: syntheticHome }, "win32");
  f.stores.clear();
  f.stores.set(loginPath("auth.v2.file"), encrypted());
  f.stores.set(loginPath("auth.v2.key"), key.toString("base64"));
  const global = await f.source.discover({ kind: "global" });
  const session = await f.source.discover({ kind: "session", provider: "droid-native", env: { HOME: syntheticHome } });
  assert.equal(global.length, 1);
  assert.deepEqual(session, global);
  assert.deepEqual(global[0].input, { directory: factoryDirectory, development: false, disableKeyring: false });
  assert.equal((await f.source.fetch(global[0].input)).status, "available");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "https://api.factory.ai/api/billing/limits");
  assert.deepEqual(f.keychainRequests, []);
  assert.deepEqual(new Set(f.reads), new Set([loginPath("auth.v2.file"), loginPath("auth.v2.key")]));
});

test("fetch re-reads a rotated token without changing account identity or returning credentials", async () => {
  const f = fixture();
  const [account] = await f.source.discover({ kind: "global" });
  const rotated = token("synthetic-user", now / 1000 + 7200);
  f.stores.set(loginPath("auth.v2.loginkeychain"), encrypted(rotated));
  const report = await f.source.fetch(account.input);
  assert.equal(report.status, "available");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "https://api.factory.ai/api/billing/limits");
  assert.equal(f.requests[0].init?.method, "GET");
  assert.equal(f.requests[0].init?.redirect, "error");
  const headers = f.requests[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${rotated}`);
  assert.equal(headers["X-Factory-Org-Id"], "synthetic-org");
  assert(!JSON.stringify(f.requests).includes("NEVER_TRANSMIT_REFRESH"));
  assert(!JSON.stringify(report).includes(rotated));
  assert.equal((await f.source.discover({ kind: "global" }))[0].key, account.key);
});

test("expired login and upstream rejection have typed remedies without token refresh", async () => {
  const f = fixture();
  f.stores.set(loginPath("auth.v2.loginkeychain"), encrypted(token("synthetic-user", now / 1000 - 1)));
  const [account] = await f.source.discover({ kind: "global" });
  assert.deepEqual(await f.source.fetch(account.input), { status: "unavailable", problem: { kind: "expired", expiresAt: new Date(now - 1000).toISOString(), refreshedBy: "droid" } });
  assert.equal(f.requests.length, 0);
  f.stores.set(loginPath("auth.v2.loginkeychain"), encrypted());
  f.response(() => new Response("private-upstream-body", { status: 401 }));
  assert.deepEqual(await f.source.fetch(account.input), { status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "droid" } });
});

test("Factory home override, development store and keyfile fallback follow native launch settings", async () => {
  const f = fixture();
  const overrideHome = resolve("/override");
  const directory = join(overrideHome, ".factory-dev");
  f.stores.set(join(directory, "auth.v2.file"), encrypted(token(), "eu"));
  f.stores.set(join(directory, "auth.v2.key"), key.toString("base64"));
  const [account] = await f.source.discover({ kind: "session", provider: "droid-native", env: { HOME: syntheticHome, FACTORY_HOME_OVERRIDE: overrideHome, FACTORY_ENV: "development", FACTORY_DISABLE_KEYRING: "TRUE" } });
  assert(account);
  assert.equal((await f.source.fetch(account.input)).status, "available");
  assert.equal(f.requests[0].url, "https://api.eu.factory.ai/api/billing/limits");
  assert.deepEqual(f.keychainRequests, []);
  assert(f.reads.every((path) => path.startsWith(directory)));
});

test("unreadable Keychain falls back to encrypted file; disappeared or corrupt login stays sanitized", async () => {
  const f = fixture();
  f.stores.set(loginPath("auth.v2.loginkeychain"), "PRIVATE_INVALID_CIPHERTEXT");
  f.stores.set(loginPath("auth.v2.file"), encrypted());
  f.stores.set(loginPath("auth.v2.key"), key.toString("base64"));
  const [account] = await f.source.discover({ kind: "global" });
  assert.equal((await f.source.fetch(account.input)).status, "available");
  f.stores.clear();
  const report = await f.source.fetch(account.input);
  assert.equal(report.status, "error");
  assert(!JSON.stringify(report).includes("PRIVATE_INVALID_CIPHERTEXT"));
  assert(!JSON.stringify(report).includes("private-file-error"));
  assert.deepEqual(await f.source.discover({ kind: "global" }), []);
});

test("network and HTTP errors never expose upstream response or exception content", async () => {
  const f = fixture();
  const [account] = await f.source.discover({ kind: "global" });
  f.response(() => { throw new Error("PRIVATE_FETCH_ERROR"); });
  const network = await f.source.fetch(account.input);
  assert.equal(network.status, "error"); assert(!JSON.stringify(network).includes("PRIVATE_FETCH_ERROR"));
  f.response(() => new Response("PRIVATE_HTTP_ERROR", { status: 500 }));
  const http = await f.source.fetch(account.input);
  assert.equal(http.status, "error"); assert(!JSON.stringify(http).includes("PRIVATE_HTTP_ERROR"));
});

test("nullable native login metadata uses legacy region and separates default organization identities", async () => {
  const f = fixture();
  f.stores.set(loginPath("auth.v2.loginkeychain"), encryptValue({ access_token: token("same-user", now / 1000 + 3600, "org-one"), active_organization_id: null, whoami: null, region: "eu" }));
  const [first] = await f.source.discover({ kind: "global" });
  assert.equal((await f.source.fetch(first.input)).status, "available");
  assert.equal(f.requests[0].url, "https://api.eu.factory.ai/api/billing/limits");
  assert.equal((f.requests[0].init?.headers as Record<string, string>)["X-Factory-Org-Id"], undefined);
  f.stores.set(loginPath("auth.v2.loginkeychain"), encryptValue({ access_token: token("same-user", now / 1000 + 3600, "org-two"), active_organization_id: null, whoami: null, region: "eu" }));
  const [second] = await f.source.discover({ kind: "global" });
  assert.notEqual(second.key, first.key);
});
