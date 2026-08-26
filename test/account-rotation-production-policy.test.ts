import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { classifyAccountFailure } from "../src/account-routing";
import { ChatHubAttemptError, mayFailOverChatHubFailure } from "../src/chathub";
import { mayFailOverExchange } from "../src/openai";
import type { AccountSelection, OAuthTokenSet } from "../src/types";

function token(label: string): OAuthTokenSet {
  return {
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    expiresAt: Date.now() + 3_600_000,
    email: `${label}@example.test`,
    displayName: `Account ${label}`,
    oid: label,
    tid: "rotation-policy-tenant",
  };
}

function maySwitchWithinCurrentRequest(cause: unknown): boolean {
  const disposition = classifyAccountFailure(cause);
  return mayFailOverExchange(
    disposition?.mayFailOverBeforeVisibleOutput,
    false,
    false,
    false,
    !mayFailOverChatHubFailure(cause),
    Date.now() + 60_000,
  );
}

async function threeAccounts(testName: string): Promise<{
  state: DurableObjectStub<import("../src/tenant-state").TenantState>;
  first: Awaited<ReturnType<DurableObjectStub<import("../src/tenant-state").TenantState>["upsertAccount"]>>;
  second: Awaited<ReturnType<DurableObjectStub<import("../src/tenant-state").TenantState>["upsertAccount"]>>;
  third: Awaited<ReturnType<DurableObjectStub<import("../src/tenant-state").TenantState>["upsertAccount"]>>;
}> {
  const nonce = crypto.randomUUID();
  const state = env.TENANTS.getByName(`${testName}-${nonce}`);
  const first = await state.upsertAccount(token(`${nonce}-1`));
  const second = await state.upsertAccount(token(`${nonce}-2`));
  const third = await state.upsertAccount(token(`${nonce}-3`));
  return { state, first, second, third };
}

describe("production account-rotation policy", () => {
  it.each([
    {
      label: "pre-submit 429",
      cause: new ChatHubAttemptError(new Error("WS_DIAL_FAILED:429"), false),
      kind: "rate_limit",
      currentRequestFailover: true,
    },
    {
      label: "pre-submit authentication rejection",
      cause: new ChatHubAttemptError(new Error("WS_DIAL_FAILED:401"), false),
      kind: "auth",
      currentRequestFailover: true,
    },
    {
      label: "pre-submit network failure",
      cause: new ChatHubAttemptError(new Error("WS_DIAL_FAILED:503"), false),
      kind: "transient",
      currentRequestFailover: true,
    },
    {
      label: "post-submit websocket disconnect",
      cause: new ChatHubAttemptError(new Error("WS_CLOSED_BEFORE_COMPLETION:1006"), true),
      kind: "transient",
      currentRequestFailover: false,
    },
    {
      label: "tool-generation failure",
      cause: new Error("TOOL_CALL_GENERATION_FAILED"),
      kind: null,
      currentRequestFailover: false,
    },
    {
      label: "repeated tool failure",
      cause: new Error("REPEATED_TOOL_FAILURE"),
      kind: null,
      currentRequestFailover: false,
    },
    {
      label: "client cancellation",
      cause: new ChatHubAttemptError(new Error("REQUEST_ABORTED"), false),
      kind: null,
      currentRequestFailover: false,
    },
  ])("distinguishes $label from an account failure", ({ cause, kind, currentRequestFailover }) => {
    expect(classifyAccountFailure(cause)?.kind ?? null).toBe(kind);
    expect(maySwitchWithinCurrentRequest(cause)).toBe(currentRequestFailover);
  });

  it("keeps one account active, advances exactly 1 -> 2 -> 3, and never probes account 3 in the first logical request", async () => {
    const { state, first, second, third } = await threeAccounts("strict-successor");

    for (let request = 0; request < 32; request += 1) {
      await expect(state.selectAccount()).resolves.toMatchObject({ accountId: first.id, sequence: 1 });
    }
    await runInDurableObject(state, async (instance) => {
      await expect(instance.getAccountToken(second.id)).rejects.toThrow("ACCOUNT_NOT_ACTIVE");
      await expect(instance.acquireUpstream(third.id, "sleeping-third")).rejects.toThrow("ACCOUNT_NOT_ACTIVE");
    });

    const initial = await state.selectAccount() as AccountSelection;
    await state.reportAccountFailure(first.id, "rate_limit", initial.routeEpoch);
    const successor = await state.selectAccount("", [first.id]);
    expect(successor).toMatchObject({ accountId: second.id, sequence: 2 });

    // If selection scans/decrypts the third credential in this logical
    // request, this deliberately corrupt ciphertext makes the test fail.
    await runInDurableObject(state, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE accounts SET token_cipher='must-not-be-read-in-this-request' WHERE id=?",
        third.id,
      );
    });

    await state.reportAccountFailure(second.id, "transient", successor?.routeEpoch);
    await expect(state.selectAccount("", [first.id, second.id])).resolves.toBeNull();

    await runInDurableObject(state, (_instance, durableState) => {
      const active = durableState.storage.sql.exec<{ value: string }>(
        "SELECT value FROM meta WHERE key='active_account_id'",
      ).one().value;
      const gates = durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM upstream_gates WHERE account_id=?",
        third.id,
      ).one().count;
      const waiters = durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM upstream_gate_waiters WHERE account_id=?",
        third.id,
      ).one().count;
      const cipher = durableState.storage.sql.exec<{ token_cipher: string }>(
        "SELECT token_cipher FROM accounts WHERE id=?",
        third.id,
      ).one().token_cipher;
      expect(active).toBe(third.id);
      expect(gates).toBe(0);
      expect(waiters).toBe(0);
      expect(cipher).toBe("must-not-be-read-in-this-request");
    });
  });

  it("recovers an unreadable active credential through account 2 without touching account 3", async () => {
    const { state, first, second, third } = await threeAccounts("credential-successor");
    await runInDurableObject(state, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE accounts SET token_cipher='corrupt-active-ciphertext' WHERE id=?",
        first.id,
      );
    });

    // selectAccount owns credential validation. A permanent failure must
    // isolate 1 and return only its direct successor 2 in this RPC.
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: second.id, sequence: 2 });
    await runInDurableObject(state, (_instance, durableState) => {
      const retired = durableState.storage.sql.exec<{ state: string; failure_kind: string }>(
        "SELECT state,failure_kind FROM account_health WHERE account_id=?",
        first.id,
      ).one();
      const thirdGates = durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM upstream_gates WHERE account_id=?",
        third.id,
      ).one().count;
      expect(retired).toMatchObject({ state: "isolated", failure_kind: "permanent" });
      expect(thirdGates).toBe(0);
    });
  });

  it("retires a post-submit disconnected account for the next request but never replays that request on account 2", async () => {
    const { state, first, second } = await threeAccounts("post-submit-disconnect");
    const selected = await state.selectAccount() as AccountSelection;
    const cause = new ChatHubAttemptError(new Error("WS_CLOSED_BEFORE_COMPLETION:1006"), true);
    const disposition = classifyAccountFailure(cause);

    expect(disposition).toMatchObject({ kind: "transient" });
    expect(maySwitchWithinCurrentRequest(cause)).toBe(false);
    await state.reportAccountFailure(first.id, disposition!.kind, selected.routeEpoch);

    // The failed invocation is not sent twice. A later logical request starts
    // on the persisted direct successor instead.
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: second.id, sequence: 2 });
    await runInDurableObject(state, (_instance, durableState) => {
      const retired = durableState.storage.sql.exec<{ state: string; failure_kind: string }>(
        "SELECT state,failure_kind FROM account_health WHERE account_id=?",
        first.id,
      ).one();
      expect(retired).toMatchObject({ state: "cooldown", failure_kind: "transient" });
    });
  });

  it.each([
    ["rate_limit", "cooldown", true],
    ["transient", "cooldown", true],
    ["auth", "isolated", false],
    ["permanent", "isolated", false],
  ] as const)("retires an attributable %s failure once and exposes only its direct successor", async (kind, expectedState, hasCooldown) => {
    const { state, first, second, third } = await threeAccounts(`failure-${kind}`);
    const selected = await state.selectAccount() as AccountSelection;

    await Promise.all(Array.from({ length: 40 }, () => (
      state.reportAccountFailure(first.id, kind, selected.routeEpoch)
    )));

    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: second.id, sequence: 2 });
    await expect(state.selectAccount(third.id)).resolves.toBeNull();
    await runInDurableObject(state, async (instance) => {
      await expect(instance.getAccountToken(third.id)).rejects.toThrow("ACCOUNT_NOT_ACTIVE");
    });

    await runInDurableObject(state, (_instance, durableState) => {
      const retired = durableState.storage.sql.exec<{
        state: string;
        failure_kind: string;
        failure_count: number;
        cooldown_until: number;
      }>(
        "SELECT state,failure_kind,failure_count,cooldown_until FROM account_health WHERE account_id=?",
        first.id,
      ).one();
      const active = durableState.storage.sql.exec<{ value: string }>(
        "SELECT value FROM meta WHERE key='active_account_id'",
      ).one().value;
      expect(retired.state).toBe(expectedState);
      expect(retired.failure_kind).toBe(kind);
      expect(retired.failure_count).toBe(1);
      expect(retired.cooldown_until > Date.now()).toBe(hasCooldown);
      expect(active).toBe(second.id);
    });
  });

  it.each([
    "TOOL_CALL_GENERATION_FAILED",
    "REPEATED_TOOL_FAILURE",
    "INVALID_TOOL_HISTORY",
    "REQUEST_ABORTED",
    "ACCOUNT_QUEUE_TIMEOUT",
  ])("does not punish or rotate the account for non-account failure %s", async (message) => {
    const { state, first, second } = await threeAccounts(`non-account-${message.toLowerCase()}`);
    const selected = await state.selectAccount() as AccountSelection;
    const disposition = classifyAccountFailure(new Error(message));
    expect(disposition).toBeNull();

    // Production calls reportAccountFailure only for a classified disposition.
    // Keeping that decision explicit here prevents a future "rotate on every
    // catch" regression from turning malformed tools or client disconnects
    // into account churn.
    if (disposition) await state.reportAccountFailure(first.id, disposition.kind, selected.routeEpoch);

    for (let request = 0; request < 8; request += 1) {
      await expect(state.selectAccount()).resolves.toMatchObject({ accountId: first.id, sequence: 1 });
    }
    await expect(state.selectAccount(second.id)).resolves.toBeNull();
    await runInDurableObject(state, (_instance, durableState) => {
      const health = durableState.storage.sql.exec<{ state: string; failure_count: number }>(
        "SELECT state,failure_count FROM account_health WHERE account_id=?",
        first.id,
      ).one();
      expect(health).toMatchObject({ state: "healthy", failure_count: 0 });
    });
  });

  it("never fails over after output, account lock, prior committed context, upstream submission, or deadline", () => {
    const future = Date.now() + 60_000;
    expect(mayFailOverExchange(true, false, false, false, false, future)).toBe(true);
    expect(mayFailOverExchange(true, true, false, false, false, future)).toBe(false);
    expect(mayFailOverExchange(true, false, true, false, false, future)).toBe(false);
    expect(mayFailOverExchange(true, false, false, true, false, future)).toBe(false);
    expect(mayFailOverExchange(true, false, false, false, true, future)).toBe(false);
    expect(mayFailOverExchange(true, false, false, false, false, Date.now() - 1)).toBe(false);
  });
});
