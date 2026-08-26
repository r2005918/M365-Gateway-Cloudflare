import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateToolLedgerSnapshot } from "../src/chat-session";

describe("durable conversation state under long and concurrent workloads", () => {
  it("releases a stable session lease before the next turn", async () => {
    const session = env.CHATS.getByName(`busy-${crypto.randomUUID()}`);
    const active = await session.acquire();
    await session.release(active.leaseId);

    const retry = await session.acquire();
    expect(retry.leaseId).not.toBe(active.leaseId);
    await session.release(retry.leaseId);
  });

  it("does not retain an uncommitted account or upstream IDs after abandonment", async () => {
    const session = env.CHATS.getByName(`abandon-unseen-${crypto.randomUUID()}`);
    const active = await session.acquire();
    Object.assign(active, await session.bindAccount(active.leaseId, "unseen-account"));
    await session.abandon(active.leaseId);

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.accountId).toBe("");
    expect(retry.accountLocked).toBe(false);
    expect(retry.conversationId).not.toBe(active.conversationId);
    expect(retry.sessionId).not.toBe(active.sessionId);
    await session.release(retry.leaseId);
  });

  it("detaches a failed submitted turn from its old account and starts fresh upstream coordinates", async () => {
    const session = env.CHATS.getByName(`abandon-visible-${crypto.randomUUID()}`);
    const active = await session.acquire();
    Object.assign(active, await session.bindAccount(active.leaseId, "visible-account"));
    await session.markAccountLocked(active.leaseId, active.accountId);
    await session.abandonFailedUpstream(active.leaseId);

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.accountId).toBe("");
    expect(retry.accountLocked).toBe(false);
    expect(retry.conversationId).not.toBe(active.conversationId);
    expect(retry.sessionId).not.toBe(active.sessionId);
    await session.release(retry.leaseId);
  });

  it("preserves the previous safe tail across a pre-commit failure while allowing a successor account", async () => {
    const session = env.CHATS.getByName(`abandon-safe-tail-${crypto.randomUUID()}`);
    const first = await session.acquire();
    Object.assign(first, await session.bindAccount(first.leaseId, "account-before-failure"));
    await session.completeFinal(first, "conversation-safe", "session-safe", {
      taskAnchors: [{ kind: "windows_path", value: "C:\\safe-project" }],
      protocolTail: "previous downstream-visible turn",
    });

    const failed = await session.acquire();
    expect(failed.started).toBe(true);
    expect(failed.portableProtocolTail).toBe("previous downstream-visible turn");
    await session.abandonFailedUpstream(failed.leaseId);

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.accountId).toBe("");
    expect(retry.accountLocked).toBe(false);
    expect(retry.portableProtocolTail).toBe("previous downstream-visible turn");
    expect(retry.taskAnchors).toEqual([{ kind: "windows_path", value: "C:\\safe-project" }]);
    Object.assign(retry, await session.bindAccount(retry.leaseId, "successor-account"));
    await session.completeFinal(retry, "conversation-successor", "session-successor", {
      protocolTail: `${retry.portableProtocolTail}\nnext completed turn`,
    });

    const continued = await session.acquire();
    expect(continued.accountId).toBe("successor-account");
    expect(continued.portableProtocolTail).toContain("previous downstream-visible turn");
    expect(continued.portableProtocolTail).toContain("next completed turn");
    await session.release(continued.leaseId);
  });

  it("discards a just-committed tail when cancellation wins after final commit", async () => {
    const session = env.CHATS.getByName(`abandon-completed-race-${crypto.randomUUID()}`);
    const lease = await session.acquire();
    Object.assign(lease, await session.bindAccount(lease.leaseId, "completed-account"));
    await session.completeFinal(lease, "conversation-completed", "session-completed", {
      taskAnchors: [{ kind: "windows_path", value: "C:\\retained-anchor" }],
      protocolTail: "possibly unseen just-completed result",
    });
    await session.abandon(lease.leaseId);

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.accountId).toBe("completed-account");
    expect(retry.accountLocked).toBe(true);
    expect(retry.portableProtocolTail).toBe("");
    expect(retry.taskAnchors).toEqual([{ kind: "windows_path", value: "C:\\retained-anchor" }]);
    await session.release(retry.leaseId);
  });

  it("keeps a response alias immutable while allowing an idempotent seed retry", async () => {
    const session = env.CHATS.getByName(`bounded-alias-${crypto.randomUUID()}`);
    const snapshot = JSON.stringify([{ name: "lookup", fingerprint: `sha256:${"a".repeat(64)}`, failed: false }]);
    await session.seed("conversation-1", "session-1", "alias-account", "call-1", "lookup", '{"turn":1}', snapshot);
    await expect(session.seed("conversation-1", "session-1", "alias-account", "call-1", "lookup", '{"turn":1}', snapshot))
      .resolves.toBeUndefined();
    await runInDurableObject(session, async (instance) => {
      await expect(instance.seed("conversation-2", "session-2", "old-account-must-not-return", "call-2", "lookup", '{"turn":2}', "[]"))
        .rejects.toThrow("RESPONSE_ALIAS_IMMUTABLE");
    });

    const latest = await session.acquire();
    expect(latest.conversationId).toBe("conversation-1");
    expect(latest.sessionId).toBe("session-1");
    expect(latest.accountId).toBe("alias-account");
    expect(latest.pendingCallId).toBe("call-1");
    expect(latest.pendingToolArguments).toBe('{"turn":1}');
    const snapshots = JSON.parse(latest.toolLedgerSnapshot) as unknown[];
    expect(snapshots).toHaveLength(1);
    await session.release(latest.leaseId);
  });

  it("rejects unbounded or malformed persisted tool-ledger snapshots", () => {
    expect(() => validateToolLedgerSnapshot("x".repeat(65_537))).toThrow("TOOL_LEDGER_SNAPSHOT_TOO_LARGE");
    expect(() => validateToolLedgerSnapshot("{}")).toThrow("INVALID_TOOL_LEDGER_SNAPSHOT");
    expect(validateToolLedgerSnapshot("[]")).toBe("[]");
  });

  it("re-arms a live alias and fully evicts an expired alias payload", async () => {
    const session = env.CHATS.getByName(`alias-expiry-${crypto.randomUUID()}`);
    await session.seed("old-conversation", "old-session", "expiry-account", "call-old", "lookup", "{}", "[]");
    await expect(session.expireIfIdle(Date.now())).resolves.toBe(false);

    await expect(session.expireIfIdle(Date.now() + 31 * 24 * 60 * 60_000)).resolves.toBe(true);
    const fresh = await session.acquire();
    expect(fresh.started).toBe(false);
    expect(fresh.accountId).toBe("");
    expect(fresh.pendingCallId).toBe("");
    expect(fresh.conversationId).not.toBe("old-conversation");
    expect(fresh.sessionId).not.toBe("old-session");
    await session.release(fresh.leaseId);
  });
});
