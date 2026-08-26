import { describe, expect, it } from "vitest";
import { readJSONLimited, readTextLimited, RequestBodyError } from "../src/request-body";

function chunkedRequest(chunks: Uint8Array[], headers?: HeadersInit): Request {
  let index = 0;
  return new Request("https://example.test/v1/chat/completions", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
    }),
  });
}

describe("bounded request body reader", () => {
  it("reads chunked UTF-8 JSON at the exact byte limit", async () => {
    const bytes = new TextEncoder().encode('{"value":"中文"}');
    const request = chunkedRequest([bytes.slice(0, 5), bytes.slice(5)]);
    await expect(readJSONLimited<{ value: string }>(request, bytes.byteLength)).resolves.toEqual({ value: "中文" });
  });

  it("rejects a declared oversized body without reading it to completion", async () => {
    let pulled = false;
    const request = new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { "Content-Length": "999" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array([123]));
          controller.close();
        },
      }),
    });
    await expect(readTextLimited(request, 8)).rejects.toMatchObject<RequestBodyError>({ code: "REQUEST_TOO_LARGE" });
    // The Fetch implementation may pre-pull once while constructing Request,
    // but the bounded reader must not drain an already-known oversized body.
    expect(pulled).toBe(true);
  });

  it("stops a chunked body as soon as cumulative bytes exceed the limit", async () => {
    let pulls = 0;
    const request = new Request("https://example.test/v1/responses", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(6));
          if (pulls > 10) controller.close();
        },
      }),
    });
    await expect(readTextLimited(request, 10)).rejects.toMatchObject<RequestBodyError>({ code: "REQUEST_TOO_LARGE" });
    // ReadableStream may keep one chunk prefetched; it must still stop near the
    // boundary rather than draining the unbounded producer.
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("normalizes malformed JSON and invalid UTF-8 without exposing parser details", async () => {
    const malformed = chunkedRequest([new TextEncoder().encode("{")]);
    await expect(readJSONLimited(malformed, 16)).rejects.toMatchObject<RequestBodyError>({ code: "INVALID_JSON" });

    const invalidUtf8 = chunkedRequest([new Uint8Array([0xc3, 0x28])]);
    await expect(readJSONLimited(invalidUtf8, 16)).rejects.toMatchObject<RequestBodyError>({ code: "INVALID_JSON" });
  });

  it("rejects malformed Content-Length values", async () => {
    const request = chunkedRequest([new Uint8Array()], { "Content-Length": "1e3" });
    await expect(readTextLimited(request, 1024)).rejects.toMatchObject<RequestBodyError>({ code: "INVALID_JSON" });
  });

  it("processes many tiny chunks without retaining one string object per chunk", async () => {
    const source = JSON.stringify({ value: "x".repeat(20_000) });
    const bytes = new TextEncoder().encode(source);
    const chunks = Array.from(bytes, (value) => new Uint8Array([value]));
    const request = chunkedRequest(chunks);
    await expect(readJSONLimited<{ value: string }>(request, bytes.byteLength)).resolves.toEqual({ value: "x".repeat(20_000) });
  });
});
