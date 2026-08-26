import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAccountFailure } from "../src/account-routing";
import {
  ChatHubAttemptError,
  chatHubInvocationWasSubmitted,
  mayFailOverChatHubFailure,
  mayReconnectChatHubFailure,
  nextChatHubFrame,
} from "../src/chathub";
import type { ChatLease, ChatSession } from "../src/chat-session";
import {
  mayFailOverExchange,
  openAIRequest,
  responsesContinuationOutputIssue,
  responsesPrompt,
  selectActiveResponsesInput,
  toolRecoveryTermination,
} from "../src/openai";
import {
  completedToolSnapshots,
  guardProposedToolCalls,
  parseChatToolLedger,
  parseResponsesToolLedger,
} from "../src/tool-ledger";
import type { Env, OAuthTokenSet } from "../src/types";
import { HISTORICAL_SERVER_INCIDENTS as incidents } from "./fixtures/historical-server-incidents";

function token(id: string): OAuthTokenSet {
  return {
    accessToken: `test-access-${id}`,
    refreshToken: `test-refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    email: `${id}@example.test`,
    displayName: id,
    oid: id,
    tid: "historical-regression-tenant",
  };
}

function chatCall(callId: string, name: string, argumentsValue: unknown): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: callId,
      type: "function",
      function: {
        name,
        arguments: typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue),
      },
    }],
  };
}

function chatResult(callId: string, content: string): Record<string, unknown> {
  return { role: "tool", tool_call_id: callId, content };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const accountPace = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1_050));

interface FakeOpenAIControl {
  env: Env;
  lease: ChatLease;
  session: {
    acquire: ReturnType<typeof vi.fn>;
    bindAccount: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    abandon: ReturnType<typeof vi.fn>;
    markAccountLocked: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    completeFinal: ReturnType<typeof vi.fn>;
    seed: ReturnType<typeof vi.fn>;
    switchUncommittedAccount: ReturnType<typeof vi.fn>;
    mergeTaskAnchors: ReturnType<typeof vi.fn>;
  };
  state: {
    selectAccount: ReturnType<typeof vi.fn>;
    accountAvailability: ReturnType<typeof vi.fn>;
    accountPoolStatus: ReturnType<typeof vi.fn>;
    acquireUpstream: ReturnType<typeof vi.fn>;
    cancelUpstreamWaiter: ReturnType<typeof vi.fn>;
    releaseUpstream: ReturnType<typeof vi.fn>;
    reportAccountFailure: ReturnType<typeof vi.fn>;
    reportAccountSuccess: ReturnType<typeof vi.fn>;
  };
}

function fakeOpenAIControl(): FakeOpenAIControl {
  const lease: ChatLease = {
    leaseId: `lease-${crypto.randomUUID()}`,
    conversationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    accountId: "",
    accountLocked: false,
    started: false,
    pendingCallId: "",
    pendingToolName: "",
    pendingToolArguments: "",
    toolLedgerSnapshot: "[]",
    taskAnchors: [],
  };
  const selected = { accountId: "account-1", sequence: 1, token: token("account-1") };
  let selections = 0;
  const state = {
    selectAccount: vi.fn(async () => {
      selections += 1;
      return selections === 1 ? selected : null;
    }),
    accountAvailability: vi.fn(async () => ({ available: true, retryAfterMs: 0, isolated: false })),
    accountPoolStatus: vi.fn(async () => ({ total: 1, available: 1, cooling: 0, isolated: 0, retryAfterMs: 0 })),
    acquireUpstream: vi.fn(async () => ({ ok: true, leaseId: `gate-${crypto.randomUUID()}`, retryAfterMs: 0 })),
    cancelUpstreamWaiter: vi.fn(async () => undefined),
    releaseUpstream: vi.fn(async () => undefined),
    reportAccountFailure: vi.fn(async () => ({ available: false, retryAfterMs: 15_000, isolated: false })),
    reportAccountSuccess: vi.fn(async () => undefined),
  };
  const session = {
    acquire: vi.fn(async () => ({ ...lease })),
    bindAccount: vi.fn(async (leaseId: string, accountId: string) => {
      lease.leaseId = leaseId;
      lease.accountId = accountId;
      return { ...lease };
    }),
    release: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
    markAccountLocked: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    completeFinal: vi.fn(async () => undefined),
    seed: vi.fn(async () => undefined),
    switchUncommittedAccount: vi.fn(async () => ({ ...lease })),
    mergeTaskAnchors: vi.fn(async (_leaseId: string, anchors: ChatLease["taskAnchors"]) => {
      lease.taskAnchors = anchors;
      return anchors;
    }),
  };
  return {
    env: {
      TENANTS: { getByName: () => state } as unknown as Env["TENANTS"],
      CHATS: { getByName: () => session } as unknown as Env["CHATS"],
      TENANT_NAME: "historical-regression",
    } as unknown as Env,
    lease,
    session,
    state,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sanitized historical production incident corpus", () => {
  it("keeps stable unique incident IDs and explicit safety invariants", () => {
    const values = Object.values(incidents);
    expect(new Set(values.map((incident) => incident.id)).size).toBe(values.length);
    expect(values).toHaveLength(11);
    for (const incident of values) {
      expect(incident.symptom.length).toBeGreaterThan(20);
      expect(incident.invariant.length).toBeGreaterThan(30);
      expect(`${incident.symptom} ${incident.invariant}`).not.toMatch(/(?:Bearer|m365_|cfk_|access-token|refresh-token)/iu);
    }
  });
});

describe("historical long-stream and replay regressions", () => {
  it(`${incidents.autoToolRouting.id} emits an auto-selected local tool and commits the router coordinates`, async () => {
    const control = fakeOpenAIControl();
    const upstreamCoordinates: Array<{ conversationId: string; sessionId: string; text: string }> = [];
    const answers = ['{"calls":[{"name":"read","arguments":{"path":"C:/workspace/README.md"}}]}'];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      let messages = 0;
      const answer = answers[upstreamCoordinates.length] ?? answers.at(-1)!;
      server.addEventListener("message", (event) => {
        messages += 1;
        if (messages === 1) {
          server.send(`{}\u001e`);
          return;
        }
        const wire = String(event.data);
        const frame = JSON.parse(wire.split("\u001e")[0]) as {
          arguments: Array<{ conversationId: string; sessionId: string; message: { text: string } }>;
        };
        upstreamCoordinates.push({
          conversationId: frame.arguments[0].conversationId,
          sessionId: frame.arguments[0].sessionId,
          text: frame.arguments[0].message.text,
        });
        server.send(`${JSON.stringify({
          type: 1,
          target: "update",
          arguments: [{
            messages: [{ contentType: "ToolCall", name: "read", arguments: { path: "C:/workspace/README.md" } }],
            throttling: { CostQuota: 0 },
          }],
        })}\u001e${JSON.stringify({ type: 3 })}\u001e`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }));

    const request = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "Read C:/workspace/README.md and summarize it" }],
        tools: [{
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
        }],
        tool_choice: "auto",
      }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{
        finish_reason: "tool_calls",
        message: { tool_calls: [{ function: { name: "read", arguments: '{"path":"C:/workspace/README.md"}' } }] },
      }],
    });
    expect(upstreamCoordinates).toHaveLength(1);
    expect(upstreamCoordinates[0].text).toContain("MODE: auto");
    expect(upstreamCoordinates[0].text).not.toContain("I cannot access the local workspace");
    expect(control.session.completeFinal).toHaveBeenCalledWith(
      expect.anything(),
      upstreamCoordinates[0].conversationId,
      upstreamCoordinates[0].sessionId,
      expect.anything(),
    );
    expect(control.state.reportAccountFailure).not.toHaveBeenCalled();
    expect(control.state.reportAccountSuccess).toHaveBeenCalledTimes(1);
  });

  it(`${incidents.autoToolRouting.id} treats a native auto response without a call as an ordinary answer decision`, async () => {
    const control = fakeOpenAIControl();
    const upstreamCoordinates: Array<{ conversationId: string; sessionId: string; text: string }> = [];
    const pluginCounts: number[] = [];
    const answers = ["The supplied evidence is already sufficient."];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      let messages = 0;
      const answer = answers[upstreamCoordinates.length] ?? answers.at(-1)!;
      server.addEventListener("message", (event) => {
        messages += 1;
        if (messages === 1) {
          server.send(`{}\u001e`);
          return;
        }
        const wire = String(event.data);
        const frame = JSON.parse(wire.split("\u001e")[0]) as {
          arguments: Array<{ conversationId: string; sessionId: string; message: { text: string }; plugins?: unknown[] }>;
        };
        pluginCounts.push(frame.arguments[0].plugins?.length ?? 0);
        upstreamCoordinates.push({
          conversationId: frame.arguments[0].conversationId,
          sessionId: frame.arguments[0].sessionId,
          text: frame.arguments[0].message.text,
        });
        server.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ writeAtCursor: answer }] })}\u001e${JSON.stringify({ type: 3 })}\u001e`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }));

    const request = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "Summarize the evidence, reading a file only if necessary" }],
        tools: [{
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
        }],
        tool_choice: "auto",
      }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ finish_reason: "stop", message: { content: "The supplied evidence is already sufficient." } }],
    });
    expect(upstreamCoordinates).toHaveLength(1);
    expect(pluginCounts).toEqual([1]);
    expect(upstreamCoordinates[0].text).toContain("TOOL_MODE: auto");
    expect(upstreamCoordinates[0].text).toContain("Do not infer that a caller path, credential, host, or command is missing or failed");
    expect(upstreamCoordinates[0]).toMatchObject({
      conversationId: control.lease.conversationId,
      sessionId: control.lease.sessionId,
    });
  });

  it("reroutes an unsupported completion claim to a materially useful next tool", async () => {
    const control = fakeOpenAIControl();
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      let messages = 0;
      server.addEventListener("message", (event) => {
        messages += 1;
        if (messages === 1) {
          server.send(`{}\u001e`);
          return;
        }
        const frame = JSON.parse(String(event.data).split("\u001e")[0]) as {
          arguments: Array<{ message: { text: string } }>;
        };
        const index = prompts.push(frame.arguments[0].message.text) - 1;
        const update = index === 0
          ? { writeAtCursor: "修复已完成。" }
          : { messages: [{ contentType: "ToolCall", name: "apply_patch", arguments: { patch: "safe next change" } }] };
        server.send(`${JSON.stringify({ type: 1, target: "update", arguments: [update] })}\u001e${JSON.stringify({ type: 3 })}\u001e`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }));

    const request = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [
          { role: "user", content: "Inspect and repair the script" },
          chatCall("call_read", "read", { path: "C:/workspace/script.ps1" }),
          chatResult("call_read", "script contents"),
        ],
        tools: ["read", "apply_patch"].map((name) => ({
          type: "function",
          function: { name, parameters: { type: "object", additionalProperties: true } },
        })),
        tool_choice: "auto",
      }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "apply_patch" } }] } }],
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("COMPLETION EVIDENCE RECOVERY");
    expect(prompts[1]).toContain("Do not repeat a completed inspection unchanged");
  });

  it.each([
    { name: "streaming Chat Completions", path: "/v1/chat/completions", body: { messages: [{ role: "user", content: "Read C:/workspace/README.md" }], stream: true }, marker: '"finish_reason":"tool_calls"' },
    { name: "non-streaming Responses", path: "/v1/responses", body: { input: "Read C:/workspace/README.md" }, marker: '"type":"function_call"' },
    { name: "streaming Responses", path: "/v1/responses", body: { input: "Read C:/workspace/README.md", stream: true }, marker: "response.function_call_arguments.done" },
  ])("uses one native tool-enabled turn for $name", async ({ path, body, marker }) => {
    const control = fakeOpenAIControl();
    const upstreamPrompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      let messages = 0;
      server.addEventListener("message", (event) => {
        messages += 1;
        if (messages === 1) {
          server.send(`{}\u001e`);
          return;
        }
        const frame = JSON.parse(String(event.data).split("\u001e")[0]) as {
          arguments: Array<{ message: { text: string } }>;
        };
        upstreamPrompts.push(frame.arguments[0].message.text);
        const answer = '{"calls":[{"name":"read","arguments":{"path":"C:/workspace/README.md"}}]}';
        server.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ writeAtCursor: answer }] })}\u001e${JSON.stringify({ type: 3 })}\u001e`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }));

    const responseTools = [{
      type: "function",
      name: "read",
      description: "Read a local file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }];
    const chatTools = responseTools.map(({ name, description, parameters }) => ({
      type: "function",
      function: { name, description, parameters },
    }));
    const request = new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        ...body,
        tools: path.endsWith("responses") ? responseTools : chatTools,
        tool_choice: "auto",
      }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status).toBe(200);
    const encoded = await response.text();
    expect(encoded).toContain(marker);
    expect(encoded).toContain("C:/workspace/README.md");
    expect(upstreamPrompts).toHaveLength(1);
    expect(upstreamPrompts[0]).toContain("TOOL_MODE: auto");
    expect(upstreamPrompts[0]).not.toContain("I cannot access the local workspace");
    expect(control.session.completeFinal).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "streaming Chat Completions", path: "/v1/chat/completions" },
    { name: "streaming Responses", path: "/v1/responses" },
  ])("returns a completed assistant stop instead of upstream_error when $name reaches tool round 33", async ({ path }) => {
    const control = fakeOpenAIControl();
    let upstreamExchanges = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      upstreamExchanges += 1;
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      let messages = 0;
      server.addEventListener("message", () => {
        messages += 1;
        if (messages === 1) {
          server.send(`{}\u001e`);
          return;
        }
        const answer = '{"calls":[{"name":"read","arguments":{"path":"C:/workspace/round-33.txt"}}]}';
        server.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ writeAtCursor: answer }] })}\u001e${JSON.stringify({ type: 3 })}\u001e`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }));

    const responseTools = [{
      type: "function",
      name: "read",
      description: "Read a local file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }];
    const chatTools = responseTools.map(({ name, description, parameters }) => ({
      type: "function",
      function: { name, description, parameters },
    }));
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "Read the bounded set of files" }];
    const input: Array<Record<string, unknown>> = [{ type: "message", role: "user", content: "Read the bounded set of files" }];
    for (let index = 0; index < 32; index += 1) {
      const callId = `call_round_${index}`;
      const args = { path: `C:/workspace/round-${index}.txt` };
      messages.push(chatCall(callId, "read", args), chatResult(callId, `verified round ${index}`));
      input.push(
        { type: "function_call", call_id: callId, name: "read", arguments: JSON.stringify(args) },
        { type: "function_call_output", call_id: callId, output: `verified round ${index}` },
      );
    }

    if (path.endsWith("responses")) {
      control.lease.started = true;
      control.lease.toolLedgerSnapshot = JSON.stringify(completedToolSnapshots(await parseResponsesToolLedger(input)));
    }

    const request = new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify(path.endsWith("responses")
        ? {
            model: "gpt-5.6-sol",
            stream: true,
            previous_response_id: "resp_round_32",
            input: [{ type: "message", role: "user", content: "Continue from the persisted tool evidence" }],
            tools: responseTools,
            tool_choice: "auto",
          }
        : { model: "gpt-5.6-sol", stream: true, messages, tools: chatTools, tool_choice: "auto" }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status, await response.clone().text()).toBe(200);
    const encoded = await response.text();
    expect(encoded).toContain(toolRecoveryTermination("the bounded tool-call limit for this user task has been reached"));
    expect(encoded).toContain(path.endsWith("responses") ? "response.completed" : '"finish_reason":"stop"');
    expect(encoded).toContain("data: [DONE]");
    expect(encoded).not.toContain("upstream_error");
    expect(encoded).not.toContain("response.failed");
    expect(encoded).not.toContain('"finish_reason":"tool_calls"');
    expect(upstreamExchanges).toBe(1);
    expect(control.session.completeFinal).not.toHaveBeenCalled();
    expect(control.session.release).toHaveBeenCalledTimes(1);
  });

  it("terminates a required-tool routing failure after two isolated attempts without entering the answer path", async () => {
    const control = fakeOpenAIControl();
    const upstreamPrompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      let messages = 0;
      server.addEventListener("message", (event) => {
        messages += 1;
        if (messages === 1) {
          server.send(`{}\u001e`);
          return;
        }
        const frame = JSON.parse(String(event.data).split("\u001e")[0]) as {
          arguments: Array<{ message: { text: string } }>;
        };
        upstreamPrompts.push(frame.arguments[0].message.text);
        server.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ writeAtCursor: '{"calls":[]}' }] })}\u001e${JSON.stringify({ type: 3 })}\u001e`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }));

    const request = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "Read C:/workspace/README.md" }],
        tools: [{
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
        }],
        tool_choice: "required",
      }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ finish_reason: "stop", message: { content: toolRecoveryTermination("the tool router did not produce a valid decision after two attempts") } }],
    });
    expect(upstreamPrompts).toHaveLength(2);
    expect(upstreamPrompts[0]).toContain("TOOL_MODE: required");
    expect(upstreamPrompts[1]).toContain("MODE: required");
    expect(control.session.completeFinal).not.toHaveBeenCalled();
    expect(control.session.release).toHaveBeenCalledWith(expect.any(String));
  });

  it(`${incidents.silentLongTurn.id} survives repeated 60-second idle read slices and emits stream heartbeats`, async () => {
    const readTimeouts: number[] = [];
    let reads = 0;
    const frame = await nextChatHubFrame({
      next: async (timeoutMs) => {
        readTimeouts.push(timeoutMs);
        reads += 1;
        if (reads <= 2) throw new Error("WS_READ_TIMEOUT");
        return '{"type":6}\u001e';
      },
    }, Date.now() + 10 * 60_000, 60_000);
    expect(frame).toBe('{"type":6}\u001e');
    expect(readTimeouts).toEqual([60_000, 60_000, 60_000]);

    vi.useFakeTimers();
    const control = fakeOpenAIControl();
    const dial = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async () => dial.promise));
    const request = new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "perform a long task" }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    let settled = false;
    const body = response.text().then((text) => {
      settled = true;
      return text;
    });
    await vi.advanceTimersByTimeAsync(65_001);
    expect(settled).toBe(false);
    dial.resolve(new Response("temporarily unavailable", { status: 503 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const text = await body;
    const progressEvents = text.match(/event: response\.in_progress/gu) ?? [];
    expect(progressEvents.length).toBeGreaterThanOrEqual(14);
  });

  it(`${incidents.preSubmitFailover.id} permits replacement only before submission or visibility`, async () => {
    const session = env.CHATS.getByName(`historical-pre-submit-${crypto.randomUUID()}`);
    const initial = await session.acquire();
    Object.assign(initial, await session.bindAccount(initial.leaseId, "ordered-account-1"));
    const replacement = await session.switchUncommittedAccount(initial.leaseId, initial.accountId, "ordered-account-2");
    expect(replacement.accountId).toBe("ordered-account-2");
    expect(replacement.conversationId).not.toBe(initial.conversationId);
    expect(replacement.sessionId).not.toBe(initial.sessionId);
    await session.release(replacement.leaseId);

    expect(mayReconnectChatHubFailure(new Error("WS_DIAL_FAILED:503"), false)).toBe(true);
    expect(mayFailOverExchange(true, false, false, false, false, Date.now() + 1_000)).toBe(true);
  });

  it(`${incidents.postSubmitReplay.id} never reconnects or changes account after invocation submission`, () => {
    for (const message of [
      "WS_READ_TIMEOUT",
      "WS_CLOSED_BEFORE_COMPLETION:1006",
      "CHAT_COMPLETION_ERROR:503 temporarily unavailable",
    ]) {
      const failure = new ChatHubAttemptError(new Error(message), true);
      expect(chatHubInvocationWasSubmitted(failure), message).toBe(true);
      expect(mayReconnectChatHubFailure(failure, true), message).toBe(false);
      expect(mayFailOverChatHubFailure(failure), message).toBe(false);
      expect(mayFailOverExchange(true, false, false, false, true, Date.now() + 1_000), message).toBe(false);
    }
  });

  it(`${incidents.downstreamCancellation.id} preserves a visible session account and never classifies cancellation for failover`, async () => {
    expect(classifyAccountFailure(new Error("REQUEST_ABORTED"))).toBeNull();
    expect(mayFailOverChatHubFailure(new Error("REQUEST_ABORTED"))).toBe(false);
    expect(mayFailOverExchange(undefined, false, false, false, false, Date.now() + 1_000)).toBe(false);

    const session = env.CHATS.getByName(`historical-cancel-${crypto.randomUUID()}`);
    const active = await session.acquire();
    Object.assign(active, await session.bindAccount(active.leaseId, "sticky-visible-account"));
    await session.markAccountLocked(active.leaseId, active.accountId);
    await session.abandon(active.leaseId);
    const retry = await session.acquire();
    expect(retry.accountId).toBe("sticky-visible-account");
    expect(retry.accountLocked).toBe(true);
    expect(retry.conversationId).not.toBe(active.conversationId);
    await session.release(retry.leaseId);
  });
});

describe("historical tool and Responses continuation regressions", () => {
  it(`${incidents.repeatedSuccessfulAction.id} allows one verification and blocks a third consecutive identical success`, async () => {
    const once = await parseChatToolLedger([
      { role: "user", content: "verify the artifact" },
      chatCall("call-success-1", "inspect", { path: "release.zip" }),
      chatResult("call-success-1", "checksum ok"),
    ]);
    await expect(guardProposedToolCalls([
      { name: "inspect", arguments: { path: "release.zip" } },
    ], once)).resolves.toMatchObject({ allowed: true });

    const twice = await parseChatToolLedger([
      { role: "user", content: "verify the artifact" },
      chatCall("call-success-1", "inspect", { path: "release.zip" }),
      chatResult("call-success-1", "checksum ok"),
      chatCall("call-success-2", "inspect", '{ "path": "release.zip" }'),
      chatResult("call-success-2", "checksum still ok"),
    ]);
    await expect(guardProposedToolCalls([
      { name: "inspect", arguments: { path: "release.zip" } },
    ], twice)).resolves.toMatchObject({ allowed: false, code: "consecutive_fingerprint_limit" });
  });

  it(`${incidents.repeatedFailedAction.id} blocks an unchanged failure but permits a changed diagnostic action`, async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "build the project" },
      chatCall("call-fail-1", "run", { command: "build" }),
      chatResult("call-fail-1", "ERROR: worker 123 timed out; exit code 1"),
      chatCall("call-fail-2", "run", '{ "command": "build" }'),
      chatResult("call-fail-2", "error: worker 456 timed out; exit code 9"),
    ]);
    await expect(guardProposedToolCalls([
      { name: "run", arguments: { command: "build" } },
    ], ledger)).resolves.toMatchObject({ allowed: false, code: "repeated_failure" });
    await expect(guardProposedToolCalls([
      { name: "run", arguments: { command: "inspect logs" } },
    ], ledger)).resolves.toMatchObject({ allowed: true });
  });

  it(`${incidents.fullHistoryContinuation.id} forwards only the pending result and genuinely new input`, () => {
    const fullClientReplay: unknown[] = [
      { role: "system", content: "keep the project contract" },
      { role: "developer", content: "do not repeat side effects" },
      { type: "message", role: "user", content: "old task that is already persisted" },
      { type: "function_call", call_id: "call-old", name: "read", arguments: '{"path":"old"}' },
      { type: "function_call_output", call_id: "call-old", output: "old result" },
      { type: "function_call", call_id: "call-pending", name: "write", arguments: '{"path":"current"}' },
      { type: "function_call_output", call_id: "call-pending", output: "current result" },
      { type: "message", role: "user", content: "now verify the current result" },
    ];
    const active = selectActiveResponsesInput(fullClientReplay, true, {
      previousResponse: true,
      pendingCallId: "call-pending",
    });
    expect(active).toEqual([
      fullClientReplay[0],
      fullClientReplay[1],
      fullClientReplay[6],
      fullClientReplay[7],
    ]);
    const prompt = responsesPrompt(active);
    expect(prompt).toContain("current result");
    expect(prompt).toContain("now verify the current result");
    expect(prompt).not.toContain("old task");
    expect(prompt).not.toContain("old result");
  });

  it(`${incidents.orphanToolResult.id} rejects an orphan before selecting any account`, async () => {
    expect(responsesContinuationOutputIssue([
      { type: "function_call_output", call_id: "call-orphan", output: "done" },
    ], "")).toBe("tool_output_already_consumed");
    const ledger = await parseResponsesToolLedger([
      { type: "function_call_output", call_id: "call-orphan", output: "done" },
    ]);
    expect(ledger.issues).toContainEqual(expect.objectContaining({ code: "unknown_call_id" }));

    const control = fakeOpenAIControl();
    const request = new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{ type: "function_call_output", call_id: "call-orphan", output: "done" }],
      }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unexpected_tool_output" } });
    expect(control.state.selectAccount).not.toHaveBeenCalled();
  });

  it(`${incidents.truncatedResponsesStream.id} emits response.failed, error and [DONE] on terminal upstream failure`, async () => {
    const control = fakeOpenAIControl();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const request = new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer historical-test-key" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "complete the task" }),
    });
    const response = await openAIRequest(request, control.env, new URL(request.url));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(text.match(/event: error/gu)).toHaveLength(1);
    expect(text.match(/data: \[DONE\]/gu)).toHaveLength(1);
    expect(text).not.toContain("access_token");
    expect(control.session.release).toHaveBeenCalledTimes(1);
  });
});

describe("historical FIFO and unused-account isolation regressions", () => {
  it(`${incidents.accountQueueAndIsolation.id} preserves FIFO order and leaves unselected accounts untouched`, async () => {
    const rotation = env.TENANTS.getByName(`historical-rotation-${crypto.randomUUID()}`);
    const rotationA = await rotation.upsertAccount(token(`rotation-a-${crypto.randomUUID()}`));
    const rotationB = await rotation.upsertAccount(token(`rotation-b-${crypto.randomUUID()}`));
    const rotationC = await rotation.upsertAccount(token(`rotation-c-${crypto.randomUUID()}`));
    for (let request = 0; request < 20; request += 1) {
      await expect(rotation.selectAccount()).resolves.toMatchObject({ accountId: rotationA.id, sequence: 1 });
    }
    await rotation.reportAccountFailure(rotationA.id, "transient");
    await expect(rotation.selectAccount("", [rotationA.id])).resolves.toMatchObject({ accountId: rotationB.id, sequence: 2 });
    await rotation.reportAccountFailure(rotationA.id, "transient");
    await expect(rotation.selectAccount()).resolves.toMatchObject({ accountId: rotationB.id, sequence: 2 });
    expect(rotationC.sequence).toBe(3);

    const state = env.TENANTS.getByName(`historical-account-${crypto.randomUUID()}`);
    const accountA = await state.upsertAccount(token(`ordered-a-${crypto.randomUUID()}`));
    const accountB = await state.upsertAccount(token(`unused-b-${crypto.randomUUID()}`));
    const accountC = await state.upsertAccount(token(`unused-c-${crypto.randomUUID()}`));

    await runInDurableObject(state, (_instance, durableState) => {
      // If preferred-account selection accidentally scanned/decrypted every
      // account, this unused corrupted credential would be isolated.
      durableState.storage.sql.exec(
        "UPDATE accounts SET token_cipher='unused-account-must-not-be-read' WHERE id=?",
        accountB.id,
      );
    });
    await expect(state.selectAccount(accountA.id)).resolves.toMatchObject({ accountId: accountA.id });
    await expect(state.accountAvailability(accountB.id)).resolves.toMatchObject({ available: true, isolated: false });
    await expect(state.accountAvailability(accountC.id)).resolves.toMatchObject({ available: true, isolated: false });

    const gateAccount = `fifo-${crypto.randomUUID()}`;
    const active = await state.acquireUpstream(gateAccount, "waiter-1");
    expect(active.ok).toBe(true);
    await expect(state.acquireUpstream(gateAccount, "waiter-2")).resolves.toMatchObject({ ok: false });
    await expect(state.acquireUpstream(gateAccount, "waiter-3")).resolves.toMatchObject({ ok: false });
    await state.releaseUpstream(gateAccount, active.leaseId);
    await accountPace();
    await expect(state.acquireUpstream(gateAccount, "waiter-3")).resolves.toMatchObject({ ok: false });
    const second = await state.acquireUpstream(gateAccount, "waiter-2");
    expect(second.ok).toBe(true);
    await state.releaseUpstream(gateAccount, second.leaseId);
    await accountPace();
    const third = await state.acquireUpstream(gateAccount, "waiter-3");
    expect(third.ok).toBe(true);
    await state.releaseUpstream(gateAccount, third.leaseId);
  }, 15_000);
});
