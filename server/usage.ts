import { createDecipheriv } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { hashAccountKey, unavailable, type UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import { parseFactoryQuota } from "./quota";

const execute = promisify(execFile);
const GLOBAL_ORIGIN = "https://api.factory.ai";
const EU_ORIGIN = "https://api.eu.factory.ai";
const inputSchema = z.strictObject({
  directory: z.string().refine(isAbsolute),
  development: z.boolean(),
  disableKeyring: z.boolean(),
});
type Locator = z.infer<typeof inputSchema>;
interface Login { accessToken: string; organization?: string; accountOrganization?: string; subject?: string; region: "global" | "eu"; expiresAt?: number }
export interface DroidUsageDependencies {
  env: Readonly<Record<string, string | undefined>>;
  home: () => string;
  platform: string;
  readText: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  keychainKey: (development: boolean) => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
}
const defaults: DroidUsageDependencies = {
  env: process.env, home: homedir, platform: process.platform,
  readText: (path) => readFile(path, "utf8"),
  exists: async (path) => { try { await access(path); return true; } catch { return false; } },
  keychainKey: async (development) => {
    const { stdout } = await execute("/usr/bin/security", [
      "find-generic-password", "-s", "Factory CLI", "-a",
      `auth-encryption-key-security-cli${development ? "-dev" : ""}`, "-w",
    ], { timeout: 5000, maxBuffer: 4096 });
    return stdout.trim();
  },
  fetch: (...args) => fetch(...args), now: Date.now,
};

/** Read-only adapter for the same login and endpoint used by Droid 0.244 /limits. */
export function createDroidUsageSource(overrides: Partial<DroidUsageDependencies> = {}): UsageSourceRegistration {
  const deps = { ...defaults, ...overrides };

  function locator(env: DroidUsageDependencies["env"], global: boolean): Locator | undefined {
    // A session using an explicit API key is a different login. Never fall
    // through to the user's stored subscription to make its quota look valid.
    if (env.FACTORY_API_KEY?.trim() || /^(true|1)$/i.test(env.FACTORY_AIRGAP_ENABLED ?? "")) return undefined;
    // Custom backends cannot safely be represented as hosted Factory quota.
    if ((env.FACTORY_API_BASE_URL && env.FACTORY_API_BASE_URL.replace(/\/$/, "") !== GLOBAL_ORIGIN) ||
        (env.FACTORY_API_BASE_URL_EU && env.FACTORY_API_BASE_URL_EU.replace(/\/$/, "") !== EU_ORIGIN)) return undefined;
    const home = env.FACTORY_HOME_OVERRIDE || env.HOME || (global ? deps.home() : undefined);
    if (!home || !isAbsolute(home)) return undefined;
    const development = env.FACTORY_ENV === "development";
    return { directory: join(home, development ? ".factory-dev" : ".factory"), development,
      disableKeyring: /^(true|1)$/i.test(env.FACTORY_DISABLE_KEYRING ?? "") };
  }

  async function hasStore(input: Locator) {
    const candidates = ["auth.v2.file", ...(!input.disableKeyring ? ["auth.v2.loginkeychain", "auth.v2.keyring"] : [])];
    return (await Promise.all(candidates.map((name) => deps.exists(join(input.directory, name))))).some(Boolean);
  }

  async function readLogin(input: Locator): Promise<Login> {
    const candidates: Array<() => Promise<string>> = [];
    if (!input.disableKeyring && deps.platform === "darwin" && await deps.exists(join(input.directory, "auth.v2.loginkeychain"))) {
      candidates.push(async () => decrypt(await deps.readText(join(input.directory, "auth.v2.loginkeychain")), await deps.keychainKey(input.development)));
    }
    if (await deps.exists(join(input.directory, "auth.v2.file"))) {
      candidates.push(async () => decrypt(await deps.readText(join(input.directory, "auth.v2.file")), await deps.readText(join(input.directory, "auth.v2.key"))));
    }
    for (const read of candidates) {
      try { return parseLogin(await read()); } catch { /* Native CLI also falls back to its file store. */ }
    }
    // No subprocess, JSON, ciphertext, or upstream error content escapes here.
    throw new Error("Could not read the Droid login. This adapter supports macOS Keychain and Factory's encrypted file store. Sign in with droid and retry.");
  }

  return {
    id: "factory-quota", label: "Factory", icon: "icon.svg", input: inputSchema,
    async discover(scope) {
      if (scope.kind === "session" && scope.provider !== "droid-native") return [];
      const input = locator(scope.kind === "global" ? deps.env : scope.env, scope.kind === "global");
      if (!input || !await hasStore(input)) return [];
      let identity = `store:${input.directory}`;
      try {
        const login = await readLogin(input);
        if (login.subject || login.accountOrganization) identity = `${login.region}:${login.subject ?? ""}:${login.accountOrganization ?? ""}`;
      } catch { /* Existing but unreadable logins still get a useful error card. */ }
      return [{ key: hashAccountKey(identity), label: "Factory", harness: "Droid", input }];
    },
    async fetch(value) {
      const input = inputSchema.parse(value);
      let login: Login;
      try { login = await readLogin(input); }
      catch (error) { return { status: "error", error: (error as Error).message }; }
      if (login.expiresAt !== undefined && login.expiresAt <= deps.now()) {
        return unavailable({ kind: "expired", expiresAt: new Date(login.expiresAt).toISOString(), refreshedBy: "droid" });
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${login.accessToken}`, "X-Factory-Client": "cli", "X-Client-Version": "0.244.0",
      };
      if (login.organization) headers["X-Factory-Org-Id"] = login.organization;
      try {
        const response = await deps.fetch(`${login.region === "eu" ? EU_ORIGIN : GLOBAL_ORIGIN}/api/billing/limits`, {
          method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10000),
        });
        if (response.status === 401 || response.status === 403) return unavailable({ kind: "rejected", status: response.status, refreshedBy: "droid" });
        if (!response.ok) return { status: "error", error: `Factory quota request failed (HTTP ${response.status}).` };
        return parseFactoryQuota(await response.json(), deps.now());
      } catch {
        return { status: "error", error: "Could not fetch Factory quota. The request timed out or returned an invalid response." };
      }
    },
  };
}

function decrypt(encrypted: string, encodedKey: string): string {
  if (encrypted.length > 1024 * 1024) throw new Error("Invalid credential store.");
  const parts = encrypted.trim().split(":");
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (parts.length !== 3 || key.length !== 32) throw new Error("Invalid credential store.");
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  if (!iv.length || tag.length !== 16) throw new Error("Invalid credential store.");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function parseLogin(value: string): Login {
  const login = z.object({
    access_token: z.string().min(1), active_organization_id: z.string().min(1).nullable().optional(),
    whoami: z.object({ region: z.enum(["global", "eu"]).nullable().optional() }).nullable().optional(),
    region: z.enum(["global", "eu"]).nullable().optional(),
  }).parse(JSON.parse(value));
  let claims: Record<string, unknown> = {};
  try {
    const decoded: unknown = JSON.parse(Buffer.from(login.access_token.split(".")[1], "base64url").toString("utf8"));
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) claims = decoded as Record<string, unknown>;
  }
  catch { /* Opaque access tokens remain authenticated by the upstream API. */ }
  const expiresAt = typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0 && claims.exp < 8.64e12 ? claims.exp * 1000 : undefined;
  return {
    accessToken: login.access_token, organization: login.active_organization_id ?? undefined,
    accountOrganization: login.active_organization_id ||
      (typeof claims.external_org_id === "string" && claims.external_org_id ? claims.external_org_id : undefined) ||
      (typeof claims.org_id === "string" && claims.org_id ? claims.org_id : undefined),
    subject: typeof claims.sub === "string" && claims.sub ? claims.sub : undefined,
    region: login.whoami?.region ?? (!login.whoami ? login.region : undefined) ?? "global", expiresAt,
  };
}
