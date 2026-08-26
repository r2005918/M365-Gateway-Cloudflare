import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { responsesSessionKey } from "../src/openai";

async function login(password: string, address = "192.0.2.1"): Promise<{ body: { must_change_password: boolean }; cookie: string; status: number }> {
  const response = await SELF.fetch("https://example.test/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": address },
    body: JSON.stringify({ password }),
  });
  return {
    body: await response.json(),
    cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "",
    status: response.status,
  };
}

describe("Cloudflare-native control plane", () => {
  it("reports native health without an origin", async () => {
    const response = await SELF.fetch("https://example.test/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      platform: "cloudflare-native",
      metadataStorage: "durable-object-sqlite",
      credentialStorage: "AES-256-GCM ciphertext in Durable Object SQLite (authoritative) with an encrypted Cloudflare KV mirror",
    });
  });

  it("returns deterministic client errors for malformed and oversized OpenAI requests", async () => {
    const state = env.TENANTS.getByName("default");
    const key = await state.createAPIKey("request-validation", 1);
    const malformed = await SELF.fetch("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: "invalid_json" } });

    const oversized = await SELF.fetch("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(8 * 1024 * 1024 + 1),
        Authorization: `Bearer ${key.key}`,
      },
      body: "{}",
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
  });

  it("accepts parallel_tool_calls=true as permission while retaining sequential execution", async () => {
    const state = env.TENANTS.getByName("default");
    const key = await state.createAPIKey(`parallel-tools-${crypto.randomUUID()}`, 1);
    for (const [path, payload] of [
      ["/v1/chat/completions", { model: "gpt-5.6-sol", messages: [{ role: "user", content: "run both" }], parallel_tool_calls: true }],
      ["/v1/responses", { model: "gpt-5.6-sol", input: "run both", parallel_tool_calls: true }],
    ] as const) {
      const response = await SELF.fetch(`https://example.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
        body: JSON.stringify(payload),
      });
      expect(response.status).not.toBe(400);
      await expect(response.json()).resolves.not.toMatchObject({ error: { code: "parallel_tool_calls_not_supported" } });
    }
  });

  it("rejects duplicate tools and undeclared named choices before acquiring an account", async () => {
    const state = env.TENANTS.getByName("default");
    const key = await state.createAPIKey(`invalid-tools-${crypto.randomUUID()}`, 1);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` };
    const duplicate = { type: "function", function: { name: "inspect", parameters: { type: "object" } } };
    const invalidTools = await SELF.fetch("https://example.test/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "inspect" }], tools: [duplicate, duplicate] }),
    });
    expect(invalidTools.status).toBe(400);
    await expect(invalidTools.json()).resolves.toMatchObject({ error: { code: "invalid_tools" } });

    const invalidChoice = await SELF.fetch("https://example.test/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: "inspect",
        tools: [duplicate],
        tool_choice: { type: "function", name: "delete_everything" },
      }),
    });
    expect(invalidChoice.status).toBe(400);
    await expect(invalidChoice.json()).resolves.toMatchObject({ error: { code: "invalid_tool_choice" } });
  });

  it("routes repeated tool failures into bounded recovery while still blocking an ordinary pending call", async () => {
    const state = env.TENANTS.getByName("default");
    const key = await state.createAPIKey(`tool-loop-integration-${crypto.randomUUID()}`, 1);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` };
    const call = (id: string) => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "run", arguments: '{"command":"build"}' } }],
    });
    const result = (id: string, job: number) => ({
      role: "tool",
      tool_call_id: id,
      content: `error: job ${job} failed; exit code 1`,
    });
    const repeated = await SELF.fetch("https://example.test/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        tools: [{ type: "function", function: { name: "run", parameters: { type: "object", required: ["command"], properties: { command: { type: "string" } } } } }],
        messages: [
          { role: "user", content: "build" },
          call("call_1"),
          result("call_1", 123),
          call("call_2"),
          result("call_2", 456),
          call("call_3"),
        ],
      }),
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      choices: [{ finish_reason: "stop", message: { content: expect.stringContaining("Tool execution stopped") } }],
    });

    const pending = await SELF.fetch("https://example.test/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "build" }, call("call_pending")],
      }),
    });
    expect(pending.status).toBe(409);
    await expect(pending.json()).resolves.toMatchObject({ error: { code: "pending_tool_result" } });
  });

  it("uses one canonical login page", async () => {
    const root = await SELF.fetch("https://example.test/", { redirect: "manual" });
    expect(root.status).toBe(307);
    expect(root.headers.get("Location")).toBe("https://example.test/login");

    const legacy = await SELF.fetch("https://example.test/login.html", { redirect: "manual" });
    expect(legacy.status).toBe(307);
    expect(legacy.headers.get("Location")).toBe("https://example.test/login");

    const loginPage = await SELF.fetch("https://example.test/login");
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("管理员登录");
  });

  it("forces password replacement, invalidates the old session, and protects API keys", async () => {
    const first = await login("admin888");
    expect(first.status).toBe(200);
    expect(first.body.must_change_password).toBe(true);
    expect(first.cookie).toContain("m365_admin_session=");

    const takeover = await SELF.fetch("https://example.test/api/admin/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: "admin888", new_password: "attacker-888" }),
    });
    expect(takeover.status).toBe(401);
    await expect(takeover.json()).resolves.toMatchObject({ error: { code: "auth_error" } });

    const change = await SELF.fetch("https://example.test/api/admin/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: first.cookie },
      body: JSON.stringify({ current_password: "admin888", new_password: "safe-888" }),
    });
    expect(change.status).toBe(200);

    const stale = await SELF.fetch("https://example.test/api/admin/session", { headers: { Cookie: first.cookie } });
    await expect(stale.json()).resolves.toMatchObject({ authenticated: false, must_change_password: false });
    const active = await login("safe-888");
    expect(active.status).toBe(200);
    const managementPage = await SELF.fetch("https://example.test/", {
      headers: { Cookie: active.cookie },
    });
    expect(managementPage.status).toBe(200);
    expect(managementPage.headers.get("Cache-Control")).toBe("no-store");
    const create = await SELF.fetch("https://example.test/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: active.cookie },
      body: JSON.stringify({ name: "integration", days: 1 }),
    });
    expect(create.status).toBe(201);
    const created = await create.json<{ key: string }>();
    expect(created.key).toMatch(/^m365_/u);

    const models = await SELF.fetch("https://example.test/v1/models", {
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toMatchObject({ object: "list" });
  });

  it("lets the correct password recover an IP from an active failed-login lockout", async () => {
    const address = "192.0.2.77";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login("definitely-wrong", address)).status).toBe(401);
    }
    expect((await login("still-wrong", address)).status).toBe(429);

    // The preceding integration case intentionally persists the replacement
    // password in the same Durable Object, matching production semantics.
    const recovered = await login("safe-888", address);
    expect(recovered.status).toBe(200);
    expect(recovered.body.must_change_password).toBe(false);

    // A successful login clears the accumulated failure state.
    expect((await login("wrong-again", address)).status).toBe(401);
  });

  it("stores OAuth credentials as encrypted KV values without exposing account identity in keys", async () => {
    const state = env.TENANTS.getByName("default");
    const token = {
      accessToken: "access-token-must-not-appear-in-kv",
      refreshToken: "refresh-token-must-not-appear-in-kv",
      expiresAt: Date.now() + 3_600_000,
      email: "private-user@example.test",
      displayName: "Private User",
      oid: "private-oid",
      tid: "private-tenant",
    };
    await state.upsertAccount(token);

    const keys = await env.SENSITIVE_KV.list({ prefix: "account-credential:" });
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0].name).not.toContain(token.email);
    expect(keys.keys[0].name).not.toContain(token.oid);
    const encrypted = await env.SENSITIVE_KV.get(keys.keys[0].name);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain(token.accessToken);
    expect(encrypted).not.toContain(token.refreshToken);
    await expect(state.getAccountToken(token.oid)).resolves.toMatchObject(token);
  });

  it("persists, validates, and atomically consumes pending Responses tool calls", async () => {
    const responseId = "resp_pending_call_test";
    const key = await env.TENANTS.getByName("default").createAPIKey("pending-call-test", 1);
    const aliasKey = await responsesSessionKey(new Request("https://example.test/v1/responses", {
      headers: { Authorization: `Bearer ${key.key}` },
    }), { previous_response_id: responseId });
    const session = env.CHATS.getByName(aliasKey);
    const snapshot = JSON.stringify([{ name: "prior_lookup", fingerprint: `sha256:${"a".repeat(64)}`, failed: false }]);
    await session.seed("conversation-test", "session-test", "account-pending-test", "call_expected", "lookup_city_code", "{\"city\":\"Tokyo\"}", snapshot);
    const first = await session.acquire();
    expect(first.pendingCallId).toBe("call_expected");
    expect(first.pendingToolName).toBe("lookup_city_code");
    expect(first.pendingToolArguments).toBe("{\"city\":\"Tokyo\"}");
    expect(first.toolLedgerSnapshot).toBe(snapshot);
    expect(first.accountId).toBe("account-pending-test");
    await session.release(first.leaseId);

    const mismatch = await SELF.fetch("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        previous_response_id: responseId,
        input: [{ type: "function_call_output", call_id: "call_wrong", output: "{}" }],
      }),
    });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: { code: "tool_output_mismatch" } });

    const completion = await session.acquire();
    await session.complete(completion, completion.conversationId, completion.sessionId);
    const replay = await SELF.fetch("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        previous_response_id: responseId,
        input: [{ type: "function_call_output", call_id: "call_expected", output: "{}" }],
      }),
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: "tool_output_already_consumed" } });
  });

  it("does not reuse an upstream conversation that was released before its first completion", async () => {
    const session = env.CHATS.getByName(`uncommitted-${crypto.randomUUID()}`);
    const abandoned = await session.acquire();
    expect(abandoned.started).toBe(false);
    await session.release(abandoned.leaseId);

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.conversationId).not.toBe(abandoned.conversationId);
    expect(retry.sessionId).not.toBe(abandoned.sessionId);
    const bound = await session.bindAccount(retry.leaseId, "account-sticky-retry");
    expect(bound.accountId).toBe("account-sticky-retry");
    Object.assign(retry, bound);
    await session.complete(retry, retry.conversationId, retry.sessionId);

    const continued = await session.acquire();
    expect(continued.started).toBe(true);
    expect(continued.conversationId).toBe(retry.conversationId);
    expect(continued.sessionId).toBe(retry.sessionId);
    expect(continued.accountId).toBe("account-sticky-retry");
    await session.release(continued.leaseId);
  });

  it("tombstones a continuing conversation after an unseen submitted failure while retaining account stickiness", async () => {
    const session = env.CHATS.getByName(`submitted-failure-${crypto.randomUUID()}`);
    const initial = await session.acquire();
    const bound = await session.bindAccount(initial.leaseId, "account-sticky-after-failure");
    Object.assign(initial, bound);
    await session.complete(initial, initial.conversationId, initial.sessionId);

    const failedTurn = await session.acquire();
    expect(failedTurn.started).toBe(true);
    await session.abandon(failedTurn.leaseId);

    const retry = await session.acquire();
    expect(retry.started).toBe(false);
    expect(retry.accountId).toBe("account-sticky-after-failure");
    expect(retry.accountLocked).toBe(true);
    expect(retry.conversationId).not.toBe(failedTurn.conversationId);
    expect(retry.sessionId).not.toBe(failedTurn.sessionId);
    await session.release(retry.leaseId);
  });

  it("keeps one global active account and advances only after an attributable failure", async () => {
    const state = env.TENANTS.getByName(`rotation-${crypto.randomUUID()}`);
    const suffix = crypto.randomUUID();
    const token = (name: string) => ({
      accessToken: `access-${name}`,
      refreshToken: `refresh-${name}`,
      expiresAt: Date.now() + 3_600_000,
      email: `${name}-${suffix}@example.test`,
      displayName: name,
      oid: `${name}-${suffix}`,
      tid: "tenant-rotation",
    });
    const accountA = await state.upsertAccount(token("account-a"));
    const accountB = await state.upsertAccount(token("account-b"));
    const accountC = await state.upsertAccount(token("account-c"));

    for (let request = 0; request < 20; request += 1) {
      await expect(state.selectAccount()).resolves.toMatchObject({ accountId: accountA.id, sequence: 1 });
    }
    await expect(state.selectAccount(accountC.id)).resolves.toBeNull();

    await state.reportAccountFailure(accountA.id, "rate_limit");
    await expect(state.selectAccount("", [accountA.id])).resolves.toMatchObject({ accountId: accountB.id, sequence: 2 });
    // A late failure from the old account cannot skip B.
    await state.reportAccountFailure(accountA.id, "auth");
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: accountB.id, sequence: 2 });

    await state.reportAccountFailure(accountB.id, "auth");
    await expect(state.selectAccount("", [accountA.id, accountB.id])).resolves.toBeNull();
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: accountC.id, sequence: 3 });
    await expect(state.accountAvailability(accountB.id)).resolves.toMatchObject({ available: false, isolated: true });

    await state.reportAccountSuccess(accountA.id);
    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: accountC.id });
    await expect(state.accountPoolStatus()).resolves.toMatchObject({ total: 3, available: 1, cooling: 1, isolated: 1 });
  });

  it("isolates a credential-corrupt account and continues to the next stable sequence candidate", async () => {
    const state = env.TENANTS.getByName(`credential-failover-${crypto.randomUUID()}`);
    const suffix = crypto.randomUUID();
    const accountA = await state.upsertAccount({
      accessToken: "access-corrupt-a",
      refreshToken: "refresh-corrupt-a",
      expiresAt: Date.now() + 3_600_000,
      email: `corrupt-a-${suffix}@example.test`,
      displayName: "corrupt-a",
      oid: `corrupt-a-${suffix}`,
      tid: "tenant-corrupt",
    });
    await runInDurableObject(state, (_instance, durableState) => {
      durableState.storage.sql.exec("UPDATE accounts SET token_cipher='not-a-valid-aes-gcm-payload' WHERE id=?", accountA.id);
    });
    const accountB = await state.upsertAccount({
      accessToken: "access-healthy-b",
      refreshToken: "refresh-healthy-b",
      expiresAt: Date.now() + 3_600_000,
      email: `healthy-b-${suffix}@example.test`,
      displayName: "healthy-b",
      oid: `healthy-b-${suffix}`,
      tid: "tenant-corrupt",
    });

    await expect(state.selectAccount()).resolves.toMatchObject({ accountId: accountB.id, sequence: 2 });
    await expect(state.accountAvailability(accountA.id)).resolves.toMatchObject({ available: false, isolated: true });
  });

  it("allows account failover only before a session is visible and keeps aliases sticky", async () => {
    const session = env.CHATS.getByName(`account-stickiness-${crypto.randomUUID()}`);
    const initial = await session.acquire();
    const accountA = await session.bindAccount(initial.leaseId, "account-a");
    const switched = await session.switchUncommittedAccount(initial.leaseId, accountA.accountId, "account-b");
    expect(switched.accountId).toBe("account-b");
    expect(switched.conversationId).not.toBe(accountA.conversationId);
    expect(switched.sessionId).not.toBe(accountA.sessionId);

    await session.markAccountLocked(switched.leaseId, switched.accountId);
    await session.release(switched.leaseId);
    const retry = await session.acquire();
    expect(retry.accountId).toBe("account-b");
    expect(retry.accountLocked).toBe(true);
    await session.release(retry.leaseId);

    const alias = env.CHATS.getByName(`response-alias-${crypto.randomUUID()}`);
    await alias.seed("conversation-alias", "session-alias", "account-b", "call-alias", "lookup", "{\"id\":7}");
    const aliasLease = await alias.acquire();
    expect(aliasLease.accountId).toBe("account-b");
    expect(aliasLease.pendingCallId).toBe("call-alias");
    expect(aliasLease.pendingToolName).toBe("lookup");
    expect(aliasLease.pendingToolArguments).toBe("{\"id\":7}");
    await alias.release(aliasLease.leaseId);
  });

  it("serializes ChatHub exchanges per account while keeping different accounts independent", async () => {
    const state = env.TENANTS.getByName("default");
    const accountA = `account-a-${crypto.randomUUID()}`;
    const accountB = `account-b-${crypto.randomUUID()}`;
    const first = await state.acquireUpstream(accountA);
    expect(first.ok).toBe(true);
    const blocked = await state.acquireUpstream(accountA);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    const independent = await state.acquireUpstream(accountB);
    expect(independent.ok).toBe(true);
    await state.releaseUpstream(accountA, first.leaseId);
    await state.releaseUpstream(accountB, independent.leaseId);

    const paced = await state.acquireUpstream(accountA);
    expect(paced.ok).toBe(false);
  });

  it("can revoke only the fixed internal soak-key names during final cleanup", async () => {
    const state = env.TENANTS.getByName("default");
    const e2e = await state.createAPIKey("cloudflare-e2e-rotated", 1);
    const soak = await state.createAPIKey("cloudflare-final-soak", 1);
    const user = await state.createAPIKey("user-production-key", 0);
    expect(await state.revokeInternalTestAPIKeys()).toBe(2);
    await expect(state.validAPIKey(e2e.key)).resolves.toBe(false);
    await expect(state.validAPIKey(soak.key)).resolves.toBe(false);
    await expect(state.validAPIKey(user.key)).resolves.toBe(true);
  });

  it("classifies malformed and oversized management JSON without reporting a server crash", async () => {
    const malformed = await SELF.fetch("https://example.test/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: "invalid_json" } });

    const oversized = await SELF.fetch("https://example.test/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
  });
});
