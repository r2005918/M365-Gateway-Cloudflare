import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { anthropicRequest, convertAnthropicBody } from "../src/anthropic";
import { parseChatToolLedger } from "../src/tool-ledger";
import { openAIRequest } from "../src/openai";
import type { Env } from "../src/types";

const testEnv = {} as Env;

function request(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request("https://example.test/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "test-key" },
    body: JSON.stringify(body),
    signal,
  });
}

function openAIStream(chunks: unknown[]): Response {
  const text = chunks.map((chunk) => chunk === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

function events(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.trim().split(/\n\n/gu).map((block) => {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
    const data = JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}") as Record<string, unknown>;
    return { event, data };
  });
}

describe("Anthropic Messages compatibility", () => {
  it("maps system, text, tools and an exact tool choice into the shared OpenAI path", async () => {
    let bridged: Record<string, unknown> = {};
    const handler = vi.fn(async (incoming: Request) => {
      bridged = await incoming.json<Record<string, unknown>>();
      return Response.json({
        id: "chatcmpl_text123",
        model: "claude-sonnet-reasoning",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      });
    });
    const response = await anthropicRequest(request({
      model: "claude-sonnet-reasoning",
      max_tokens: 2048,
      system: [{ type: "text", text: "Keep project state." }],
      messages: [{ role: "user", content: [{ type: "text", text: "Inspect it." }] }],
      tools: [{ name: "inspect", description: "Inspect a path", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }],
      tool_choice: { type: "tool", name: "inspect" },
    }), testEnv, handler);

    expect(response.status).toBe(200);
    expect(bridged).toMatchObject({
      model: "claude-sonnet-reasoning",
      stream: false,
      messages: [
        { role: "system", content: "Keep project state." },
        { role: "user", content: "Inspect it." },
      ],
      tools: [{ type: "function", function: { name: "inspect", description: "Inspect a path", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "inspect" } },
    });
    await expect(response.json()).resolves.toEqual({
      id: "msg_text123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-reasoning",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 2 },
      m365: { usage_source: "unavailable_from_chathub", usage_values_are_placeholders: true },
    });
  });

  it("round-trips Anthropic tool_use IDs into structured tool_result messages without guessing from text", async () => {
    const firstHandler = vi.fn(async () => Response.json({
      id: "chatcmpl_tool123",
      model: "claude-sonnet",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_exact_789", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {},
    }));
    const first = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Read it" }],
      tools: [{ name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    }), testEnv, firstHandler);
    await expect(first.json()).resolves.toMatchObject({
      content: [{ type: "tool_use", id: "call_exact_789", name: "read_file", input: { path: "README.md" } }],
      stop_reason: "tool_use",
    });

    let bridged: Record<string, unknown> = {};
    const secondHandler = vi.fn(async (incoming: Request) => {
      bridged = await incoming.json<Record<string, unknown>>();
      return Response.json({
        id: "chatcmpl_done",
        model: "claude-sonnet",
        choices: [{ message: { role: "assistant", content: "fixed" }, finish_reason: "stop" }],
      });
    });
    await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Read it" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_exact_789", name: "read_file", input: { path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_exact_789", content: "permission denied", is_error: true }] },
      ],
      tools: [{ name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    }), testEnv, secondHandler);
    expect(bridged.messages).toEqual([
      { role: "user", content: "Read it" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_exact_789", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] },
      { role: "tool", tool_call_id: "call_exact_789", content: "error: permission denied" },
    ]);
  });

  it("emits the Anthropic text-stream protocol in terminal order", async () => {
    const handler = vi.fn(async () => openAIStream([
      { id: "chatcmpl_s", choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      { id: "chatcmpl_s", choices: [{ delta: { content: "hello" }, finish_reason: null }] },
      { id: "chatcmpl_s", choices: [{ delta: { content: " world" }, finish_reason: null }] },
      { id: "chatcmpl_s", choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]));
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "say hello" }],
    }), testEnv, handler);
    const parsed = events(await response.text());
    expect(parsed.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(parsed.filter((event) => event.event === "content_block_delta").map((event) => event.data)).toMatchObject([
      { delta: { type: "text_delta", text: "hello" } },
      { delta: { type: "text_delta", text: " world" } },
    ]);
    expect(parsed.at(-2)?.data).toMatchObject({ delta: { stop_reason: "end_turn" } });
  });

  it("translates shared empty heartbeat chunks into Anthropic ping events", async () => {
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "wait" }],
    }), testEnv, async () => openAIStream([
      { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: null }] },
      { choices: [{ delta: { content: "done" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]));
    const parsed = events(await response.text());
    expect(parsed.map((event) => event.event)).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(parsed[1].data).toEqual({ type: "ping" });
  });

  it("emits tool_use stream blocks with the original call ID and JSON delta", async () => {
    const handler = vi.fn(async () => openAIStream([
      { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_stream_42", type: "function", function: { name: "lookup", arguments: "{\"city\":\"Tokyo\"}" } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]));
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "lookup" }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    }), testEnv, handler);
    const parsed = events(await response.text());
    expect(parsed.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(parsed[1].data).toMatchObject({ content_block: { type: "tool_use", id: "call_stream_42", name: "lookup", input: {} } });
    expect(parsed[2].data).toMatchObject({ delta: { type: "input_json_delta", partial_json: "{\"city\":\"Tokyo\"}" } });
    expect(parsed[4].data).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("uses a stable Anthropic error envelope and never copies arbitrary upstream details", async () => {
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: "continue" }],
    }), testEnv, async () => Response.json({ error: { code: "mystery", message: "secret https://substrate.office.com/?token=hidden" } }, { status: 502 }));
    expect(response.status).toBe(502);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({ type: "error", error: { type: "api_error", message: "Microsoft 365 gateway request failed" } });
    expect(JSON.stringify(body)).not.toContain("substrate.office.com");
    expect(JSON.stringify(body)).not.toContain("hidden");
  });

  it("propagates downstream body cancellation and request abort to the bridged request", async () => {
    let upstreamCancelled = false;
    let bridgedSignal: AbortSignal | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      cancel() { upstreamCancelled = true; },
    });
    const abort = new AbortController();
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "long task" }],
    }, abort.signal), testEnv, async (incoming) => {
      bridgedSignal = incoming.signal;
      return new Response(upstream, { headers: { "Content-Type": "text/event-stream" } });
    });
    const reader = response.body?.getReader();
    await reader?.read(); // message_start
    await reader?.cancel("client left");
    expect(upstreamCancelled).toBe(true);
    abort.abort();
    expect(bridgedSignal?.aborted).toBe(true);
  });

  it("closes the adapted stream when the originating request is aborted", async () => {
    const abort = new AbortController();
    const upstream = new ReadableStream<Uint8Array>({});
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "long task" }],
    }, abort.signal), testEnv, async () => new Response(upstream, { headers: { "Content-Type": "text/event-stream" } }));
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false); // message_start
    abort.abort();
    await expect(reader?.read()).resolves.toMatchObject({ done: true });
  });

  it("turns an upstream close without a terminal chunk into one explicit error event", async () => {
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "long task" }],
    }), testEnv, async () => openAIStream([
      { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      "[DONE]",
    ]));
    const parsed = events(await response.text());
    expect(parsed.map((event) => event.event)).toEqual(["message_start", "error"]);
    expect(parsed[1].data).toEqual({
      type: "error",
      error: { type: "api_error", message: "Microsoft ChatHub disconnected before completion" },
    });
  });

  it("rejects malformed protocol shapes before invoking the shared handler", async () => {
    const handler = vi.fn();
    const response = await anthropicRequest(request({
      model: "claude-sonnet",
      max_tokens: 0,
      messages: [{ role: "user", content: "hello" }],
    }), testEnv, handler);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens must be a positive integer" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("maps bounded-reader malformed and oversized bodies to Anthropic 400/413 errors", async () => {
    const handler = vi.fn();
    const malformed = await anthropicRequest(new Request("https://example.test/v1/messages", {
      method: "POST",
      body: "{",
    }), testEnv, handler);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "request body must be valid JSON" },
    });

    const oversized = await anthropicRequest(new Request("https://example.test/v1/messages", {
      method: "POST",
      headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
      body: "{}",
    }), testEnv, handler);
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "request body exceeds the 8 MiB limit" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes /v1/messages with x-api-key authentication and Anthropic-shaped auth errors", async () => {
    const denied = await SELF.fetch("https://example.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "wrong" },
      body: JSON.stringify({ model: "claude-sonnet", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
    });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({
      type: "error",
      error: { type: "authentication_error", message: "valid API key required" },
    });

    const key = await env.TENANTS.getByName("default").createAPIKey(`anthropic-route-${crypto.randomUUID()}`, 1);
    const malformed = await SELF.fetch("https://example.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key.key },
      body: JSON.stringify({ model: "claude-sonnet", max_tokens: 16, messages: [{ role: "alien", content: "hello" }] }),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(malformed.json()).resolves.toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });

  it("reproduces and blocks repeated failed Anthropic tool actions before account selection", async () => {
    const key = await env.TENANTS.getByName("default").createAPIKey(`anthropic-loop-${crypto.randomUUID()}`, 1);
    const toolUse = (id: string) => ({
      role: "assistant",
      content: [{ type: "tool_use", id, name: "run_build", input: { command: "npm test" } }],
    });
    const failed = (id: string, attempt: number) => ({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: `job ${attempt} exit code 1`, is_error: true }],
    });
    const repeatedBody = {
      model: "claude-sonnet-reasoning",
      max_tokens: 4096,
      tools: [{ name: "run_build", input_schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } }],
      messages: [
        { role: "user", content: "Build the project" },
        toolUse("toolu_first"),
        failed("toolu_first", 123),
        toolUse("toolu_second"),
        failed("toolu_second", 456),
        // The third unchanged proposal is the point at which the gateway must
        // stop the client/model loop without contacting any account.
        toolUse("toolu_third"),
      ],
    };
    const converted = convertAnthropicBody(repeatedBody);
    const ledger = await parseChatToolLedger(converted.openAI.messages);
    expect(ledger.issues).toContainEqual(expect.objectContaining({ code: "repeated_failure" }));
    const direct = await anthropicRequest(request(repeatedBody), env, async (incoming, runtime, url) => {
      const internal = await incoming.clone().json<{ messages: unknown }>();
      const internalLedger = await parseChatToolLedger(internal.messages);
      expect(internalLedger.issues).toContainEqual(expect.objectContaining({ code: "repeated_failure" }));
      return openAIRequest(incoming, runtime, url);
    });
    expect(direct.status).toBe(200);
    await expect(direct.clone().json()).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Tool execution stopped") }],
      stop_reason: "end_turn",
    });
    const repeated = await SELF.fetch("https://example.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key.key },
      body: JSON.stringify(repeatedBody),
    });
    const repeatedPayload = await repeated.json();
    expect(repeated.status).toBe(200);
    expect(repeatedPayload).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Tool execution stopped") }],
      stop_reason: "end_turn",
    });

    const pending = await SELF.fetch("https://example.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key.key },
      body: JSON.stringify({
        model: "claude-sonnet-reasoning",
        max_tokens: 4096,
        tools: [{ name: "run_build", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "Build" }, toolUse("toolu_pending")],
      }),
    });
    expect(pending.status).toBe(409);
    await expect(pending.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "return the pending tool result before requesting another tool call",
      },
    });
  });

  it("keeps conversion deterministic for any/none tool choices", () => {
    expect(convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "x", input_schema: { type: "object" } }],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    }).openAI.tool_choice).toBe("required");
    expect(convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
      tool_choice: { type: "none" },
    }).openAI.tool_choice).toBe("none");
  });
});
