import { describe, expect, it, vi } from "vitest";
import {
  ChatHubAttemptError,
  appendUpstreamImageURLs,
  appendChatSnapshot,
  chatHub,
  chatPayload,
  chatHubInvocationWasSubmitted,
  clientPlugins,
  mayFailOverChatHubFailure,
  isTerminalEmptyQuotaFailure,
  mayReconnectChatHubFailure,
  nextChatHubFrame,
  parseFunctionCall,
  parseSignalRHandshake,
  parseNativeFunctionCall,
  quotaExhausted,
  socketReader,
} from "../src/chathub";

const tools = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a local file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
}];

describe("ChatHub tool protocol", () => {
  it("keeps the pure-text payload compatible and maps normalized images to attachments", () => {
    const base = {
      text: "describe the image",
      conversationId: "conversation-test",
      sessionId: "session-test",
      started: true,
      tone: "Gpt_5_6_Chat",
    };
    const textPayload = JSON.parse(chatPayload(base, "request-text").split("\u001e")[0]);
    expect(textPayload.arguments[0].message).toMatchObject({
      text: "describe the image",
      attachments: [],
      inputMethod: "Keyboard",
      messageType: "Chat",
    });

    const imagePayload = JSON.parse(chatPayload({
      ...base,
      attachments: [{
        type: "image",
        url: "https://cdn.example.test/photo.png?sig=kept",
        mimeType: "image/*",
        detail: "high",
      }],
    }, "request-image").split("\u001e")[0]);
    expect(imagePayload.arguments[0].message.attachments).toEqual([{
      type: "image",
      url: "https://cdn.example.test/photo.png?sig=kept",
      mimeType: "image/*",
    }]);
  });

  it("rejects invalid and oversized images before dialing ChatHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const account = {
      accessToken: "must-not-be-used",
      refreshToken: "must-not-be-used",
      expiresAt: Date.now() + 60_000,
      email: "image@example.test",
      displayName: "Image Test",
      oid: "image-oid",
      tid: "image-tenant",
    };
    const base = {
      text: "inspect",
      conversationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      started: true,
      tone: "Gpt_5_6_Chat",
    };
    try {
      await expect(chatHub(account, {
        ...base,
        attachments: [{ type: "image", url: "http://127.0.0.1/private.png", mimeType: "image/*", detail: "auto" }],
      })).rejects.toThrow("INVALID_IMAGE");
      const oversizedBase64 = "A".repeat(5_592_408);
      await expect(chatHub(account, {
        ...base,
        attachments: [{ type: "image", url: `data:image/png;base64,${oversizedBase64}`, mimeType: "image/png", detail: "auto" }],
      })).rejects.toThrow("IMAGE_TOO_LARGE");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("collects bounded, de-duplicated image-only ChatHub outputs", () => {
    let images: string[] = [];
    images = appendUpstreamImageURLs(images, {
      arguments: [{ messages: [{ content: { image: { downloadUrl: "https://cdn.example.test/image/one" } } }] }],
    });
    images = appendUpstreamImageURLs(images, {
      item: { result: { imageUrl: "https://cdn.example.test/result-two.webp" } },
    });
    images = appendUpstreamImageURLs(images, {
      duplicate: { thumbnailUrl: "https://cdn.example.test/image/one" },
      unrelated: { url: "https://example.test/article" },
    });
    for (let index = 3; index < 10; index += 1) {
      images = appendUpstreamImageURLs(images, { imageUrl: `https://cdn.example.test/image/${index}` });
    }
    expect(images).toEqual([
      "https://cdn.example.test/image/one",
      "https://cdn.example.test/result-two.webp",
      "https://cdn.example.test/image/3",
      "https://cdn.example.test/image/4",
    ]);
  });

  it("preserves the first semantic delta and emits only the snapshot suffix", () => {
    const deltas: string[] = [];
    let current = appendChatSnapshot("", "Hello", (delta) => deltas.push(delta));
    current = appendChatSnapshot(current, "Hello world", (delta) => deltas.push(delta));
    expect(current).toBe("Hello world");
    expect(deltas).toEqual(["Hello", " world"]);
  });
  it("keeps a silent but connected long task alive until a semantic frame or the global deadline", async () => {
    const next = (() => {
      let reads = 0;
      return async () => {
        reads += 1;
        if (reads <= 2) throw new Error("WS_READ_TIMEOUT");
        return '{"type":6}\u001e';
      };
    })();
    await expect(nextChatHubFrame({ next }, Date.now() + 10_000, 1)).resolves.toBe('{"type":6}\u001e');
  });

  it("uses the 599-second remainder but terminates exactly at the shared 600-second deadline", async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const slices: number[] = [];
    const deadline = now + 600_000;
    const reader = {
      next: async (timeoutMs: number) => {
        slices.push(timeoutMs);
        now += timeoutMs;
        throw new Error("WS_READ_TIMEOUT");
      },
    };

    await expect(nextChatHubFrame(reader, deadline, 599_000)).rejects.toThrow("CHAT_DEADLINE_EXCEEDED");
    expect(slices).toEqual([599_000, 1_000]);
    expect(now).toBe(deadline);
    nowSpy.mockRestore();
  });

  it("does not hide terminal socket failures behind the long-task idle policy", async () => {
    await expect(nextChatHubFrame({
      next: async () => { throw new Error("WS_CLOSED_BEFORE_COMPLETION:1006"); },
    }, Date.now() + 10_000, 1)).rejects.toThrow("WS_CLOSED_BEFORE_COMPLETION:1006");
  });

  it("strictly validates the SignalR handshake and preserves a coalesced first event", () => {
    expect(parseSignalRHandshake(`{}\u001e`)).toBe("");
    expect(parseSignalRHandshake(`{}\u001e{"type":6}\u001e`)).toBe('{"type":6}\u001e');
    expect(() => parseSignalRHandshake(`{"error":"secret https://example.test/?access_token=hidden"}\u001e`))
      .toThrow("WS_HANDSHAKE_FAILED");
    expect(() => parseSignalRHandshake("not-json\u001e")).toThrow("WS_HANDSHAKE_INVALID");
    expect(() => parseSignalRHandshake("\u001e")).toThrow("WS_HANDSHAKE_EMPTY");
    expect(() => parseSignalRHandshake('{"type":6}\u001e')).toThrow("WS_HANDSHAKE_UNEXPECTED_FRAME");
  });

  it("bounds queued WebSocket frames when the upstream outpaces the consumer", async () => {
    const target = new EventTarget() as EventTarget & { close: (code?: number, reason?: string) => void };
    const close = vi.fn();
    target.close = close;
    const reader = socketReader(target as unknown as WebSocket, 10);
    target.dispatchEvent(new MessageEvent("message", { data: "123456" }));
    target.dispatchEvent(new MessageEvent("message", { data: "abcdef" }));

    await expect(reader.next(10)).rejects.toThrow("WS_BUFFER_TOO_LARGE");
    expect(close).toHaveBeenCalledWith(1009, "buffer too large");
  });

  it("reconnects only a pre-submit transport handshake and never replays a submitted invocation", () => {
    for (const retryable of [
      "WS_DIAL_ERROR",
      "WS_DIAL_FAILED:408",
      "WS_DIAL_FAILED:425",
      "WS_DIAL_FAILED:502",
      "WS_READ_TIMEOUT",
      "WS_ERROR_BEFORE_COMPLETION",
      "WS_CLOSED_BEFORE_COMPLETION:1006",
    ]) {
      expect(mayReconnectChatHubFailure(new Error(retryable), false), retryable).toBe(true);
      expect(mayReconnectChatHubFailure(new Error(retryable), true), retryable).toBe(false);
    }
    for (const neverReplay of [
      "WS_DIAL_FAILED:401",
      "WS_DIAL_FAILED:403",
      "WS_DIAL_FAILED:429",
      "WS_FRAME_TOO_LARGE",
      "CHAT_THROTTLED_QUOTA_EXHAUSTED",
      "CHAT_RETURNED_NO_CONTENT",
      "CHAT_COMPLETION_ERROR:protocol failure",
      "CHAT_UPSTREAM_ERROR:rate limited",
      "CHAT_OUTPUT_TOO_LARGE",
      "REQUEST_ABORTED",
      "CHAT_DEADLINE_EXCEEDED",
    ]) {
      expect(mayReconnectChatHubFailure(new Error(neverReplay), false), neverReplay).toBe(false);
    }
  });

  it("allows cross-account failover only before the upstream invocation is submitted", () => {
    expect(mayFailOverChatHubFailure(new ChatHubAttemptError(new Error("WS_DIAL_FAILED:503"), false))).toBe(true);
    for (const postSubmitFailure of [
      "WS_CLOSED_BEFORE_COMPLETION:1006",
      "WS_READ_TIMEOUT",
      "CHAT_COMPLETION_ERROR:503 temporarily unavailable",
    ]) {
      const failure = new ChatHubAttemptError(new Error(postSubmitFailure), true);
      expect(mayFailOverChatHubFailure(failure), postSubmitFailure).toBe(false);
      expect(chatHubInvocationWasSubmitted(failure), postSubmitFailure).toBe(true);
    }
    expect(mayFailOverChatHubFailure(new Error("CHAT_DEADLINE_EXCEEDED"))).toBe(false);
    expect(mayFailOverChatHubFailure(new Error("REQUEST_ABORTED"))).toBe(false);

    const emptyQuota = new ChatHubAttemptError(new Error("CHAT_THROTTLED_QUOTA_EXHAUSTED"), true, true);
    expect(chatHubInvocationWasSubmitted(emptyQuota)).toBe(true);
    expect(isTerminalEmptyQuotaFailure(emptyQuota)).toBe(true);
    expect(mayFailOverChatHubFailure(emptyQuota)).toBe(true);
  });

  it("honors an already-aborted downstream signal before dialing or retrying", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(chatHub({
      accessToken: "not-used",
      refreshToken: "not-used",
      expiresAt: Date.now() + 60_000,
      email: "cancel@example.test",
      displayName: "Cancel Test",
      oid: "cancel-oid",
      tid: "cancel-tenant",
    }, {
      text: "must never be sent",
      conversationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      started: true,
      tone: "Gpt_5_6_Chat",
      signal: controller.signal,
    })).rejects.toThrow("REQUEST_ABORTED");
  });

  it("maps Chat Completions and Responses function tools to native client plugins", () => {
    expect(clientPlugins([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a local file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
      {
        type: "function",
        name: "search",
        description: "Search documents",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      { type: "function", function: { name: "" } },
    ])).toEqual([
      {
        Id: "read_file",
        Source: "Client",
        Description: "Read a local file",
        Parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        Id: "search",
        Source: "Client",
        Description: "Search documents",
        Parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
  });

  it("accepts a declared fenced function call", () => {
    expect(parseFunctionCall('```read_file\n{"path":"C:/work/a.txt"}\n```', tools)).toEqual({
      name: "read_file",
      arguments: '{"path":"C:/work/a.txt"}',
    });
  });

  it("does not invent calls from ordinary prose, unknown names, or invalid JSON", () => {
    expect(parseFunctionCall("I would call read_file now.", tools)).toBeNull();
    expect(parseFunctionCall('```delete_everything\n{"yes":true}\n```', tools)).toBeNull();
    expect(parseFunctionCall("```read_file\nnot-json\n```", tools)).toBeNull();
    expect(parseFunctionCall('```read_file\n{}\n```', tools)).toBeNull();
    expect(parseFunctionCall('```read_file\n{"path":42}\n```', tools)).toBeNull();
  });

  it("accepts common declared tool-call envelopes without accepting unknown tools", () => {
    const expected = { name: "read_file", arguments: '{"path":"C:/work/a.txt"}' };
    expect(parseFunctionCall('```json\n{"name":"read_file","arguments":{"path":"C:/work/a.txt"}}\n```', tools)).toEqual(expected);
    expect(parseFunctionCall('<tool_call>{"function":{"name":"read_file","arguments":"{\\"path\\":\\"C:/work/a.txt\\"}"}}</tool_call>', tools)).toEqual(expected);
    expect(parseFunctionCall('read_file({"path":"C:/work/a.txt"})', tools)).toEqual(expected);
    expect(parseFunctionCall('{"calls":[{"name":"read_file","arguments":{"path":"C:/work/a.txt"}}]}', tools)).toEqual(expected);
    expect(parseFunctionCall('{"tool_calls":[{"function":{"name":"read_file","arguments":"{\\"path\\":\\"C:/work/a.txt\\"}"}}]}', tools)).toEqual(expected);
    expect(parseFunctionCall('{"name":"delete_everything","arguments":{"path":"C:/work/a.txt"}}', tools)).toBeNull();
  });

  it("infers a bare argument object only when the caller selected a declared tool", () => {
    expect(parseFunctionCall('```json\n{"path":"C:/work/a.txt"}\n```', tools)).toBeNull();
    expect(parseFunctionCall('```json\n{"path":"C:/work/a.txt"}\n```', tools, "read_file")).toEqual({
      name: "read_file",
      arguments: '{"path":"C:/work/a.txt"}',
    });
    expect(parseFunctionCall('{"path":"C:/work/a.txt"}', tools, "delete_everything")).toBeNull();
  });

  it("extracts an explicitly declared invocation from nested native ChatHub events", () => {
    const event = {
      type: 1,
      target: "update",
      arguments: [{
        messages: [{
          messageType: "Progress",
          contentType: "ToolCall",
          payload: {
            functionName: "read_file",
            functionArguments: { path: "C:/work/native.txt" },
          },
        }],
      }],
    };
    expect(parseNativeFunctionCall(event, tools)).toEqual({
      name: "read_file",
      arguments: '{"path":"C:/work/native.txt"}',
    });
  });

  it("does not mistake echoed plugin definitions or unknown native calls for an invocation", () => {
    expect(parseNativeFunctionCall({ plugins: clientPlugins(tools) }, tools)).toBeNull();
    expect(parseNativeFunctionCall({ toolName: "delete_everything", arguments: { yes: true } }, tools)).toBeNull();
    expect(parseNativeFunctionCall({ name: "read_file", description: "schema only" }, tools)).toBeNull();
    expect(parseNativeFunctionCall({ functionName: "read_file", functionArguments: {} }, tools)).toBeNull();
    expect(parseNativeFunctionCall({ functionName: "read_file", functionArguments: { path: false } }, tools)).toBeNull();
  });

  it("does not treat an echoed empty-argument plugin schema as a native invocation", () => {
    const emptyTool = [{
      type: "function",
      function: {
        name: "get_current_time",
        description: "Get the current time",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }];
    expect(parseNativeFunctionCall({
      name: "get_current_time",
      description: "Get the current time",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }, emptyTool)).toBeNull();
    expect(parseNativeFunctionCall({ plugins: clientPlugins(emptyTool) }, emptyTool)).toBeNull();
    expect(parseNativeFunctionCall({
      messageType: "Progress",
      contentType: "ToolCall",
      functionName: "get_current_time",
      functionArguments: {},
    }, emptyTool)).toEqual({ name: "get_current_time", arguments: "{}" });
    expect(parseNativeFunctionCall({
      contentType: "ToolCall",
      payload: { name: "get_current_time", parameters: {} },
    }, emptyTool)).toEqual({ name: "get_current_time", arguments: "{}" });
  });

  it("does not mine an example JSON envelope out of ordinary narration", () => {
    const example = 'For example, the client may return {"name":"read_file","arguments":{"path":"C:/work/a.txt"}} after validation.';
    expect(parseFunctionCall(example, tools)).toBeNull();
    expect(parseFunctionCall('Example: read_file({"path":"C:/work/a.txt"})', tools)).toBeNull();
    expect(parseFunctionCall('read_file({"path":"C:/work/a.txt"})', tools)).toEqual({
      name: "read_file",
      arguments: '{"path":"C:/work/a.txt"}',
    });
  });

  it("recognizes only an actually exhausted CostQuota allowance", () => {
    expect(quotaExhausted({ CostQuota: 0 })).toBe(true);
    expect(quotaExhausted({ CostQuota: { remainingAllowance: 0 } })).toBe(true);
    expect(quotaExhausted({ metering: { CostQuota: { remainingAllowance: 0 } } })).toBe(true);
    expect(quotaExhausted({ CostQuota: 1 })).toBe(false);
    expect(quotaExhausted({ throttling: true })).toBe(false);
  });
});
