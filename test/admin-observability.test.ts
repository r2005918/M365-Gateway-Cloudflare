import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env, PublicAccount } from "../src/types";

function testToken(id: string) {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    email: `${id}@example.test`,
    displayName: id,
    oid: id,
    tid: "observability-test-tenant",
  };
}

describe("Cloudflare management observability", () => {
  it("persists bounded per-account usage totals and really resets them", async () => {
    const state = env.TENANTS.getByName(`stats-${crypto.randomUUID()}`);
    const account = await state.upsertAccount(testToken(`account-${crypto.randomUUID()}`));

    await state.recordRequest({ requestId: "metric-1", accountId: account.id, status: 200, tokenIn: 12.9, tokenOut: -4 });
    await state.recordRequest({ requestId: "metric-2", accountId: account.id, status: 503, tokenIn: Number.POSITIVE_INFINITY, tokenOut: 2_000_000_000 });
    // Retrying a completion write is safe and cannot double-count usage.
    await state.recordRequest({ requestId: "metric-2", accountId: account.id, status: 503, tokenIn: 999, tokenOut: 999 });

    await expect(state.statsSnapshot()).resolves.toEqual({
      totalRequestCount: 2,
      totalErrorCount: 1,
      totalTokenIn: 12,
      totalTokenOut: 1_000_000_000,
      lastRequestAt: expect.any(String),
    });
    await expect(state.listAccounts()).resolves.toEqual([
      expect.objectContaining({
        id: account.id,
        requestCount: 2,
        errorCount: 1,
        tokenIn: 12,
        tokenOut: 1_000_000_000,
        lastRequestAt: expect.any(String),
      }),
    ]);

    await expect(state.resetRequestStats()).resolves.toEqual({
      totalRequestCount: 0,
      totalErrorCount: 0,
      totalTokenIn: 0,
      totalTokenOut: 0,
      lastRequestAt: null,
    });
    await expect(state.listAccounts()).resolves.toEqual([
      expect.objectContaining({ id: account.id, requestCount: 0, errorCount: 0, tokenIn: 0, tokenOut: 0, lastRequestAt: null }),
    ]);
  });

  it("keeps a 200-row diagnostic ring and cannot persist request secrets", async () => {
    const state = env.TENANTS.getByName(`diagnostics-${crypto.randomUUID()}`);
    for (let index = 0; index < 205; index += 1) {
      await state.recordDiagnostic({
        requestId: `request-${index}`,
        method: "GET",
        path: `/api/test/${index}`,
        status: 200,
        durationMs: index,
      });
    }
    await state.recordDiagnostic({
      requestId: "m365_secret key",
      method: "POST\r\nAuthorization: Bearer secret",
      path: "/v1/chat/completions?api_key=m365_secret&email=private@example.test",
      status: 503,
      durationMs: Number.MAX_SAFE_INTEGER,
      code: "token=private-secret",
    });

    const records = await state.listDiagnostics(10_000);
    expect(records).toHaveLength(200);
    expect(records[0]).toMatchObject({
      id: "redacted",
      level: "error",
      method: "OTHER",
      path: "/v1/chat/completions",
      status: 503,
      durationMs: 3_600_000,
      code: "",
    });
    expect(JSON.stringify(records)).not.toContain("m365_secret");
    expect(JSON.stringify(records)).not.toContain("private@example.test");
    expect(await state.listDiagnostics(-100)).toHaveLength(1);
  }, 15_000);

  it("serves real management data and an explicit platform capability matrix", async () => {
    const account: PublicAccount = {
      id: "account-visible",
      email: "masked@example.test",
      displayName: "Visible",
      sequence: 1,
      active: true,
      isolated: false,
      status: "online",
      health: "healthy",
      cooldownUntil: null,
      failureKind: "",
      requestCount: 7,
      errorCount: 1,
      tokenIn: 120,
      tokenOut: 30,
      lastRequestAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    };
    const diagnosticWrites: unknown[] = [];
    let resetCalls = 0;
    const state = {
      session: async () => ({ authenticated: true, mustChangePassword: false }),
      listAccounts: async () => [account],
      statsSnapshot: async () => ({ totalRequestCount: 7, totalErrorCount: 1, totalTokenIn: 120, totalTokenOut: 30, lastRequestAt: account.lastRequestAt }),
      listDiagnostics: async (limit: number) => [{ id: "request-visible", at: account.lastRequestAt, level: "info", method: "GET", path: "/api/accounts", status: 200, durationMs: limit, code: "" }],
      resetRequestStats: async () => {
        resetCalls += 1;
        return { totalRequestCount: 0, totalErrorCount: 0, totalTokenIn: 0, totalTokenOut: 0, lastRequestAt: null };
      },
      recordDiagnostic: async (input: unknown) => { diagnosticWrites.push(input); },
    };
    const fakeEnv = {
      TENANTS: { getByName: () => state },
      MAX_ACCOUNTS: "8",
      ENVIRONMENT: "test",
    } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;

    const accountsResponse = await worker.fetch(new Request("https://example.test/api/accounts"), fakeEnv, ctx);
    expect(accountsResponse.status).toBe(200);
    await expect(accountsResponse.json()).resolves.toMatchObject({
      accounts: [expect.objectContaining({ id: account.id, requestCount: 7 })],
      totalRequestCount: 7,
      totalErrorCount: 1,
      totalTokenIn: 120,
      totalTokenOut: 30,
    });

    const logsResponse = await worker.fetch(new Request("https://example.test/api/admin/debug/logs?limit=999"), fakeEnv, ctx);
    await expect(logsResponse.json()).resolves.toMatchObject({ records: [expect.objectContaining({ id: "request-visible", durationMs: 999 })], maxRecords: 200 });

    const settingsResponse = await worker.fetch(new Request("https://example.test/api/admin/settings"), fakeEnv, ctx);
    await expect(settingsResponse.json()).resolves.toMatchObject({
      settings: {
        capabilities: {
          multipleAccounts: true,
          persistentUsageStats: true,
          boundedDiagnostics: true,
          strongAccountSessionCleanup: false,
          runtimeSettingsWrite: false,
          perAccountProxy: false,
          filesystemPaths: false,
          localProcessLaunch: false,
        },
      },
    });

    const resetResponse = await worker.fetch(new Request("https://example.test/api/admin/reset-stats", { method: "POST" }), fakeEnv, ctx);
    await expect(resetResponse.json()).resolves.toMatchObject({ status: "reset", totalRequestCount: 0, totalTokenIn: 0, totalTokenOut: 0 });
    expect(resetCalls).toBe(1);
    await Promise.all(pending);
    expect(diagnosticWrites).toHaveLength(4);
    expect(JSON.stringify(diagnosticWrites)).not.toContain("Cookie");
  });
});
