import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_SESSION_STATE_BYTES,
  MAX_RESPONSE_ALIASES_PER_UPSTREAM,
  MAX_RESPONSE_ALIASES_TOTAL,
  RESPONSE_ALIAS_REGISTRY_NAME,
  RESPONSE_ALIAS_TTL_MS,
} from "../src/chat-session";

describe("bounded Responses alias retention", () => {
  it("retains only the newest 64 aliases for one upstream conversation without evicting a stable session", async () => {
    const stable = env.CHATS.getByName(`stable-never-alias-evicted-${crypto.randomUUID()}`);
    const stableLease = await stable.acquire();
    Object.assign(stableLease, await stable.bindAccount(stableLease.leaseId, "stable-account"));
    await stable.complete(stableLease, "stable-conversation", "stable-session", {
      protocolTail: "stable thread must survive alias pressure",
    });
    await stable.replaceCompletedPortableProtocolTail(
      stableLease.leaseId,
      "stable-account",
      "stable-conversation",
      "stable-session",
      "stable thread must survive alias pressure",
    );

    const names: string[] = [];
    for (let index = 0; index < MAX_RESPONSE_ALIASES_PER_UPSTREAM + 6; index += 1) {
      const name = `bounded-response-${crypto.randomUUID()}`;
      names.push(name);
      await env.CHATS.getByName(name).seed(
        "shared-upstream-conversation",
        `upstream-session-${index}`,
        "shared-account",
        "",
        "",
        "",
        "[]",
        [],
        `turn-${index}`,
      );
    }

    const registry = env.CHATS.getByName(RESPONSE_ALIAS_REGISTRY_NAME);
    const stats = await registry.responseAliasRegistryStats();
    expect(await registry.responseAliasGroupCount("shared-account", "shared-upstream-conversation"))
      .toBe(MAX_RESPONSE_ALIASES_PER_UPSTREAM);
    expect(stats.maximumAliasesPerUpstream).toBe(64);

    const evicted = await env.CHATS.getByName(names[0]).acquire();
    expect(evicted.started).toBe(false);
    expect(evicted.accountId).toBe("");
    await env.CHATS.getByName(names[0]).release(evicted.leaseId);

    const retained = await env.CHATS.getByName(names.at(-1)!).acquire();
    expect(retained.started).toBe(true);
    expect(retained.accountId).toBe("shared-account");
    expect(retained.portableProtocolTail).toBe(`turn-${MAX_RESPONSE_ALIASES_PER_UPSTREAM + 5}`);
    await env.CHATS.getByName(names.at(-1)!).release(retained.leaseId);

    expect(await stable.evictResponseAlias("not-an-alias-generation")).toBe("generation_mismatch");
    const stableAgain = await stable.acquire();
    expect(stableAgain.started).toBe(true);
    expect(stableAgain.conversationId).toBe("stable-conversation");
    expect(stableAgain.portableProtocolTail).toBe("stable thread must survive alias pressure");
    await stable.release(stableAgain.leaseId);
  }, 30_000);

  it("serializes concurrent alias admission and never exceeds the per-upstream cap", async () => {
    const registry = env.CHATS.getByName(RESPONSE_ALIAS_REGISTRY_NAME);
    const aliases = Array.from({ length: 96 }, () => env.CHATS.getByName(`concurrent-alias-${crypto.randomUUID()}`));
    await Promise.all(aliases.map((alias, index) => alias.seed(
      "concurrent-upstream-conversation",
      `session-${index}`,
      "concurrent-account",
      "",
      "",
      "",
      "[]",
      [],
      `portable-${index}`,
    )));

    const stats = await registry.responseAliasRegistryStats();
    expect(await registry.responseAliasGroupCount("concurrent-account", "concurrent-upstream-conversation"))
      .toBe(MAX_RESPONSE_ALIASES_PER_UPSTREAM);
    expect(stats.aliases).toBeLessThanOrEqual(stats.maximumAliases);
  }, 20_000);

  it("enforces the global registry bound even when every alias belongs to a different upstream", async () => {
    const registry = env.CHATS.getByName(RESPONSE_ALIAS_REGISTRY_NAME);
    const now = Date.now();
    for (let index = 0; index < MAX_RESPONSE_ALIASES_TOTAL + 1; index += 1) {
      await registry.registerResponseAlias({
        aliasId: env.CHATS.newUniqueId().toString(),
        generation: crypto.randomUUID(),
        groupId: `independent-upstream-${index}`,
        expiresAt: now + RESPONSE_ALIAS_TTL_MS,
      });
    }
    const stats = await registry.responseAliasRegistryStats();
    expect(stats.aliases).toBe(MAX_RESPONSE_ALIASES_TOTAL);
    expect(stats.maximumPayloadBytes).toBe(MAX_RESPONSE_ALIASES_TOTAL * MAX_CHAT_SESSION_STATE_BYTES);
  }, 30_000);

  it("keeps an old previous-response alias resolvable inside its count/time window and evicts it after seven days", async () => {
    const alias = env.CHATS.getByName(`retained-window-${crypto.randomUUID()}`);
    await alias.seed(
      "retained-conversation",
      "retained-session",
      "retained-account",
      "call-retained",
      "lookup",
      "{}",
      "[]",
      [],
      "retained portable context 中文😀",
    );

    const withinWindow = await alias.acquire();
    expect(withinWindow.started).toBe(true);
    expect(withinWindow.pendingCallId).toBe("call-retained");
    expect(withinWindow.portableProtocolTail).toContain("中文😀");
    await alias.release(withinWindow.leaseId);

    await expect(alias.expireIfIdle(Date.now() + RESPONSE_ALIAS_TTL_MS + 1)).resolves.toBe(true);
    const expired = await alias.acquire();
    expect(expired.started).toBe(false);
    expect(expired.accountId).toBe("");
    await alias.release(expired.leaseId);
  });

  it("keeps the aggregate persisted row within 192 KiB and never splits UTF-8", async () => {
    const alias = env.CHATS.getByName(`utf8-hard-cap-${crypto.randomUUID()}`);
    await alias.seed(
      "state-cap-conversation",
      "state-cap-session",
      "state-cap-account",
      "call-cap",
      "write_file",
      JSON.stringify({ payload: "参".repeat(24_000) }),
      JSON.stringify(Array.from({ length: 128 }, (_, index) => ({
        name: `tool-${index}`,
        fingerprint: `sha256:${index.toString(16).padStart(64, "0")}`,
        failed: false,
      }))),
      [],
      `old-prefix|${"工具😀".repeat(30_000)}|new-suffix`,
    );

    await runInDurableObject(alias, (_instance, state) => {
      const row = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT conversation_id,session_id,account_id,pending_call_id,pending_tool_name,
         pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,
         alias_generation,alias_group_id FROM state WHERE singleton=1`,
      ).toArray()[0];
      const encoder = new TextEncoder();
      const bytes = Object.values(row).reduce((total, value) => total + encoder.encode(String(value ?? "")).byteLength, 0);
      expect(bytes).toBeLessThanOrEqual(MAX_CHAT_SESSION_STATE_BYTES);
      expect(String(row.portable_protocol_tail)).not.toContain("�");
      expect(String(row.portable_protocol_tail).endsWith("|new-suffix")).toBe(true);
    });
  });

  it("allows exactly one conflicting concurrent seed and never resurrects the losing account", async () => {
    const alias = env.CHATS.getByName(`seed-race-${crypto.randomUUID()}`);
    const attempts = await runInDurableObject(alias, (instance) => Promise.allSettled([
      instance.seed("conversation-a", "session-a", "account-a", "", "", "", "[]", [], "tail-a"),
      instance.seed("conversation-b", "session-b", "account-b", "", "", "", "[]", [], "tail-b"),
    ]));
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);

    const winner = await alias.acquire();
    expect([
      ["account-a", "conversation-a", "session-a", "tail-a"],
      ["account-b", "conversation-b", "session-b", "tail-b"],
    ]).toContainEqual([
      winner.accountId,
      winner.conversationId,
      winner.sessionId,
      winner.portableProtocolTail,
    ]);
    await alias.release(winner.leaseId);
  });
});
