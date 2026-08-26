import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const pace = () => new Promise((resolve) => setTimeout(resolve, 1_050));

describe("per-account upstream FIFO", () => {
  it("grants queued requests in insertion order even when later waiters poll first", async () => {
    const state = env.TENANTS.getByName(`fifo-${crypto.randomUUID()}`);
    const accountId = `account-${crypto.randomUUID()}`;
    const first = await state.acquireUpstream(accountId, "waiter-1");
    expect(first.ok).toBe(true);
    await expect(state.acquireUpstream(accountId, "waiter-2")).resolves.toMatchObject({ ok: false });
    await expect(state.acquireUpstream(accountId, "waiter-3")).resolves.toMatchObject({ ok: false });

    // A stale or forged releaser cannot unlock somebody else's lease.
    await state.releaseUpstream(accountId, "wrong-lease");
    await expect(state.acquireUpstream(accountId, "waiter-2")).resolves.toMatchObject({ ok: false });

    await state.releaseUpstream(accountId, first.leaseId);
    await pace();
    await expect(state.acquireUpstream(accountId, "waiter-3")).resolves.toMatchObject({ ok: false });
    const second = await state.acquireUpstream(accountId, "waiter-2");
    expect(second.ok).toBe(true);

    await state.releaseUpstream(accountId, second.leaseId);
    await pace();
    const third = await state.acquireUpstream(accountId, "waiter-3");
    expect(third.ok).toBe(true);
    await state.releaseUpstream(accountId, third.leaseId);
  });

  it("removes a cancelled head waiter so the next request can advance", async () => {
    const state = env.TENANTS.getByName(`fifo-cancel-${crypto.randomUUID()}`);
    const accountId = `account-${crypto.randomUUID()}`;
    const active = await state.acquireUpstream(accountId, "active");
    expect(active.ok).toBe(true);
    await state.acquireUpstream(accountId, "cancelled-head");
    await state.acquireUpstream(accountId, "next-live");

    await state.cancelUpstreamWaiter(accountId, "cancelled-head");
    await state.releaseUpstream(accountId, active.leaseId);
    await pace();
    const next = await state.acquireUpstream(accountId, "next-live");
    expect(next.ok).toBe(true);
    await state.releaseUpstream(accountId, next.leaseId);
  });

  it("prunes queue entries left by a crashed or restarted requester", async () => {
    const state = env.TENANTS.getByName(`fifo-expiry-${crypto.randomUUID()}`);
    const accountId = `account-${crypto.randomUUID()}`;
    const active = await state.acquireUpstream(accountId, "active");
    expect(active.ok).toBe(true);
    await state.acquireUpstream(accountId, "orphaned");

    await expect(state.expireUpstreamWaiters(Date.now() + 151_000)).resolves.toBe(1);
    await expect(state.expireUpstreamWaiters(Date.now() + 151_000)).resolves.toBe(0);
    await state.releaseUpstream(accountId, active.leaseId);
  });

  it("keeps different accounts independent", async () => {
    const state = env.TENANTS.getByName(`fifo-independent-${crypto.randomUUID()}`);
    const left = await state.acquireUpstream("account-left", "left");
    const right = await state.acquireUpstream("account-right", "right");
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    await state.releaseUpstream("account-left", left.leaseId);
    await state.releaseUpstream("account-right", right.leaseId);
  });
});
