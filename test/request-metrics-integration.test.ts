import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicRequest } from "../src/anthropic";
import type { ChatLease } from "../src/chat-session";
import worker from "../src/index";
import { openAIRequest } from "../src/openai";
import { RequestMetricTracker, trackStreamingResponse } from "../src/request-metrics";
import type { Env, OAuthTokenSet, RequestMetricInput } from "../src/types";

function context(pending: Promise<unknown>[]): ExecutionContext {
  return { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
}

function scopedEnv(tenantName: string): Env {
  return {
    TENANTS: env.TENANTS,
    CHATS: env.CHATS,
    SENSITIVE_KV: env.SENSITIVE_KV,
    ASSETS: env.ASSETS,
    DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY,
    ENVIRONMENT: "test",
    TENANT_NAME: tenantName,
    BOOTSTRAP_ADMIN_PASSWORD: "admin888",
    MAX_ACCOUNTS: "8",
    M365_CLIENT_ID: "test-client",
    M365_AUTHORITY: "https://login.microsoftonline.com/common",
    M365_REDIRECT_URI: "https://login.microsoftonline.com/common/oauth2/nativeclient",
    M365_SCOPE: "openid",
  };
}

function repeatedToolBody(stream = true): Record<string, unknown> {
  const call = (id: string) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "run", arguments: '{"command":"build"}' } }],
  });
  const result = (id: string, job: number) => ({ role: "tool", tool_call_id: id, content: `error: job ${job} failed` });
  return {
    model: "gpt-5.6-sol",
    stream,
    tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }],
    messages: [
      { role: "user", content: "build the project" },
      call("call_1"),
      result("call_1", 1),
      call("call_2"),
      result("call_2", 2),
      call("call_3"),
    ],
  };
}

function token(id: string): OAuthTokenSet {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    email: `${id}@example.test`,
    displayName: id,
    oid: id,
    tid: "metric-integration-tenant",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request metrics main-path integration", () => {
  it("records an authentication failure once without an account or secret material", async () => {
    const metrics: RequestMetricInput[] = [];
    const diagnostics: unknown[] = [];
    const state = {
      validAPIKey: vi.fn(async () => false),
      recordRequest: vi.fn(async (input: RequestMetricInput) => { metrics.push(input); }),
      recordDiagnostic: vi.fn(async (input: unknown) => { diagnostics.push(input); }),
    };
    const runtime = {
      TENANTS: { getByName: () => state },
      TENANT_NAME: "auth-failure",
    } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(new Request("https://example.test/v1/models?api_key=must-not-persist", {
      headers: { Authorization: "Bearer private-api-key" },
    }), runtime, context(pending));
    expect(response.status).toBe(401);
    await Promise.all(pending);

    expect(metrics).toEqual([expect.objectContaining({
      accountId: null,
      status: 401,
      semanticStatus: "error",
      tokenIn: 0,
      tokenOut: 0,
    })]);
    expect(diagnostics).toEqual([expect.objectContaining({
      path: "/v1/models",
      status: 401,
      code: "terminal_error",
    })]);
    expect(JSON.stringify({ metrics, diagnostics })).not.toContain("must-not-persist");
    expect(JSON.stringify({ metrics, diagnostics })).not.toContain("private-api-key");
  });

  it("records malformed JSON before account selection as an unattributed terminal error", async () => {
    const tenantName = `metric-invalid-json-${crypto.randomUUID()}`;
    const runtime = scopedEnv(tenantName);
    const state = runtime.TENANTS.getByName(tenantName);
    const key = await state.createAPIKey("metric-invalid-json", 1);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: "{private malformed request",
    }), runtime, context(pending));

    expect(response.status).toBe(400);
    await Promise.all(pending);
    const records = await state.listRequestMetrics();
    expect(records).toEqual([expect.objectContaining({
      accountRef: null,
      httpStatus: 400,
      semanticStatus: "error",
      tokenIn: 0,
      tokenOut: 0,
    })]);
    expect(JSON.stringify(records)).not.toContain("private malformed request");
  });

  it("does not record a streamed local terminal response until real EOF", async () => {
    const tenantName = `metric-stream-${crypto.randomUUID()}`;
    const runtime = scopedEnv(tenantName);
    const state = runtime.TENANTS.getByName(tenantName);
    const key = await state.createAPIKey("metric-stream", 1);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify(repeatedToolBody(true)),
    }), runtime, context(pending));

    expect(response.status).toBe(200);
    await Promise.resolve();
    await expect(state.listRequestMetrics()).resolves.toHaveLength(0);
    const body = await response.text();
    expect(body).toContain("Tool execution stopped");
    await Promise.all(pending);

    const records = await state.listRequestMetrics();
    expect(records).toEqual([expect.objectContaining({
      accountRef: null,
      httpStatus: 200,
      semanticStatus: "complete",
    })]);
    expect(records[0].tokenIn).toBeGreaterThan(0);
    expect(records[0].tokenOut).toBeGreaterThan(0);
    await expect(state.listDiagnostics()).resolves.toEqual([
      expect.objectContaining({ path: "/v1/chat/completions", status: 200, code: "terminal_complete" }),
    ]);
  });

  it("records a fully produced non-streaming response as a completed terminal", async () => {
    const tenantName = `metric-buffered-${crypto.randomUUID()}`;
    const runtime = scopedEnv(tenantName);
    const state = runtime.TENANTS.getByName(tenantName);
    const key = await state.createAPIKey("metric-buffered", 1);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify(repeatedToolBody(false)),
    }), runtime, context(pending));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ finish_reason: "stop", message: { content: expect.stringContaining("Tool execution stopped") } }],
    });
    await Promise.all(pending);
    await expect(state.listRequestMetrics()).resolves.toEqual([
      expect.objectContaining({
        accountRef: null,
        httpStatus: 200,
        semanticStatus: "complete",
        tokenIn: expect.any(Number),
        tokenOut: expect.any(Number),
      }),
    ]);
  });

  it("records client cancellation instead of completion for a wrapped /v1 stream", async () => {
    const tenantName = `metric-cancel-${crypto.randomUUID()}`;
    const runtime = scopedEnv(tenantName);
    const state = runtime.TENANTS.getByName(tenantName);
    const key = await state.createAPIKey("metric-cancel", 1);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify(repeatedToolBody(true)),
    }), runtime, context(pending));

    await response.body?.cancel("private cancellation reason");
    await Promise.all(pending);
    const records = await state.listRequestMetrics();
    expect(records).toEqual([expect.objectContaining({ httpStatus: 200, semanticStatus: "cancel" })]);
    expect(JSON.stringify(records)).not.toContain("private cancellation reason");
  });

  it("attributes a terminal stream error to the final failover account exactly once", async () => {
    const records: RequestMetricInput[] = [];
    const tracker = new RequestMetricTracker({
      requestId: "failover-terminal-metric",
      sink: { recordRequest: async (input) => { records.push(input); } },
    });
    const first = { accountId: "account-1", sequence: 1, routeEpoch: 1, token: token("account-1") };
    const second = { accountId: "account-2", sequence: 2, routeEpoch: 2, token: token("account-2") };
    const selections = [first, second];
    const lease: ChatLease = {
      leaseId: "lease-failover",
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
      portableProtocolTail: "",
    };
    const state = {
      selectAccount: vi.fn(async () => selections.shift() ?? null),
      accountAvailability: vi.fn(async () => ({ available: true, retryAfterMs: 0, isolated: false })),
      accountPoolStatus: vi.fn(async () => ({ total: 2, available: 2, cooling: 0, isolated: 0, retryAfterMs: 0 })),
      acquireUpstream: vi.fn(async () => ({ ok: true, leaseId: crypto.randomUUID(), retryAfterMs: 0 })),
      cancelUpstreamWaiter: vi.fn(async () => undefined),
      releaseUpstream: vi.fn(async () => undefined),
      reportAccountFailure: vi.fn(async () => undefined),
      reportAccountSuccess: vi.fn(async () => undefined),
    };
    const session = {
      acquire: vi.fn(async () => ({ ...lease })),
      bindAccount: vi.fn(async (leaseId: string, accountId: string) => ({ ...lease, leaseId, accountId })),
      release: vi.fn(async () => undefined),
      abandon: vi.fn(async () => undefined),
      markAccountLocked: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      switchUncommittedAccount: vi.fn(async (leaseId: string, _old: string, accountId: string) => ({
        ...lease,
        leaseId,
        accountId,
        conversationId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
      })),
      mergeTaskAnchors: vi.fn(async (_leaseId: string, anchors: ChatLease["taskAnchors"]) => anchors),
    };
    const runtime = {
      TENANTS: { getByName: () => state },
      CHATS: { getByName: () => session },
      TENANT_NAME: "metric-failover",
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const request = new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "complete a long task" }),
    });

    const upstream = await openAIRequest(request, runtime, new URL(request.url), tracker);
    const tracked = trackStreamingResponse(upstream, tracker);
    const body = await tracked.text();
    await tracker.settled;

    expect(body).toContain("response.failed");
    expect(session.switchUncommittedAccount).toHaveBeenCalledOnce();
    expect(records).toEqual([expect.objectContaining({
      accountId: "account-2",
      status: 200,
      semanticStatus: "error",
    })]);
    expect(records[0].tokenIn).toBeGreaterThan(0);
  });

  it("turns a malformed Anthropic adapter stream into one semantic error metric", async () => {
    const records: RequestMetricInput[] = [];
    const tracker = new RequestMetricTracker({
      requestId: "anthropic-invalid-stream",
      sink: { recordRequest: async (input) => { records.push(input); } },
    });
    const handler = vi.fn(async () => new Response("data: {not-json}\n\ndata: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const request = new Request("https://example.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    const response = await anthropicRequest(request, {} as Env, handler, tracker);
    const tracked = trackStreamingResponse(response, tracker);
    expect(await tracked.text()).toContain("event: error");
    await tracker.settled;
    expect(records).toEqual([expect.objectContaining({ status: 200, semanticStatus: "error" })]);
  });
});
