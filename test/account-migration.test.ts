import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { base64url, sha256 } from "../src/crypto";
import worker from "../src/index";
import { ACCOUNT_MIGRATION_PATH, verifyAccountMigration } from "../src/migration";
import { accountChatHubRelay } from "../src/openai";
import type { AccountEgress, Env, OAuthTokenSet } from "../src/types";

const VERSION = "11111111-2222-4333-8444-555555555555";
const SIGNING_KEY = "unit-test-migration-signing-key-with-at-least-32-characters";
const encoder = new TextEncoder();

function token(index: number): OAuthTokenSet {
  return {
    accessToken: `test-only-access-token-${index}-${"a".repeat(24)}`,
    refreshToken: `test-only-refresh-token-${index}-${"r".repeat(24)}`,
    expiresAt: Date.now() + 3_600_000,
    email: `migration-${index}@example.test`,
    displayName: `Migration account ${index}`,
    oid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    tid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  };
}

function payload(count = 20, activeSequence = 7, migrationId = "migration-test-batch-0001") {
  const egress: AccountEgress[] = ["direct", "relay5", "relay7"];
  return {
    migrationId,
    activeSequence,
    accounts: Array.from({ length: count }, (_, index) => ({
      token: token(index + 1),
      egress: egress[index % egress.length],
    })),
  };
}

async function signature(body: string, timestamp: string, nonce: string): Promise<string> {
  const bodyHash = await sha256(body);
  const canonical = ["v1", timestamp, nonce, "POST", ACCOUNT_MIGRATION_PATH, bodyHash, VERSION].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `v1=${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical))))}`;
}

async function signedRequest(
  value: unknown,
  options: { nonce?: string; timestamp?: string; signature?: string; override?: boolean } = {},
): Promise<Request> {
  const body = JSON.stringify(value);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? `nonce_${crypto.randomUUID().replaceAll("-", "")}`;
  return new Request(`https://candidate.test${ACCOUNT_MIGRATION_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cloudflare-Workers-Version-Overrides": options.override === false ? "" : `m365-gateway-cloudflare=\"${VERSION}\"`,
      "X-M365-Migration-Version": VERSION,
      "X-M365-Migration-Timestamp": timestamp,
      "X-M365-Migration-Nonce": nonce,
      "X-M365-Migration-Signature": options.signature ?? await signature(body, timestamp, nonce),
    },
    body,
  });
}

function candidateEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    MAX_ACCOUNTS: "40",
    MIGRATION_ENABLED: "true",
    MIGRATION_CANDIDATE_TAG: "account-migration-candidate",
    MIGRATION_SIGNING_KEY: SIGNING_KEY,
    CF_VERSION_METADATA: { id: VERSION, tag: "account-migration-candidate", timestamp: "2026-08-26T00:00:00.000Z" },
    ...overrides,
  } as Env;
}

describe("signed candidate-only account migration", () => {
  it("never silently downgrades a relay-bound account to direct Cloudflare egress", () => {
    expect(accountChatHubRelay(candidateEnv(), "direct")).toBeUndefined();
    expect(() => accountChatHubRelay(candidateEnv(), "relay5")).toThrow("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
    expect(() => accountChatHubRelay(candidateEnv(), "relay7")).toThrow("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
    expect(accountChatHubRelay(candidateEnv({
      RELAY5_URL: "https://relay-five.example.test",
      RELAY5_HMAC_SECRET: "test-only-relay-five-secret-with-32-characters",
      RELAY_ORIGIN: "https://candidate.test",
    }), "relay5")).toEqual({
      baseURL: "https://relay-five.example.test",
      hmacSecret: "test-only-relay-five-secret-with-32-characters",
      origin: "https://candidate.test",
    });
  });

  it("authenticates a bounded batch without accepting a normal API key or admin cookie", async () => {
    const input = payload();
    const verified = await verifyAccountMigration(await signedRequest(input), candidateEnv());
    expect(verified.input.accounts).toHaveLength(20);
    expect(verified.input.activeSequence).toBe(7);

    const unsigned = new Request(`https://candidate.test${ACCOUNT_MIGRATION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer m365_ordinary-key-cannot-authorize-migration",
        Cookie: "m365_admin_session=fake-admin-session",
        "Cloudflare-Workers-Version-Overrides": `m365-gateway-cloudflare=\"${VERSION}\"`,
        "X-M365-Migration-Version": VERSION,
        "X-M365-Migration-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-M365-Migration-Nonce": `nonce_${"x".repeat(32)}`,
      },
      body: JSON.stringify(input),
    });
    await expect(verifyAccountMigration(unsigned, candidateEnv())).rejects.toMatchObject({
      status: 401,
      code: "invalid_migration_signature",
    });
  });

  it.each([
    ["disabled", { MIGRATION_ENABLED: "false" }, {}, 404, "migration_not_available"],
    ["wrong current version", { CF_VERSION_METADATA: { id: "other-version", tag: "", timestamp: "" } }, {}, 404, "migration_not_available"],
    ["wrong candidate tag", { CF_VERSION_METADATA: { id: VERSION, tag: "ordinary-production", timestamp: "" } }, {}, 404, "migration_not_available"],
    ["no version override", {}, { override: false }, 404, "migration_not_available"],
    ["missing signing secret", { MIGRATION_SIGNING_KEY: "" }, {}, 503, "migration_not_configured"],
    ["ordinary API key reused as signing secret", { MIGRATION_SIGNING_KEY: `m365_${"x".repeat(40)}` }, {}, 503, "migration_not_configured"],
    ["stale timestamp", {}, { timestamp: "1700000000" }, 401, "migration_signature_expired"],
    ["wrong signature", {}, { signature: "v1=definitely-wrong" }, 401, "invalid_migration_signature"],
  ])("fails closed when %s", async (_label, environment, requestOptions, status, code) => {
    await expect(verifyAccountMigration(
      await signedRequest(payload(), requestOptions as Parameters<typeof signedRequest>[1]),
      candidateEnv(environment as Partial<Env>),
    )).rejects.toMatchObject({ status, code });
  });

  it.each([
    [{ ...payload(1, 1), extra: true }, "invalid_migration_payload"],
    [{ ...payload(1, 1), activeSequence: 2 }, "invalid_active_sequence"],
    [{ ...payload(1, 1), accounts: [{ token: token(1), egress: "socks5" }] }, "invalid_migration_account"],
    [{ ...payload(1, 1), accounts: [{ token: token(1), egress: "direct", proxy: "must-not-be-accepted" }] }, "invalid_migration_account"],
    [{ ...payload(1, 1), accounts: [
      { token: token(1), egress: "direct" },
      { token: { ...token(2), email: token(1).email }, egress: "relay5" },
    ] }, "duplicate_migration_account"],
    [payload(41, 1), "invalid_migration_account_count"],
  ])("strictly rejects malformed or credential-adjacent fields", async (value, code) => {
    await expect(verifyAccountMigration(await signedRequest(value), candidateEnv())).rejects.toMatchObject({ code });
  });

  it("preserves twenty-account order, selects one active sequence, and stores only ciphertext", async () => {
    const state = env.TENANTS.getByName(`migration-storage-${crypto.randomUUID()}`);
    const input = payload();
    const result = await state.importAccountMigration(
      input.migrationId,
      await sha256(JSON.stringify(input)),
      await sha256("nonce-first-import"),
      input.activeSequence,
      input.accounts,
    );
    expect(result).toEqual({ migrationId: input.migrationId, importedCount: 20, activeSequence: 7, replayed: false });

    const accounts = await state.listAccounts();
    expect(accounts.map((account) => account.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(accounts.map((account) => account.egress)).toEqual(input.accounts.map((account) => account.egress));
    expect(accounts.filter((account) => account.active).map((account) => account.sequence)).toEqual([7]);
    expect(accounts.filter((account) => !account.active).every((account) => account.isolated)).toBe(true);
    await expect(state.selectAccount()).resolves.toMatchObject({ sequence: 7, egress: "direct" });

    await runInDurableObject(state, async (_instance, durableState) => {
      const rows = durableState.storage.sql.exec<{
        id: string;
        token_cipher: string;
        credential_kv_key: string;
        egress_type: string;
      }>("SELECT id,token_cipher,credential_kv_key,egress_type FROM accounts ORDER BY sequence_no").toArray();
      expect(rows).toHaveLength(20);
      for (let index = 0; index < rows.length; index += 1) {
        expect(rows[index].token_cipher).not.toContain("test-only-access-token");
        expect(rows[index].token_cipher).not.toContain("test-only-refresh-token");
        expect(rows[index].token_cipher.startsWith("kv:")).toBe(false);
        await expect(env.SENSITIVE_KV.get(rows[index].credential_kv_key)).resolves.toBe(rows[index].token_cipher);
      }
    });

    const reauthorized = await state.upsertAccount({
      ...input.accounts[1].token,
      accessToken: `test-only-refreshed-access-${"n".repeat(32)}`,
    });
    expect(reauthorized).toMatchObject({ sequence: 2, egress: "relay5", active: false, isolated: true });

    const active = await state.selectAccount();
    expect(active).toMatchObject({ sequence: 7, egress: "direct" });
    await state.reportAccountFailure(active!.accountId, "transient", active!.routeEpoch);
    await expect(state.selectAccount()).resolves.toMatchObject({ sequence: 8, egress: "relay5" });
  });

  it("rejects nonce replay and makes a new-nonce retry idempotent by migration id and body hash", async () => {
    const state = env.TENANTS.getByName(`migration-replay-${crypto.randomUUID()}`);
    const input = payload(2, 2, "migration-replay-batch");
    const bodyHash = await sha256(JSON.stringify(input));
    const nonceHash = await sha256("nonce-used-once");
    await state.importAccountMigration(input.migrationId, bodyHash, nonceHash, 2, input.accounts);
    await runInDurableObject(state, async (instance) => {
      await expect(instance.importAccountMigration(input.migrationId, bodyHash, nonceHash, 2, input.accounts))
        .rejects.toThrow("MIGRATION_REPLAY");
    });
    await expect(state.importAccountMigration(input.migrationId, bodyHash, await sha256("fresh-nonce"), 2, input.accounts))
      .resolves.toEqual({ migrationId: input.migrationId, importedCount: 2, activeSequence: 2, replayed: true });
    await runInDurableObject(state, async (instance) => {
      await expect(instance.importAccountMigration(
        input.migrationId,
        "different-body-hash",
        await sha256("another-nonce"),
        1,
        input.accounts,
      )).rejects.toThrow("MIGRATION_ID_CONFLICT");
    });
  });

  it("exposes only a receipt through the worker and never returns OAuth material", async () => {
    const importAccountMigration = vi.fn(async () => ({
      migrationId: "migration-worker-route",
      importedCount: 1,
      activeSequence: 1,
      replayed: false,
    }));
    const recordDiagnostic = vi.fn(async () => undefined);
    const routeEnv = candidateEnv({
      TENANTS: { getByName: () => ({ importAccountMigration, recordDiagnostic }) } as unknown as Env["TENANTS"],
    });
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(
      await signedRequest(payload(1, 1, "migration-worker-route")),
      routeEnv,
      { waitUntil: (promise) => pending.push(promise) } as ExecutionContext,
    );
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      status: "imported",
      migrationId: "migration-worker-route",
      importedCount: 1,
      activeSequence: 1,
      replayed: false,
    });
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("refreshToken");
    expect(importAccountMigration).toHaveBeenCalledOnce();
    await Promise.all(pending);
  });
});
