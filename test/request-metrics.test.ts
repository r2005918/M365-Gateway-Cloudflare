import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { estimatePromptTokens } from "../src/models";
import {
  IncrementalTokenEstimate,
  RequestMetricTracker,
  trackBufferedResponse,
  trackStreamingResponse,
} from "../src/request-metrics";
import type { RequestMetricInput } from "../src/types";

function metricSink(records: RequestMetricInput[], failure?: Error) {
  return {
    async recordRequest(input: RequestMetricInput): Promise<void> {
      records.push(input);
      if (failure) throw failure;
    },
  };
}

function testToken(id: string) {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    email: `private-${id}@example.test`,
    displayName: "Private account",
    oid: id,
    tid: "request-metrics-test-tenant",
  };
}

async function readAll(response: Response): Promise<string> {
  return response.text();
}

describe("terminal request metrics", () => {
  it("estimates arbitrarily split text without retaining request or response content", () => {
    const source = "hello, 世界 😀 code_name + 42";
    const estimate = new IncrementalTokenEstimate();
    // Split the emoji's UTF-16 surrogate pair across chunks as a real stream
    // may do when text is decoded incrementally.
    const emojiAt = source.indexOf("😀");
    for (const piece of [source.slice(0, 2), source.slice(2, emojiAt + 1), source.slice(emojiAt + 1)]) estimate.add(piece);

    expect(estimate.value()).toBe(estimatePromptTokens(source));
    expect(JSON.stringify(estimate)).not.toContain(source);
    expect(JSON.stringify(estimate)).not.toContain("hello");
  });

  it("snapshots the final account, duration and token estimates exactly once", async () => {
    const records: RequestMetricInput[] = [];
    let now = 1_000;
    const waits: Promise<void>[] = [];
    const tracker = new RequestMetricTracker({
      requestId: "opaque-request-1",
      sink: metricSink(records),
      startedAt: 900,
      now: () => now,
      accountId: "account-old",
      waitUntil: (promise) => waits.push(promise),
    });
    tracker.observeInputText("hello world");
    tracker.observeOutputText("你");
    tracker.observeOutputText("好");
    tracker.setAccountId("account-final");
    now = 1_275;

    const first = tracker.complete(200);
    const second = tracker.error(503);
    const third = tracker.cancel(499);
    expect(second).toBe(first);
    expect(third).toBe(first);
    await first;

    expect(waits).toEqual([first]);
    expect(records).toEqual([{
      requestId: "opaque-request-1",
      accountId: "account-final",
      status: 200,
      semanticStatus: "complete",
      durationMs: 375,
      tokenIn: 3,
      tokenOut: 2,
    }]);
    expect(tracker.semanticStatus).toBe("complete");
  });

  it("does not keep sensitive input, output, credentials, emails or URLs in a metric", async () => {
    const records: RequestMetricInput[] = [];
    const tracker = new RequestMetricTracker({ requestId: "opaque-request-2", sink: metricSink(records) });
    tracker.setAccountId("account-safe-id");
    tracker.observeInputText("Authorization: Bearer m365_private_key https://host.test/path?token=secret");
    tracker.observeOutputText("private.person@example.test");
    await tracker.complete(200);

    const persisted = JSON.stringify(records);
    expect(persisted).not.toContain("m365_private_key");
    expect(persisted).not.toContain("private.person@example.test");
    expect(persisted).not.toContain("host.test");
    expect(Object.keys(records[0]).sort()).toEqual([
      "accountId",
      "durationMs",
      "requestId",
      "semanticStatus",
      "status",
      "tokenIn",
      "tokenOut",
    ]);
  });

  it("waits for streaming EOF instead of recording when the Response is constructed", async () => {
    const records: RequestMetricInput[] = [];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("terminal payload"));
        controller.close();
      },
    });
    const tracker = new RequestMetricTracker({ requestId: "stream-complete", sink: metricSink(records) });
    const tracked = trackStreamingResponse(new Response(source, { status: 200 }), tracker);

    await Promise.resolve();
    expect(records).toHaveLength(0);
    await expect(readAll(tracked)).resolves.toBe("terminal payload");
    await tracker.settled;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 200, semanticStatus: "complete" });
  });

  it("records source errors as semantic errors even when SSE HTTP status is 200", async () => {
    const records: RequestMetricInput[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull() { throw new Error("secret upstream failure"); },
    });
    const tracker = new RequestMetricTracker({ requestId: "stream-error", sink: metricSink(records) });
    const tracked = trackStreamingResponse(new Response(source, { status: 200 }), tracker);

    await expect(readAll(tracked)).rejects.toThrow("secret upstream failure");
    await tracker.settled;
    expect(records).toEqual([expect.objectContaining({ status: 200, semanticStatus: "error" })]);
    expect(JSON.stringify(records)).not.toContain("secret upstream failure");
  });

  it("records downstream cancellation once and propagates cancellation upstream", async () => {
    const records: RequestMetricInput[] = [];
    const upstreamCancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { upstreamCancelled(); },
    });
    const tracker = new RequestMetricTracker({ requestId: "stream-cancel", sink: metricSink(records) });
    const tracked = trackStreamingResponse(new Response(source, { status: 200 }), tracker);

    await tracked.body?.cancel("private downstream reason");
    await tracker.settled;
    expect(upstreamCancelled).toHaveBeenCalledOnce();
    expect(records).toEqual([expect.objectContaining({ status: 200, semanticStatus: "cancel" })]);
    expect(JSON.stringify(records)).not.toContain("private downstream reason");
  });

  it("allows an explicit in-band stream error to win over a later clean EOF", async () => {
    const records: RequestMetricInput[] = [];
    const tracker = new RequestMetricTracker({ requestId: "sse-in-band-error", sink: metricSink(records) });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: error\n\n"));
        void tracker.error(200);
        controller.close();
      },
    });
    const tracked = trackStreamingResponse(new Response(source, { status: 200 }), tracker);
    await readAll(tracked);
    await tracker.settled;

    expect(records).toEqual([expect.objectContaining({ status: 200, semanticStatus: "error" })]);
  });

  it("finishes buffered responses immediately and never propagates storage errors", async () => {
    const records: RequestMetricInput[] = [];
    const onRecordError = vi.fn();
    const tracker = new RequestMetricTracker({
      requestId: "buffered-error",
      sink: metricSink(records, new Error("database includes a private value")),
      onRecordError,
    });
    const response = new Response("bad request", { status: 400 });

    expect(trackBufferedResponse(response, tracker)).toBe(response);
    await expect(tracker.settled).resolves.toBeUndefined();
    expect(onRecordError).toHaveBeenCalledOnce();
    expect(records).toEqual([expect.objectContaining({ status: 400, semanticStatus: "error" })]);
  });

  it("persists semantic status, duration and pseudonymous account attribution in TenantState", async () => {
    const state = env.TENANTS.getByName(`terminal-metrics-${crypto.randomUUID()}`);
    const emailMarker = `metric-private-${crypto.randomUUID()}`;
    const account = await state.upsertAccount(testToken(emailMarker));
    let now = 4_000;
    const tracker = new RequestMetricTracker({
      requestId: `metric-${crypto.randomUUID()}`,
      sink: state,
      startedAt: 1_000,
      now: () => now,
    });
    tracker.setAccountId(account.id);
    tracker.observeInputText("abcde");
    tracker.observeOutputText("响应");
    now = 4_450;
    await tracker.error(200);

    await expect(state.statsSnapshot()).resolves.toMatchObject({
      totalRequestCount: 1,
      totalErrorCount: 1,
      totalTokenIn: 2,
      totalTokenOut: 2,
    });
    const records = await state.listRequestMetrics();
    expect(records).toEqual([{
      recordedAt: expect.any(String),
      accountRef: expect.any(String),
      httpStatus: 200,
      semanticStatus: "error",
      durationMs: 3_450,
      tokenIn: 2,
      tokenOut: 2,
    }]);
    expect(records[0].accountRef).not.toBe(account.id);
    expect(JSON.stringify(records)).not.toContain(emailMarker);
    await expect(state.listAccounts()).resolves.toEqual([
      expect.objectContaining({ id: account.id, requestCount: 1, errorCount: 1, tokenIn: 2, tokenOut: 2 }),
    ]);
  });

  it("counts failures before account routing globally and keeps idempotency in Durable Object storage", async () => {
    const state = env.TENANTS.getByName(`unrouted-metrics-${crypto.randomUUID()}`);
    const requestId = `unrouted-${crypto.randomUUID()}`;
    await state.recordRequest({
      requestId,
      accountId: null,
      status: 401,
      semanticStatus: "error",
      durationMs: 12,
      tokenIn: 0,
      tokenOut: 0,
    });
    await state.recordRequest({
      requestId,
      accountId: "private.person@example.test",
      status: 200,
      semanticStatus: "complete",
      durationMs: 999,
      tokenIn: 999,
      tokenOut: 999,
    });

    await expect(state.statsSnapshot()).resolves.toMatchObject({ totalRequestCount: 1, totalErrorCount: 1 });
    const records = await state.listRequestMetrics();
    expect(records).toEqual([expect.objectContaining({
      accountRef: null,
      httpStatus: 401,
      semanticStatus: "error",
      durationMs: 12,
    })]);
    expect(JSON.stringify(records)).not.toContain("private.person@example.test");
  });
});
