import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const CREDENTIAL_STORAGE_DESCRIPTION = "AES-256-GCM ciphertext in Durable Object SQLite (authoritative) with an encrypted Cloudflare KV mirror";

function controlPlane() {
  const recordDiagnostic = vi.fn(async () => undefined);
  const createAPIKey = vi.fn(async (name: string, days: number) => ({
    key: "m365_test-key",
    record: {
      id: "created-key",
      name,
      prefix: "m365_test",
      created_at: Date.now(),
      last_used_at: 0,
      expires_at: days ? Date.now() + days * 86_400_000 : 0,
      revoked: 0,
    },
  }));
  const updateAPIKeyExpiry = vi.fn(async () => true);
  const deleteAccount = vi.fn(async () => true);
  const state = {
    session: vi.fn(async () => ({ authenticated: true, mustChangePassword: false })),
    listAPIKeys: vi.fn(async () => [{
      id: "key-visible",
      name: "visible",
      prefix: "m365_visible",
      created_at: Date.parse("2026-08-24T01:02:03.000Z"),
      last_used_at: Date.parse("2026-08-25T04:05:06.000Z"),
      expires_at: 0,
      revoked: 0,
    }, {
      id: "key-unused",
      name: "unused",
      prefix: "m365_unused",
      created_at: Date.parse("2026-08-24T01:02:03.000Z"),
      last_used_at: 0,
      expires_at: Date.parse("2026-09-24T01:02:03.000Z"),
      revoked: 0,
    }]),
    createAPIKey,
    revokeAPIKey: vi.fn(async () => true),
    updateAPIKeyExpiry,
    deleteAccount,
    recordDiagnostic,
  };
  const env = {
    TENANTS: { getByName: () => state },
    ENVIRONMENT: "test",
    MAX_ACCOUNTS: "8",
  } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
  } as ExecutionContext;
  return { createAPIKey, ctx, deleteAccount, env, pending, recordDiagnostic, updateAPIKeyExpiry };
}

describe("Cloudflare administrator control-plane contracts", () => {
  it("returns real API Key last-use timestamps without exposing raw keys", async () => {
    const fixture = controlPlane();
    const response = await worker.fetch(new Request("https://example.test/api/admin/keys"), fixture.env, fixture.ctx);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      keys: [{
        id: "key-visible",
        name: "visible",
        prefix: "m365_visible",
        createdAt: "2026-08-24T01:02:03.000Z",
        lastUsedAt: "2026-08-25T04:05:06.000Z",
        expiresAt: null,
        revoked: false,
      }, {
        id: "key-unused",
        name: "unused",
        prefix: "m365_unused",
        createdAt: "2026-08-24T01:02:03.000Z",
        lastUsedAt: null,
        expiresAt: "2026-09-24T01:02:03.000Z",
        revoked: false,
      }],
    });
    expect(JSON.stringify(payload)).not.toContain("m365_test-key");
    await Promise.all(fixture.pending);
  });

  it.each([
    ["POST", null, "invalid_api_key_request"],
    ["POST", { name: 42, days: 1 }, "invalid_api_key_name"],
    ["POST", { name: "valid", days: "1" }, "invalid_api_key_days"],
    ["POST", { name: "", days: 1 }, "invalid_api_key_name"],
    ["POST", { name: "x".repeat(101), days: 1 }, "invalid_api_key_name"],
    ["POST", { name: "valid", days: -1 }, "invalid_api_key_days"],
    ["POST", { name: "valid", days: 1.5 }, "invalid_api_key_days"],
    ["POST", { name: "valid", days: 3_651 }, "invalid_api_key_days"],
    ["PATCH", [], "invalid_api_key_request"],
    ["PATCH", { id: 7, days: 1 }, "invalid_api_key_id"],
    ["PATCH", { id: "key-visible", days: "1" }, "invalid_api_key_days"],
    ["PATCH", { id: "key-visible", days: Number.NaN }, "invalid_api_key_days"],
  ])("maps invalid %s API Key input to HTTP 400", async (method, body, expectedCode) => {
    const fixture = controlPlane();
    const response = await worker.fetch(new Request("https://example.test/api/admin/keys", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), fixture.env, fixture.ctx);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: expectedCode } });
    expect(fixture.createAPIKey).not.toHaveBeenCalled();
    expect(fixture.updateAPIKeyExpiry).not.toHaveBeenCalled();
    await Promise.all(fixture.pending);
  });

  it("describes the authoritative encrypted credential store and its KV mirror consistently", async () => {
    const fixture = controlPlane();
    const [health, settings] = await Promise.all([
      worker.fetch(new Request("https://example.test/api/health"), fixture.env, fixture.ctx),
      worker.fetch(new Request("https://example.test/api/admin/settings"), fixture.env, fixture.ctx),
    ]);

    await expect(health.json()).resolves.toMatchObject({
      metadataStorage: "durable-object-sqlite",
      credentialStorage: CREDENTIAL_STORAGE_DESCRIPTION,
    });
    await expect(settings.json()).resolves.toMatchObject({
      settings: {
        credentialStorage: CREDENTIAL_STORAGE_DESCRIPTION,
        capabilities: { strongAccountSessionCleanup: false },
      },
    });
    await Promise.all(fixture.pending);
  });

  it("never reports a fabricated session deletion count when removing an account", async () => {
    const fixture = controlPlane();
    const response = await worker.fetch(new Request("https://example.test/api/accounts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "account-visible" }),
    }), fixture.env, fixture.ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "deleted",
      sessionsRemoved: null,
      sessionCleanup: {
        status: "not_performed",
        reason: "authoritative_account_session_registry_unavailable",
      },
    });
    expect(fixture.deleteAccount).toHaveBeenCalledWith("account-visible");
    await Promise.all(fixture.pending);
  });
});
