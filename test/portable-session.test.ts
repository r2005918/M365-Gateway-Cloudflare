import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  boundPortableSessionState,
  MAX_PORTABLE_SESSION_BYTES,
  portableSessionByteLength,
} from "../src/chat-session";
import type { TaskAnchor } from "../src/task-anchors";

const anchors: TaskAnchor[] = [
  { kind: "windows_path", value: "C:\\workspace\\gateway" },
  { kind: "server", value: "6号服务器" },
];

describe("portable session state across active-account epochs", () => {
  it("persists bounded task anchors and protocol history through seed and complete", async () => {
    const session = env.CHATS.getByName(`portable-persist-${crypto.randomUUID()}`);
    await session.seed(
      "seed-conversation",
      "seed-session",
      "account-1",
      "",
      "",
      "",
      "[]",
      anchors,
      "old protocol tail 中文😀",
    );

    const seeded = await session.acquire();
    expect(seeded.taskAnchors).toEqual(anchors);
    expect(seeded.portableProtocolTail).toBe("old protocol tail 中文😀");
    await session.complete(seeded, "completed-conversation", "completed-session", {
      taskAnchors: [{ kind: "unix_path", value: "/opt/m365/current" }],
      protocolTail: "newest user / call / result tail 工具😀",
    });
    await session.replaceCompletedPortableProtocolTail(
      seeded.leaseId,
      "account-1",
      "completed-conversation",
      "completed-session",
      "newest user / call / result tail 工具😀",
    );

    const completed = await session.acquire();
    expect(completed.started).toBe(true);
    expect(completed.taskAnchors).toEqual([
      ...anchors,
      { kind: "unix_path", value: "/opt/m365/current" },
    ]);
    expect(completed.portableProtocolTail).toBe("newest user / call / result tail 工具😀");
    await session.release(completed.leaseId);
  });

  it("atomically rebinds committed state while preserving pending and portable evidence", async () => {
    const session = env.CHATS.getByName(`portable-rebind-${crypto.randomUUID()}`);
    const snapshot = JSON.stringify([{ fingerprint: "sha256:abc", failed: false, count: 1 }]);
    await session.seed(
      "old-conversation",
      "old-session",
      "account-epoch-1",
      "call_pending",
      "write_file",
      '{"path":"C:\\\\workspace\\\\gateway\\\\a.txt"}',
      snapshot,
      anchors,
      "[USER] continue the same task\n[TOOL] pending",
    );
    const oldLease = await session.acquire();

    const rebound = await session.rebindCommittedAccount(
      oldLease.leaseId,
      "account-epoch-1",
      "account-epoch-2",
    );

    expect(rebound.accountId).toBe("account-epoch-2");
    expect(rebound.accountLocked).toBe(false);
    expect(rebound.started).toBe(false);
    expect(rebound.conversationId).not.toBe("old-conversation");
    expect(rebound.sessionId).not.toBe("old-session");
    expect(rebound.pendingCallId).toBe("call_pending");
    expect(rebound.pendingToolName).toBe("write_file");
    expect(rebound.pendingToolArguments).toContain("a.txt");
    expect(rebound.toolLedgerSnapshot).toBe(snapshot);
    expect(rebound.taskAnchors).toEqual(anchors);
    expect(rebound.portableProtocolTail).toContain("pending");

    // A stale lease from the previous route epoch cannot put its upstream
    // coordinates or account binding back after the conditional rebind.
    await runInDurableObject(session, async (instance) => {
      await expect(instance.complete(oldLease, "revived-conversation", "revived-session"))
        .rejects.toThrow("SESSION_ACCOUNT_MISMATCH");
      await expect(instance.bindAccount(oldLease.leaseId, "account-epoch-1"))
        .rejects.toThrow("SESSION_ACCOUNT_MISMATCH");
      await expect(instance.rebindCommittedAccount(oldLease.leaseId, "account-epoch-1", "account-epoch-3"))
        .rejects.toThrow("SESSION_ACCOUNT_REBIND_MISMATCH");
    });

    await session.complete(rebound, rebound.conversationId, rebound.sessionId);
    const continued = await session.acquire();
    expect(continued.accountId).toBe("account-epoch-2");
    expect(continued.conversationId).toBe(rebound.conversationId);
    expect(continued.sessionId).toBe(rebound.sessionId);
    expect(continued.pendingCallId).toBe("");
    expect(continued.toolLedgerSnapshot).toBe(snapshot);
    expect(continued.portableProtocolTail).toBe(rebound.portableProtocolTail);
    await session.release(continued.leaseId);
  });

  it("keeps the newest UTF-8 protocol suffix within the aggregate 64 KiB cap", async () => {
    const oldest = "oldest-prefix-that-must-drop|";
    const newest = `|newest-tail-${"工具😀".repeat(20)}`;
    const oversized = `${oldest}${"中😀a".repeat(40_000)}${newest}`;
    const bounded = boundPortableSessionState(anchors, oversized);

    expect(portableSessionByteLength(bounded)).toBeLessThanOrEqual(MAX_PORTABLE_SESSION_BYTES);
    expect(bounded.protocolTail).not.toContain("oldest-prefix-that-must-drop");
    expect(bounded.protocolTail.endsWith(newest)).toBe(true);
    expect(bounded.protocolTail).not.toContain("�");
    expect(new TextEncoder().encode(bounded.protocolTail).byteLength).toBeGreaterThan(0);

    const session = env.CHATS.getByName(`portable-cap-${crypto.randomUUID()}`);
    await session.seed("conversation", "session", "account", "", "", "", "[]", anchors, oversized);
    const lease = await session.acquire();
    expect(portableSessionByteLength({
      taskAnchors: lease.taskAnchors,
      protocolTail: lease.portableProtocolTail,
    })).toBeLessThanOrEqual(MAX_PORTABLE_SESSION_BYTES);
    expect(lease.portableProtocolTail.endsWith(newest)).toBe(true);
    expect(lease.portableProtocolTail).not.toContain("�");
    await session.release(lease.leaseId);
  });

  it("preserves the prior safe protocol tail on active abandon and retains task anchors", async () => {
    const session = env.CHATS.getByName(`portable-abandon-${crypto.randomUUID()}`);
    await session.seed(
      "conversation",
      "session",
      "account",
      "call-unseen",
      "mutate",
      "{}",
      JSON.stringify([{ fingerprint: "sha256:unseen", failed: false }]),
      anchors,
      "previous response already delivered to downstream",
    );
    const lease = await session.acquire();
    await session.abandon(lease.leaseId);

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.pendingCallId).toBe("");
    expect(retry.toolLedgerSnapshot).toBe("[]");
    expect(retry.portableProtocolTail).toBe("previous response already delivered to downstream");
    expect(retry.taskAnchors).toEqual(anchors);
    await session.release(retry.leaseId);
  });

  it("evicts every portable field when the response alias expires", async () => {
    const session = env.CHATS.getByName(`portable-expiry-${crypto.randomUUID()}`);
    await session.seed(
      "expired-conversation",
      "expired-session",
      "expired-account",
      "call-expired",
      "lookup",
      "{}",
      "[]",
      anchors,
      "expired protocol tail 中文😀",
    );

    await expect(session.expireIfIdle(Date.now() + 31 * 24 * 60 * 60_000)).resolves.toBe(true);
    const fresh = await session.acquire();
    expect(fresh.started).toBe(false);
    expect(fresh.accountId).toBe("");
    expect(fresh.taskAnchors).toEqual([]);
    expect(fresh.portableProtocolTail).toBe("");
    expect(fresh.pendingCallId).toBe("");
    expect(fresh.toolLedgerSnapshot).toBe("[]");
    expect(fresh.conversationId).not.toBe("expired-conversation");
    expect(fresh.sessionId).not.toBe("expired-session");
    await session.release(fresh.leaseId);
  });

  it("CAS-replaces a provisional completed tail with the exact guarded downstream tail", async () => {
    const session = env.CHATS.getByName(`portable-completed-cas-${crypto.randomUUID()}`);
    const lease = await session.acquire();
    Object.assign(lease, await session.bindAccount(lease.leaseId, "account-visible"));
    await session.complete(lease, "conversation-visible", "session-visible", {
      protocolTail: "provisional text that was not yet tool-guarded",
    });
    await runInDurableObject(session, (_instance, state) => {
      const stored = state.storage.sql.exec<{ portable_protocol_tail: string }>(
        "SELECT portable_protocol_tail FROM state WHERE singleton=1",
      ).toArray()[0];
      expect(stored.portable_protocol_tail).not.toContain("not yet tool-guarded");
    });

    await session.replaceCompletedPortableProtocolTail(
      lease.leaseId,
      "account-visible",
      "conversation-visible",
      "session-visible",
      "actual downstream output 工具😀",
    );

    const continued = await session.acquire();
    expect(continued.portableProtocolTail).toBe("actual downstream output 工具😀");
    await session.release(continued.leaseId);
  });

  it("atomically keeps the lease busy until completeFinal publishes the guarded tail", async () => {
    const session = env.CHATS.getByName(`portable-final-atomic-${crypto.randomUUID()}`);
    const lease = await session.acquire();
    Object.assign(lease, await session.bindAccount(lease.leaseId, "atomic-account"));

    await runInDurableObject(session, async (instance) => {
      await expect(instance.acquire()).rejects.toThrow("CONVERSATION_BUSY");
    });

    await session.completeFinal(lease, "atomic-conversation", "atomic-session", {
      taskAnchors: anchors,
      protocolTail: "guarded final output 工具😀",
    });

    const next = await session.acquire();
    expect(next.started).toBe(true);
    expect(next.conversationId).toBe("atomic-conversation");
    expect(next.sessionId).toBe("atomic-session");
    expect(next.taskAnchors).toEqual(anchors);
    expect(next.portableProtocolTail).toBe("guarded final output 工具😀");
    await session.release(next.leaseId);
  });

  it("rejects late completed-tail writers from an expired lease, old account, or old round", async () => {
    const session = env.CHATS.getByName(`portable-completed-stale-${crypto.randomUUID()}`);
    const first = await session.acquire();
    Object.assign(first, await session.bindAccount(first.leaseId, "account-1"));
    await session.complete(first, "conversation-1", "session-1", { protocolTail: "round one" });

    await runInDurableObject(session, async (instance) => {
      await expect(instance.replaceCompletedPortableProtocolTail(
        first.leaseId,
        "old-account",
        "conversation-1",
        "session-1",
        "must not overwrite by old account",
      )).rejects.toThrow("STALE_COMPLETED_CONVERSATION");
    });

    const second = await session.acquire();
    await runInDurableObject(session, async (instance) => {
      await expect(instance.replaceCompletedPortableProtocolTail(
        first.leaseId,
        "account-1",
        "conversation-1",
        "session-1",
        "expired lease overwrite",
      )).rejects.toThrow("STALE_COMPLETED_CONVERSATION");
    });
    await session.complete(second, "conversation-2", "session-2", { protocolTail: "round two authoritative" });
    await session.replaceCompletedPortableProtocolTail(
      second.leaseId,
      "account-1",
      "conversation-2",
      "session-2",
      "round two authoritative",
    );

    await runInDurableObject(session, async (instance) => {
      await expect(instance.replaceCompletedPortableProtocolTail(
        first.leaseId,
        "account-1",
        "conversation-1",
        "session-1",
        "late round one overwrite",
      )).rejects.toThrow("STALE_COMPLETED_CONVERSATION");
      await expect(instance.replaceCompletedPortableProtocolTail(
        second.leaseId,
        "account-1",
        "conversation-1",
        "session-1",
        "wrong upstream coordinates",
      )).rejects.toThrow("STALE_COMPLETED_CONVERSATION");
    });

    const final = await session.acquire();
    expect(final.portableProtocolTail).toBe("round two authoritative");
    await session.release(final.leaseId);
  });
});
