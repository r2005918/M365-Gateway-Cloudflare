import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../src/chat-session";
import { createStreamCancellation } from "../src/openai";

describe("stream cancellation lifecycle", () => {
  it("releases both the conversation lease and the active per-account gate", async () => {
    const state = env.TENANTS.getByName("default");
    const accountId = `cancel-active-${crypto.randomUUID()}`;
    const upstream = await state.acquireUpstream(accountId);
    expect(upstream.ok).toBe(true);

    const session = env.CHATS.getByName(`cancel-session-${crypto.randomUUID()}`);
    const abandoned = await session.acquire();
    const cancellation = createStreamCancellation(state, session, abandoned);
    expect(cancellation.gates.begin()).toBe(true);
    expect(cancellation.gates.attach({ accountId, leaseId: upstream.leaseId })).toBe(true);

    const cleanup = cancellation.abortAndRelease();
    expect(cancellation.abortAndRelease()).toBe(cleanup);
    expect(cancellation.signal.aborted).toBe(true);

    // This marks the point at which the aborted exchange's finally block has
    // unwound. cancel() must not resolve before that acquisition race settles.
    cancellation.gates.end();
    await cleanup;

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.conversationId).not.toBe(abandoned.conversationId);
    expect(retry.sessionId).not.toBe(abandoned.sessionId);
    await session.release(retry.leaseId);

    // releaseUpstream intentionally applies a one-second safety interval. If
    // cancellation left the old 11-minute lease behind this acquire still
    // fails after that interval.
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const reacquired = await state.acquireUpstream(accountId);
    expect(reacquired.ok).toBe(true);
    await state.releaseUpstream(accountId, reacquired.leaseId);
  });

  it("fences a gate acquisition that returns after cancellation has started", async () => {
    let releaseSession!: () => void;
    let releaseGate!: () => void;
    const sessionRelease = new Promise<void>((resolve) => { releaseSession = resolve; });
    const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
    const state = { releaseUpstream: vi.fn(() => gateRelease) };
    const session = {
      abandon: vi.fn(() => sessionRelease),
    } as unknown as DurableObjectStub<ChatSession>;
    const lease = {
      leaseId: "conversation-lease",
      conversationId: "conversation-id",
      sessionId: "session-id",
      accountId: "",
      accountLocked: false,
      started: false,
      pendingCallId: "",
      pendingToolName: "",
      pendingToolArguments: "",
    };
    const cancellation = createStreamCancellation(state, session, lease);
    expect(cancellation.gates.begin()).toBe(true);

    let settled = false;
    const cleanup = cancellation.abortAndRelease().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Simulate acquireUpstream() returning one microtask after cancel(). The
    // lifecycle rejects attachment, but the exchange can still idempotently
    // release the just-created lease before declaring itself unwound.
    const lateGate = { accountId: "late-account", leaseId: "late-gate" };
    expect(cancellation.gates.attach(lateGate)).toBe(false);
    const release = cancellation.gates.release(lateGate);
    cancellation.gates.end();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(state.releaseUpstream).toHaveBeenCalledOnce();
    expect(state.releaseUpstream).toHaveBeenCalledWith("late-account", "late-gate");

    releaseSession();
    releaseGate();
    await release;
    await cleanup;
    expect(settled).toBe(true);
    expect(session.abandon).toHaveBeenCalledOnce();
  });

  it("does not release an active account gate until the aborted exchange has unwound", async () => {
    const state = { releaseUpstream: vi.fn(async () => undefined) };
    const lifecycle = createStreamCancellation(
      state,
      { abandon: vi.fn(async () => undefined) } as unknown as DurableObjectStub<ChatSession>,
      {
        leaseId: "conversation-gate-order",
        conversationId: "conversation-id",
        sessionId: "session-id",
        accountId: "account-a",
        accountLocked: false,
        started: false,
        pendingCallId: "",
        pendingToolName: "",
        pendingToolArguments: "",
        toolLedgerSnapshot: "[]",
      },
    );
    expect(lifecycle.gates.begin()).toBe(true);
    expect(lifecycle.gates.attach({ accountId: "account-a", leaseId: "gate-a" })).toBe(true);

    let settled = false;
    const cleanup = lifecycle.abortAndRelease().then(() => { settled = true; });
    await Promise.resolve();
    expect(state.releaseUpstream).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    lifecycle.gates.end();
    await cleanup;
    expect(state.releaseUpstream).toHaveBeenCalledOnce();
    expect(state.releaseUpstream).toHaveBeenCalledWith("account-a", "gate-a");
  });

  it("tombstones a completion that races downstream cancellation", async () => {
    const state = env.TENANTS.getByName("default");
    const session = env.CHATS.getByName(`cancel-after-complete-${crypto.randomUUID()}`);
    const lease = await session.acquire();
    Object.assign(lease, await session.bindAccount(lease.leaseId, "sticky-cancel-account"));
    const cancellation = createStreamCancellation(state, session, lease);

    // Reproduce the production race: ChatHub completed and persisted the
    // upstream conversation, but the client disconnected before the terminal
    // event was delivered.
    await session.complete(lease, lease.conversationId, lease.sessionId);
    await cancellation.abortAndRelease();

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.conversationId).not.toBe(lease.conversationId);
    expect(retry.sessionId).not.toBe(lease.sessionId);
    // complete() marked the turn semantically visible, so cancellation must
    // not expose a second account to the same user request on retry.
    expect(retry.accountId).toBe("sticky-cancel-account");
    expect(retry.accountLocked).toBe(true);
    await session.release(retry.leaseId);
  });
});
