import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ACTIVE_TOKEN_REFRESH_ADVANCE_MS } from "../src/tenant-state";
import type { OAuthTokenSet } from "../src/types";

function token(id: string, expiresAt = Date.now() + 3_600_000): OAuthTokenSet {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt,
    email: `${id}@example.test`,
    displayName: `Account ${id}`,
    oid: id,
    tid: "single-active-routing-tenant",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function unsignedJWT(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `e30.${payload}.signature`;
}

describe("persistent global single-active account routing", () => {
  it("serves twenty normal selections from sequence 1 without round-robin rotation", async () => {
    const state = env.TENANTS.getByName(`single-active-stable-${crypto.randomUUID()}`);
    const first = await state.upsertAccount(token(`stable-a-${crypto.randomUUID()}`));
    const second = await state.upsertAccount(token(`stable-b-${crypto.randomUUID()}`));
    const third = await state.upsertAccount(token(`stable-c-${crypto.randomUUID()}`));

    for (let request = 0; request < 20; request += 1) {
      await expect(state.selectAccount()).resolves.toMatchObject({ accountId: first.id, sequence: 1 });
    }
    await expect(state.selectAccount(second.id)).resolves.toBeNull();
    await expect(state.selectAccount(third.id)).resolves.toBeNull();

    const accounts = await state.listAccounts();
    expect(accounts.map(({ id, active, isolated }) => ({ id, active, isolated }))).toEqual([
      { id: first.id, active: true, isolated: false },
      { id: second.id, active: false, isolated: true },
      { id: third.id, active: false, isolated: true },
    ]);
  });

  it("CAS-advances once under one hundred concurrent failures and ignores stale results", async () => {
    const state = env.TENANTS.getByName(`single-active-cas-${crypto.randomUUID()}`);
    const first = await state.upsertAccount(token(`cas-a-${crypto.randomUUID()}`));
    const second = await state.upsertAccount(token(`cas-b-${crypto.randomUUID()}`));
    const third = await state.upsertAccount(token(`cas-c-${crypto.randomUUID()}`));
    const selected = await state.selectAccount();
    expect(selected).toMatchObject({ accountId: first.id, sequence: 1 });

    await Promise.all(Array.from({ length: 100 }, () => (
      state.reportAccountFailure(first.id, "transient", selected?.routeEpoch)
    )));
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: second.id, sequence: 2 });

    // Both an unversioned late report and a versioned report from the retired
    // generation are harmless once a different account owns the route.
    await state.reportAccountFailure(first.id, "auth");
    await state.reportAccountFailure(first.id, "permanent", selected?.routeEpoch);
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: second.id, sequence: 2 });
    const accounts = await state.listAccounts();
    expect(accounts.find((account) => account.id === third.id)).toMatchObject({ active: false, isolated: true });

    await runInDurableObject(state, (_instance, durableState) => {
      const active = durableState.storage.sql.exec<{ value: string }>(
        "SELECT value FROM meta WHERE key='active_account_id'",
      ).one().value;
      const epoch = Number(durableState.storage.sql.exec<{ value: string }>(
        "SELECT value FROM meta WHERE key='active_account_epoch'",
      ).one().value);
      const retiredHealth = durableState.storage.sql.exec<{ failure_count: number; failure_kind: string }>(
        "SELECT failure_count,failure_kind FROM account_health WHERE account_id=?",
        first.id,
      ).one();
      expect(active).toBe(second.id);
      expect(epoch).toBe((selected?.routeEpoch ?? 0) + 1);
      expect(retiredHealth).toMatchObject({ failure_count: 1, failure_kind: "transient" });
    });
  });

  it("limits one logical request to current plus next even when next also fails", async () => {
    const state = env.TENANTS.getByName(`single-active-two-attempts-${crypto.randomUUID()}`);
    const first = await state.upsertAccount(token(`attempt-a-${crypto.randomUUID()}`));
    const second = await state.upsertAccount(token(`attempt-b-${crypto.randomUUID()}`));
    const third = await state.upsertAccount(token(`attempt-c-${crypto.randomUUID()}`));

    await state.reportAccountFailure(first.id, "rate_limit");
    await expect(state.selectAccount("", [first.id])).resolves.toMatchObject({ accountId: second.id });
    await state.reportAccountFailure(second.id, "transient");
    await expect(state.selectAccount("", [first.id, second.id])).resolves.toBeNull();
    // C is reserved for the next logical request, not exposed as a third try.
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: third.id, sequence: 3 });
  });

  it("keeps deletion ordering and routing state in persisted Durable Object storage", async () => {
    const state = env.TENANTS.getByName(`single-active-delete-${crypto.randomUUID()}`);
    const first = await state.upsertAccount(token(`delete-a-${crypto.randomUUID()}`));
    const second = await state.upsertAccount(token(`delete-b-${crypto.randomUUID()}`));
    const third = await state.upsertAccount(token(`delete-c-${crypto.randomUUID()}`));

    expect(await state.deleteAccount(third.id)).toBe(true);
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: first.id });
    expect(await state.deleteAccount(first.id)).toBe(true);
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: second.id, sequence: 2 });

    // A separate RPC turn reads the same persisted route; no in-memory cursor
    // is involved, matching a Durable Object eviction/reactivation.
    await runInDurableObject(state, (_instance, durableState) => {
      expect(durableState.storage.sql.exec<{ value: string }>(
        "SELECT value FROM meta WHERE key='active_account_id'",
      ).one().value).toBe(second.id);
    });
    for (let request = 0; request < 5; request += 1) {
      await expect(state.selectAccount()).resolves.toMatchObject({ accountId: second.id });
    }
  });

  it("never decrypts, refreshes, or creates an upstream gate for a sleeping account", async () => {
    const state = env.TENANTS.getByName(`single-active-sleep-${crypto.randomUUID()}`);
    const first = await state.upsertAccount(token(`awake-${crypto.randomUUID()}`));
    const sleeping = await state.upsertAccount(token(`sleeping-${crypto.randomUUID()}`, Date.now() - 1_000));
    await runInDurableObject(state, (_instance, durableState) => {
      durableState.storage.sql.exec("UPDATE accounts SET token_cipher='must-never-be-decrypted' WHERE id=?", sleeping.id);
    });
    const fetchMock = vi.fn(async () => Response.json({}, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(state.selectAccount()).resolves.toMatchObject({ accountId: first.id });
      await runInDurableObject(state, async (instance, durableState) => {
        await expect(instance.getAccountToken(sleeping.id)).rejects.toThrow("ACCOUNT_NOT_ACTIVE");
        await expect(instance.ensureValidAccount(sleeping.id)).rejects.toThrow("ACCOUNT_NOT_ACTIVE");
        await expect(instance.acquireUpstream(sleeping.id, "sleeping-waiter")).rejects.toThrow("ACCOUNT_NOT_ACTIVE");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(durableState.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM upstream_gates WHERE account_id=?",
          sleeping.id,
        ).one().count).toBe(0);
        expect(durableState.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM upstream_gate_waiters WHERE account_id=?",
          sleeping.id,
        ).one().count).toBe(0);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("manual refresh accepts only the active account and shares the normal singleflight", async () => {
    const state = env.TENANTS.getByName(`single-active-refresh-${crypto.randomUUID()}`);
    const firstToken = token(`refresh-a-${crypto.randomUUID()}`, Date.now() - 1_000);
    const first = await state.upsertAccount(firstToken);
    const sleeping = await state.upsertAccount(token(`refresh-b-${crypto.randomUUID()}`, Date.now() - 1_000));
    const entered = deferred();
    const release = deferred();
    const refreshedAccessToken = unsignedJWT({
      oid: firstToken.oid,
      tid: firstToken.tid,
      preferred_username: firstToken.email,
      name: firstToken.displayName,
    });
    const fetchMock = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ access_token: refreshedAccessToken, refresh_token: `new-${firstToken.refreshToken}`, expires_in: 3_600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runInDurableObject(state, async (instance) => {
        const left = instance.refreshActiveAccount(first.id);
        const right = instance.refreshActiveAccount(first.id);
        await entered.promise;
        await expect(instance.refreshActiveAccount(sleeping.id)).rejects.toThrow("ACCOUNT_NOT_ACTIVE");
        release.resolve();
        const refreshed = await Promise.all([left, right]);
        expect(refreshed.every((account) => account?.id === first.id && account.active)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the Durable Object alarm to refresh only the active account before expiry", async () => {
    const state = env.TENANTS.getByName(`single-active-proactive-refresh-${crypto.randomUUID()}`);
    const firstToken = token(
      `proactive-a-${crypto.randomUUID()}`,
      Date.now() + ACTIVE_TOKEN_REFRESH_ADVANCE_MS - 60_000,
    );
    const sleepingToken = token(`proactive-b-${crypto.randomUUID()}`, Date.now() - 60_000);
    const first = await state.upsertAccount(firstToken);
    const sleeping = await state.upsertAccount(sleepingToken);
    const refreshedAccessToken = unsignedJWT({
      oid: firstToken.oid,
      tid: firstToken.tid,
      preferred_username: firstToken.email,
      name: firstToken.displayName,
    });
    const fetchMock = vi.fn(async () => Response.json({
      access_token: refreshedAccessToken,
      refresh_token: `rotated-${firstToken.refreshToken}`,
      expires_in: 3_600,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runInDurableObject(state, async (instance, durableState) => {
        const scheduledBefore = await durableState.storage.getAlarm();
        expect(scheduledBefore).not.toBeNull();
        expect(scheduledBefore as number).toBeLessThanOrEqual(Date.now() + 2_000);

        await instance.alarm();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expect(instance.getAccountToken(first.id)).resolves.toMatchObject({
          accessToken: refreshedAccessToken,
          refreshToken: `rotated-${firstToken.refreshToken}`,
        });
        const sleepingExpiry = durableState.storage.sql.exec<{ expires_at: number }>(
          "SELECT expires_at FROM accounts WHERE id=?",
          sleeping.id,
        ).one().expires_at;
        expect(sleepingExpiry).toBe(sleepingToken.expiresAt);
        const accounts = await instance.listAccounts();
        expect(accounts.find((account) => account.id === first.id)).toMatchObject({
          active: true,
          status: "online",
          tokenState: "valid",
        });
        expect(accounts.find((account) => account.id === sleeping.id)).toMatchObject({
          active: false,
          tokenState: "standby",
          refreshScheduledAt: null,
        });
        const scheduledAfter = await durableState.storage.getAlarm();
        expect(scheduledAfter).not.toBeNull();
        expect(scheduledAfter as number).toBeGreaterThan(Date.now() + 50 * 60_000);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists a bounded retry after proactive refresh failure without hammering Microsoft", async () => {
    const state = env.TENANTS.getByName(`single-active-refresh-retry-${crypto.randomUUID()}`);
    const expiring = token(`retry-a-${crypto.randomUUID()}`, Date.now() - 1_000);
    await state.upsertAccount(expiring);
    const fetchMock = vi.fn(async () => Response.json(
      { error: "temporarily_unavailable", error_description: "sanitized test failure" },
      { status: 503 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runInDurableObject(state, async (instance, durableState) => {
        await expect(instance.alarm()).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const account = (await instance.listAccounts())[0];
        expect(account).toMatchObject({ active: true, status: "expired", tokenState: "retry_scheduled" });
        expect(Date.parse(account.refreshScheduledAt ?? "")).toBeGreaterThan(Date.now());
        const scheduled = await durableState.storage.getAlarm();
        expect(scheduled).not.toBeNull();
        expect(scheduled as number).toBeGreaterThan(Date.now());

        await expect(instance.alarm()).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
