import { describe, expect, it, vi } from "vitest";
import {
  accountForLease,
  adoptToolRouterResult,
  adoptAccountSelection,
  appendPortableProtocolTurn,
  availablePromptCharacterBudget,
  availablePromptTokenBudget,
  chatSessionKey,
  chatPrompt,
  guardAssistantCompletion,
  internalFailureCode,
  isolatedToolRouterCoordinates,
  logicalRequestDeadlineAt,
  mayFailOverExchange,
  parseToolRouterDecision,
  selectActiveChatMessages,
  selectActiveResponsesInput,
  publicFailure,
  recoverRepeatedPendingProposal,
  responseFunctionCallEvents,
  responsesContinuationOutputIssue,
  responsesPrompt,
  responsesSessionKey,
  restorePortableProtocolPrompt,
  toolRouterPrompt,
} from "../src/openai";
import { estimatePromptTokens } from "../src/models";
import {
  parseChatCompletionEvidenceLedger,
  parseChatToolLedger,
  selectChatCompletionEvidenceMessages,
} from "../src/tool-ledger";

describe("OpenAI compatibility safety boundaries", () => {
  it("never exposes an upstream URL or bearer token through public failures", () => {
    const secret = "secret-access-token-value";
    const failure = publicFailure(new Error(`fetch failed: https://substrate.office.com/ChatHub?access_token=${secret}`));
    expect(failure).toEqual({ code: "upstream_error", message: "Microsoft ChatHub request failed" });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain("substrate.office.com");
  });

  it("reports only allow-listed gateway invariant failures", () => {
    expect(publicFailure(new Error("ACCOUNT_NOT_ACTIVE"))).toEqual({
      code: "account_route_changed",
      message: "the active Microsoft 365 account changed before the upstream request started",
    });
    expect(publicFailure(new Error("SESSION_ACCOUNT_MISMATCH"))).toEqual({
      code: "conversation_lease_conflict",
      message: "the conversation lease changed before the turn could be committed",
    });
    expect(publicFailure(new Error("MICROSOFT_REFRESH_TOKEN_MISSING"))).toEqual({
      code: "upstream_auth_error",
      message: "the selected Microsoft 365 account could not refresh its authorization",
    });
    expect(publicFailure(new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE"))).toEqual({
      code: "account_egress_unavailable",
      message: "the selected Microsoft 365 account is assigned to an unavailable relay; switch it to direct Cloudflare egress or restore that relay",
    });
    expect(publicFailure(new Error("WS_BUFFER_TOO_LARGE"))).toEqual({
      code: "upstream_payload_too_large",
      message: "Microsoft ChatHub exceeded the gateway's bounded frame or output limit",
    });
    expect(publicFailure(new Error("RELAY_DIAL_FAILED:502"))).toEqual({
      code: "upstream_relay_error",
      message: "the configured egress relay could not connect to Microsoft ChatHub",
    });
  });

  it("keeps internal diagnostic codes useful without retaining private suffixes", () => {
    expect(internalFailureCode(new Error("CHAT_UPSTREAM_ERROR:private tenant message"))).toBe("CHAT_UPSTREAM_ERROR");
    expect(internalFailureCode(new TypeError("fetch https://secret.example"))).toBe("TypeError");
  });

  it("bounds Chat history while preserving the first instruction and newest user turn", () => {
    const prompt = chatPrompt([
      { role: "system", content: "PROJECT-RULE: keep the workspace isolated" },
      { role: "user", content: "old".repeat(2_000) },
      { role: "assistant", content: "middle".repeat(2_000) },
      { role: "user", content: "LATEST-MARKER-8842" },
    ], 512);
    expect(prompt.length).toBeLessThanOrEqual(512);
    expect(prompt).toContain("PROJECT-RULE");
    expect(prompt).toContain("LATEST-MARKER-8842");
    expect(prompt).toContain("CONTEXT TRUNCATED");
  });

  it("rejects an oversized active Responses string instead of silently deleting its beginning", () => {
    expect(() => responsesPrompt(`${"old".repeat(2_000)}LATEST-RESPONSE-MARKER`, 256))
      .toThrow("CURRENT_TURN_TOO_LARGE");
    expect(() => responsesPrompt("中".repeat(300), 1_000, 256))
      .toThrow("CURRENT_TURN_TOO_LARGE");
  });

  it("trims old CJK history by token budget while preserving the current user turn", () => {
    const prompt = chatPrompt([
      { role: "user", content: "旧".repeat(2_000) },
      { role: "assistant", content: "历史".repeat(2_000) },
      { role: "user", content: "CURRENT-TURN-MARKER" },
    ], 20_000, 96);
    expect(prompt).toContain("CURRENT-TURN-MARKER");
    expect(prompt).not.toContain("旧".repeat(20));
    expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(96);
  });

  it("reserves at most one third for the newest system/developer instructions", () => {
    const prompt = chatPrompt([
      { role: "system", content: `OLD-INSTRUCTION-${"旧".repeat(200)}` },
      { role: "developer", content: `LATEST-INSTRUCTION-${"新".repeat(20)}` },
      { role: "user", content: "CURRENT-TASK" },
    ], 2_000, 96);
    expect(prompt).toContain("LATEST-INSTRUCTION");
    expect(prompt).not.toContain("OLD-INSTRUCTION");
    expect(prompt).toContain("CURRENT-TASK");
    expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(96);
  });

  it("uses one ten-minute logical deadline for the initial exchange and every repair", () => {
    const startedAt = 1_000_000;
    const deadline = logicalRequestDeadlineAt(startedAt);
    expect(deadline).toBe(startedAt + 10 * 60_000);
    // A repair beginning late consumes the remaining budget; it must not call
    // logicalRequestDeadlineAt again and manufacture another ten minutes.
    expect(deadline - (startedAt + 9 * 60_000)).toBe(60_000);
  });

  it("routes auto tools explicitly while preserving a valid no-call decision", () => {
    const tools = [{
      type: "function",
      function: {
        name: "read",
        description: "Read a local file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    }];
    const prompt = toolRouterPrompt("inspect the workspace", tools, "auto");
    expect(prompt).toContain("MODE: auto");
    expect(prompt).toContain("NO_TOOL_REQUIRED");
    expect(prompt).toContain('AVAILABLE_TOOL_NAMES: ["read"]');
    expect(parseToolRouterDecision("NO_TOOL_REQUIRED", tools, "auto")).toEqual({ valid: true, call: null });
    expect(parseToolRouterDecision("NO_TOOL_REQUIRED", tools, "required")).toEqual({ valid: false, call: null });
    expect(parseToolRouterDecision('{"calls":[]}', tools, "auto")).toEqual({ valid: true, call: null });
    expect(parseToolRouterDecision('{"calls":[]}', tools, "required")).toEqual({ valid: false, call: null });
    expect(parseToolRouterDecision(
      '{"calls":[{"name":"read","arguments":{"path":"C:/workspace/README.md"}}]}',
      tools,
      "auto",
    )).toEqual({ valid: true, call: { name: "read", arguments: '{"path":"C:/workspace/README.md"}' } });
  });

  it("rejects malformed, narrated, parallel, and schema-invalid router output", () => {
    const tools = [{
      type: "function",
      function: {
        name: "read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    }];
    expect(parseToolRouterDecision('Use this: {"calls":[]}', tools, "auto").valid).toBe(false);
    expect(parseToolRouterDecision('{"calls":[{"name":"read","arguments":{}}]}', tools, "auto").valid).toBe(false);
    expect(parseToolRouterDecision('{"calls":[{"name":"read","arguments":{"path":"a"}},{"name":"read","arguments":{"path":"b"}}]}', tools, "auto").valid).toBe(false);
  });

  it("continues a selected tool from the router conversation rather than an unrelated answer", () => {
    const target = {
      text: "ordinary answer",
      conversationId: "answer-conversation",
      sessionId: "answer-session",
      requestId: "answer-request",
    };
    const router = {
      text: '{"calls":[{"name":"read","arguments":{"path":"README.md"}}]}',
      conversationId: "router-conversation",
      sessionId: "router-session",
      requestId: "router-request",
      throttling: { CostQuota: 1 },
    };
    adoptToolRouterResult(target, router);
    expect(target).toMatchObject({
      conversationId: "router-conversation",
      sessionId: "router-session",
      requestId: "router-request",
      text: router.text,
      throttling: { CostQuota: 1 },
    });
  });

  it("never changes accounts after upstream content becomes visible", () => {
    expect(mayFailOverExchange(true, false, false, false)).toBe(true);
    expect(mayFailOverExchange(true, false, false, true)).toBe(false);
    expect(mayFailOverExchange(true, true, true, false)).toBe(false);
    expect(mayFailOverExchange(false, false, false, false)).toBe(false);
    // The upstream may have accepted a prompt before producing a delta. A
    // second account must not receive a replay merely because no text was
    // visible yet.
    expect(mayFailOverExchange(true, false, false, false, true)).toBe(false);
    expect(mayFailOverExchange(true, false, false, false, false, 10_000, 10_000)).toBe(false);
  });

  it("emits the canonical sequential Responses function-call lifecycle", () => {
    const item = {
      id: "fc_test",
      type: "function_call",
      call_id: "call_test",
      name: "inspect",
      arguments: '{"path":"a"}',
      status: "completed",
    };
    const events = responseFunctionCallEvents(item, { name: "inspect", arguments: '{"path":"a"}' });
    expect(events.map((event) => event.type)).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
    ]);
    expect(events[0]).toMatchObject({ item: { arguments: "", status: "in_progress" } });
    expect(events[2]).toMatchObject({ call_id: "call_test", name: "inspect", arguments: '{"path":"a"}' });
    expect(events[3]).toMatchObject({ item: { arguments: '{"path":"a"}', status: "completed" } });
  });

  it("does not replay persisted Chat history and keeps tool call/result groups atomic", () => {
    const selected = selectActiveChatMessages([
      { role: "developer", content: "policy" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current question" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
          { id: "call_b", type: "function", function: { name: "read", arguments: '{"path":"b"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "A" },
      { role: "tool", tool_call_id: "call_b", content: "B" },
    ], true);
    expect(selected.map((message) => message.content)).not.toContain("old question");
    expect(selected.map((message) => message.content)).not.toContain("old answer");
    expect(selected).toHaveLength(5);
    expect(selected[0]).toMatchObject({ role: "developer", content: "policy" });
    expect(selected.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "current question" }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_a" }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_b" }),
    ]));
  });

  it("keeps task-local tool evidence across short continuation messages without changing active-turn execution scope", async () => {
    const messages = [
      { role: "user", content: "patch and verify the current worker" },
      { role: "assistant", tool_calls: [{ id: "call_patch", type: "function", function: { name: "apply_patch", arguments: '{"patch":"safe change"}' } }] },
      { role: "tool", tool_call_id: "call_patch", content: "Done!" },
      { role: "assistant", content: "working" },
      { role: "user", content: "继续" },
      { role: "assistant", tool_calls: [{ id: "call_check", type: "function", function: { name: "verify_health", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_check", content: "HTTP 200" },
      { role: "assistant", content: "working" },
      { role: "user", content: "继续" },
    ];
    const selected = selectChatCompletionEvidenceMessages(messages);
    const evidence = await parseChatCompletionEvidenceLedger(messages);
    const active = await parseChatToolLedger(messages);
    expect(selected[0]).toMatchObject({ role: "user", content: "patch and verify the current worker" });
    expect(evidence.completed.map((item) => item.name)).toEqual(["apply_patch", "verify_health"]);
    expect(active.completed).toEqual([]);
  });

  it("does not replay persisted Responses history but retains the current function output", () => {
    const selected = selectActiveResponsesInput([
      { type: "message", role: "user", content: "old question" },
      { type: "message", role: "assistant", content: "old answer" },
      { type: "message", role: "user", content: "current question" },
      { type: "function_call", call_id: "call_current", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "call_current", output: "current evidence" },
    ], true);
    expect(JSON.stringify(selected)).not.toContain("old question");
    expect(JSON.stringify(selected)).not.toContain("old answer");
    expect(JSON.stringify(selected)).toContain("current question");
    expect(JSON.stringify(selected)).toContain("current evidence");

    const outputOnly = selectActiveResponsesInput([
      { type: "function_call_output", call_id: "call_pending", output: "fresh result" },
    ], true);
    expect(outputOnly).toEqual([
      { type: "function_call_output", call_id: "call_pending", output: "fresh result" },
    ]);
  });

  it("does not replay a full old Responses turn when previous_response_id returns its pending output", () => {
    const selected = selectActiveResponsesInput([
      { type: "message", role: "system", content: "keep project isolation" },
      { type: "message", role: "user", content: "old task that ChatHub already persisted" },
      { type: "message", role: "assistant", content: "old partial answer" },
      { type: "function_call", call_id: "call_pending", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "call_pending", output: "fresh evidence" },
      { type: "message", role: "user", content: "new instruction after the tool result" },
    ], true, { previousResponse: true, pendingCallId: "call_pending" });

    expect(selected).toEqual([
      { type: "message", role: "system", content: "keep project isolation" },
      { type: "function_call_output", call_id: "call_pending", output: "fresh evidence" },
      { type: "message", role: "user", content: "new instruction after the tool result" },
    ]);
    expect(JSON.stringify(selected)).not.toContain("old task");
    expect(JSON.stringify(selected)).not.toContain("old partial answer");
    expect(JSON.stringify(selected)).not.toContain('"type":"function_call"');
  });

  it("ignores only causally paired historical Responses outputs and still rejects unknown or replayed results", () => {
    const fullReplay = [
      { type: "message", role: "user", content: "old task" },
      { type: "function_call", call_id: "call_old", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "call_old", output: "old evidence" },
      { type: "function_call", call_id: "call_pending", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "call_pending", output: "fresh evidence" },
    ];
    expect(responsesContinuationOutputIssue(fullReplay, "call_pending")).toBeNull();
    expect(responsesContinuationOutputIssue([
      ...fullReplay.slice(0, -1),
      { type: "function_call_output", call_id: "call_unknown", output: "injected" },
    ], "call_pending")).toBe("tool_output_mismatch");

    expect(responsesContinuationOutputIssue([
      { type: "function_call", call_id: "call_old", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "call_old", output: "old evidence" },
      { type: "message", role: "user", content: "new task" },
    ], "")).toBeNull();
    expect(responsesContinuationOutputIssue([
      { type: "message", role: "user", content: "new task" },
      { type: "function_call_output", call_id: "call_old", output: "replayed" },
    ], "")).toBe("tool_output_already_consumed");
  });

  it("turns a third unexecuted repeat into bounded recovery instead of a retry-inducing 409", async () => {
    const call = (id: string) => ({
      role: "assistant",
      tool_calls: [{ id, type: "function", function: { name: "run", arguments: '{"command":"build"}' } }],
    });
    const ledger = await parseChatToolLedger([
      { role: "user", content: "build" },
      call("call_1"),
      { role: "tool", tool_call_id: "call_1", content: "error: job 123 failed" },
      call("call_2"),
      { role: "tool", tool_call_id: "call_2", content: "error: job 456 failed" },
      call("call_3"),
    ]);
    const recovered = recoverRepeatedPendingProposal(ledger);
    expect(recovered.pending).toEqual([]);
    expect(recovered.issues).toContainEqual(expect.objectContaining({ code: "repeated_failure" }));
    expect(recovered.issues).not.toContainEqual(expect.objectContaining({ callId: "call_3" }));
  });

  it("rejects an oversized active tool unit instead of splitting call identity from its result", () => {
    expect(() => chatPrompt([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_atomic", type: "function", function: { name: "inspect", arguments: JSON.stringify({ payload: "x".repeat(2_000) }) } }],
      },
      { role: "tool", tool_call_id: "call_atomic", content: "result" },
    ], 512)).toThrow("CURRENT_TURN_TOO_LARGE");
  });

  it("accounts for both textual and native tool definitions in the model context budget", () => {
    const small = [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }];
    expect(availablePromptCharacterBudget("claude-sonnet", small, 1_000)).toBeGreaterThan(4_096);
    const oversized = [{
      type: "function",
      function: { name: "inspect", description: "x".repeat(210_000), parameters: { type: "object" } },
    }];
    expect(() => availablePromptCharacterBudget("claude-sonnet", oversized, 0)).toThrow("TOOL_DEFINITIONS_EXCEED_MODEL_CONTEXT");
    expect(availablePromptTokenBudget("claude-sonnet", small, "证据".repeat(100))).toBeLessThan(93_952);
    const cjkHeavy = [{
      type: "function",
      function: { name: "inspect", description: "工".repeat(70_000), parameters: { type: "object" } },
    }];
    expect(() => availablePromptTokenBudget("claude-sonnet", cjkHeavy, "")).toThrow("TOOL_DEFINITIONS_EXCEED_MODEL_CONTEXT");
  });

  it("derives credential-scoped stable Responses sessions without retaining raw client identifiers", async () => {
    const firstRequest = new Request("https://example.test/v1/responses", {
      headers: { Authorization: "Bearer key-a" },
    });
    const secondRequest = new Request("https://example.test/v1/responses", {
      headers: { Authorization: "Bearer key-b" },
    });
    const body = {
      prompt_cache_key: "private-project-thread",
      client_metadata: { thread_id: "fallback-thread" },
    };
    const first = await responsesSessionKey(firstRequest, body);
    expect(first).toBe(await responsesSessionKey(firstRequest, body));
    expect(first).not.toContain("private-project-thread");
    expect(await responsesSessionKey(secondRequest, body)).not.toBe(first);
    expect(await responsesSessionKey(firstRequest, { client_metadata: { thread_id: "fallback-thread" } })).not.toBe(first);

    const freshA = await responsesSessionKey(firstRequest, { ...body, new_conversation: true });
    const freshB = await responsesSessionKey(firstRequest, { ...body, new_conversation: true });
    expect(freshA).not.toBe(freshB);

    const conversation = await responsesSessionKey(firstRequest, { conversation: { id: "conversation-7" } });
    expect(conversation).not.toContain("conversation-7");
    expect(conversation).toBe(await responsesSessionKey(firstRequest, { conversation: "conversation-7" }));
  });

  it("scopes Chat and explicit Responses session identifiers to the API credential", async () => {
    const requestA = new Request("https://example.test/v1/chat/completions", {
      headers: { Authorization: "Bearer key-a", "X-Session-Key": "shared-friendly-name" },
    });
    const requestB = new Request("https://example.test/v1/chat/completions", {
      headers: { Authorization: "Bearer key-b", "X-Session-Key": "shared-friendly-name" },
    });
    const chatA = await chatSessionKey(requestA, {});
    expect(chatA).toBe(await chatSessionKey(requestA, {}));
    expect(chatA).not.toContain("shared-friendly-name");
    expect(await chatSessionKey(requestB, {})).not.toBe(chatA);

    const responsesA = await responsesSessionKey(requestA, { session_key: "shared-friendly-name" });
    expect(responsesA).toBe(await responsesSessionKey(requestA, { session_key: "shared-friendly-name" }));
    expect(responsesA).not.toContain("shared-friendly-name");
    expect(await responsesSessionKey(requestB, { session_key: "shared-friendly-name" })).not.toBe(responsesA);
  });

  it("rejects adversarially large stable session identifiers", async () => {
    await expect(chatSessionKey(new Request("https://example.test/v1/chat/completions"), {
      session_key: "x".repeat(1_025),
    })).rejects.toThrow("INVALID_SESSION_KEY");
  });

  it("keeps the failover account object live for every subsequent required-tool repair exchange", () => {
    const token = (id: string) => ({
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      email: `${id}@example.test`,
      displayName: id,
      oid: id,
      tid: "tenant",
    });
    const active = { accountId: "account-1", sequence: 1, routeEpoch: 7, token: token("account-1") };
    const repairReadsSameObject = (): string => active.token.accessToken;
    adoptAccountSelection(active, { accountId: "account-2", sequence: 2, routeEpoch: 8, token: token("account-2") });
    expect(active.accountId).toBe("account-2");
    expect(active.routeEpoch).toBe(8);
    expect(repairReadsSameObject()).toBe("access-account-2");
  });

  it("rebinds a committed session to the global active account without waking the old account", async () => {
    const oldConversation = "conversation-old";
    const oldSession = "session-old";
    const lease = {
      leaseId: "lease-rebind",
      conversationId: oldConversation,
      sessionId: oldSession,
      accountId: "account-old",
      accountLocked: true,
      started: true,
      pendingCallId: "call-pending",
      pendingToolName: "write_file",
      pendingToolArguments: '{"path":"C:\\\\workspace\\\\a.txt"}',
      toolLedgerSnapshot: "[]",
      taskAnchors: [{ kind: "windows_path" as const, value: "C:\\workspace" }],
      portableProtocolTail: "[USER] keep the original task",
    };
    const active = {
      accountId: "account-next",
      sequence: 2,
      routeEpoch: 9,
      token: {
        accessToken: "access-next",
        refreshToken: "refresh-next",
        expiresAt: Date.now() + 60_000,
        email: "next@example.test",
        displayName: "next",
        oid: "account-next",
        tid: "tenant",
      },
    };
    const selectAccount = vi.fn(async (preferred = "") => preferred ? null : active);
    const rebindCommittedAccount = vi.fn(async () => ({
      ...lease,
      conversationId: "conversation-new",
      sessionId: "session-new",
      accountId: active.accountId,
      accountLocked: false,
      started: false,
    }));
    const session = { rebindCommittedAccount };
    const env = {
      TENANTS: { getByName: () => ({ selectAccount }) },
      CHATS: { getByName: () => session },
      TENANT_NAME: "test",
    };

    const resolved = await accountForLease(env as never, session as never, lease);
    expect(resolved).toMatchObject({ account: { accountId: "account-next", routeEpoch: 9 }, rebound: true });
    expect(selectAccount).toHaveBeenNthCalledWith(1, "account-old");
    expect(selectAccount).toHaveBeenNthCalledWith(2);
    expect(rebindCommittedAccount).toHaveBeenCalledWith("lease-rebind", "account-old", "account-next");
    expect(lease).toMatchObject({ accountId: "account-next", conversationId: "conversation-new", sessionId: "session-new", started: false });
  });

  it("restores only whole recent portable turns and always retains the current turn", () => {
    let tail = appendPortableProtocolTurn("", "[USER] old task", "[ASSISTANT] old answer");
    tail = appendPortableProtocolTurn(tail, "[USER] recent task", "[ASSISTANT] recent answer");
    const full = restorePortableProtocolPrompt(tail, "[USER] current tool result", 8_000, 8_000);
    expect(full).toContain("old task");
    expect(full).toContain("recent answer");
    expect(full).toContain("current tool result");

    const bounded = restorePortableProtocolPrompt(tail, "[USER] current tool result", 220, 220);
    expect(bounded).not.toContain("old task");
    expect(bounded).toContain("recent task");
    expect(bounded).toContain("recent answer");
    expect(bounded).toContain("current tool result");
  });

  it("gives every hidden tool-router repair isolated coordinates and leaves the user conversation untouched", () => {
    const userCoordinates = { conversationId: "conversation-user", sessionId: "session-user" };
    const first = isolatedToolRouterCoordinates();
    const second = isolatedToolRouterCoordinates();
    expect(first).not.toEqual(second);
    expect(first.conversationId).not.toBe(userCoordinates.conversationId);
    expect(first.sessionId).not.toBe(userCoordinates.sessionId);
    expect(userCoordinates).toEqual({ conversationId: "conversation-user", sessionId: "session-user" });
  });

  it("classifies an explicit ChatHub close-before-completion as a disconnect", () => {
    expect(publicFailure(new Error("CHAT_CLOSED_BEFORE_COMPLETION:transport closed"))).toEqual({
      code: "upstream_disconnected",
      message: "Microsoft ChatHub disconnected before completion",
    });
  });

  it("replaces an unsupported completion claim with a normal terminal answer", async () => {
    const ledger = await parseChatToolLedger([
      { role: "assistant", tool_calls: [{ id: "call_failed", type: "function", function: { name: "deploy_app", arguments: '{"target":"candidate"}' } }] },
      { role: "tool", tool_call_id: "call_failed", content: "error: deployment failed" },
      { role: "user", content: "continue" },
    ], { activeChatTurnOnly: false });
    const result = {
      text: "已经部署完成，全部工作都完成了。",
      conversationId: "conversation",
      sessionId: "session",
      throttling: null,
    };
    const guarded = guardAssistantCompletion(result, null, ledger, [{ type: "function", function: { name: "deploy_app" } }]);
    expect(guarded.text).toContain("不能声明已经完成");
    expect(guarded.text).not.toContain("candidate");
  });

  it("preserves supported completion claims, ordinary prose, and tool proposals", async () => {
    const ledger = await parseChatToolLedger([
      { role: "assistant", tool_calls: [{ id: "call_ok", type: "function", function: { name: "run_tests", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_ok", content: "exit code 0" },
      { role: "user", content: "summarize" },
    ], { activeChatTurnOnly: false });
    const base = { conversationId: "conversation", sessionId: "session", throttling: null };
    expect(guardAssistantCompletion({ ...base, text: "测试已经通过。" }, null, ledger, undefined).text).toBe("测试已经通过。");
    expect(guardAssistantCompletion({ ...base, text: "下面给出排查方案。" }, null, ledger, undefined).text).toBe("下面给出排查方案。");
    expect(guardAssistantCompletion({ ...base, text: "已经部署完成。" }, { name: "deploy_app", arguments: "{}" }, ledger, undefined).text).toBe("已经部署完成。");
  });
});
