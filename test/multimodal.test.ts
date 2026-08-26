import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  extractUpstreamImageURLs,
  MultimodalInputError,
  normalizeImageGenerationRequest,
  normalizeMultimodalContent,
  normalizeMultimodalContents,
} from "../src/multimodal";
import {
  assistantVisibleText,
  imageGenerationData,
  openAIRequest,
  prepareChatMultimodal,
  prepareResponsesMultimodal,
} from "../src/openai";
import type { Env } from "../src/types";

function errorCode(action: () => unknown): string {
  try {
    action();
    return "none";
  } catch (cause) {
    return cause instanceof MultimodalInputError ? cause.code : "unexpected";
  }
}

describe("multimodal protocol normalization", () => {
  it("normalizes Chat and Responses image shapes without fetching them", () => {
    const result = normalizeMultimodalContent([
      { type: "text", text: "compare" },
      { type: "image_url", image_url: { url: "https://cdn.example.test/a.png?sig=kept", detail: "high" } },
      { type: "input_image", image_url: "https://cdn.example.test/b", detail: "low" },
    ]);
    expect(result.text).toBe("compare");
    expect(result.attachments).toEqual([
      { type: "image", url: "https://cdn.example.test/a.png?sig=kept", mimeType: "image/*", detail: "high" },
      { type: "image", url: "https://cdn.example.test/b", mimeType: "image/*", detail: "low" },
    ]);
    expect(result.dataImageBytes).toBe(0);
  });

  it("accepts bounded base64 raster images and reports decoded bytes", () => {
    const result = normalizeMultimodalContent([
      { type: "input_text", text: "read" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
    expect(result.attachments[0]).toMatchObject({ mimeType: "image/png", detail: "auto" });
    expect(result.dataImageBytes).toBe(8);
  });

  it("uses the decoded image-byte bound instead of the remote URL-length bound for data images", () => {
    const payload = "A".repeat(16_384);
    const result = normalizeMultimodalContent([{ type: "input_image", image_url: `data:image/png;base64,${payload}` }]);
    expect(result.dataImageBytes).toBe(12_288);
  });

  it.each([
    ["http URL", [{ type: "image_url", image_url: { url: "http://example.test/a.png" } }], "invalid_image"],
    ["embedded credentials", [{ type: "input_image", image_url: "https://user:pass@example.test/a.png" }], "invalid_image"],
    ["loopback URL", [{ type: "image_url", image_url: { url: "https://127.0.0.1/a.png" } }], "invalid_image"],
    ["IPv4-mapped IPv6 URL", [{ type: "image_url", image_url: { url: "https://[::ffff:127.0.0.1]/a.png" } }], "invalid_image"],
    ["SVG data", [{ type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zz4=" }], "invalid_image"],
    ["bad base64", [{ type: "input_image", image_url: "data:image/png;base64,not-base64" }], "invalid_image"],
    ["audio", [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }], "audio_not_supported"],
    ["unknown part", [{ type: "file", file_id: "file-secret" }], "unsupported_content_part"],
  ])("rejects %s explicitly", (_name, content, expected) => {
    expect(errorCode(() => normalizeMultimodalContent(content))).toBe(expected);
  });

  it("bounds image count before any upstream or account access", () => {
    const content = Array.from({ length: 9 }, (_, index) => ({
      type: "input_image",
      image_url: `https://cdn.example.test/${index}.png`,
    }));
    expect(errorCode(() => normalizeMultimodalContent(content))).toBe("too_many_images");
  });

  it("enforces one image-count budget across multiple message contents", () => {
    const eight = normalizeMultimodalContents(Array.from({ length: 8 }, (_, index) => [{
      type: "input_image",
      image_url: `https://cdn.example.test/${index}.png`,
    }]));
    expect(eight.contents).toHaveLength(8);
    expect(eight.attachments).toHaveLength(8);
    expect(errorCode(() => normalizeMultimodalContents([
      ...Array.from({ length: 8 }, (_, index) => [{ type: "input_image", image_url: `https://cdn.example.test/${index}.png` }]),
      [{ type: "input_image", image_url: "https://cdn.example.test/ninth.png" }],
    ]))).toBe("too_many_images");
  });

  it("enforces one decoded-data budget across multiple message contents", () => {
    // Each image is about 3 MiB and below the single-image cap, while their
    // aggregate is just over the six-MiB request cap.
    const base64 = "A".repeat(4_194_312);
    const content = [{ type: "input_image", image_url: `data:image/png;base64,${base64}` }];
    expect(errorCode(() => normalizeMultimodalContents([content, content]))).toBe("image_too_large");
  });

  it("validates image-generation protocol defaults and bounds", () => {
    expect(normalizeImageGenerationRequest({ prompt: "  a quiet harbor  " })).toEqual({
      prompt: "a quiet harbor",
      n: 1,
      size: "auto",
      responseFormat: "url",
    });
    expect(normalizeImageGenerationRequest({
      prompt: "portrait",
      n: 4,
      size: "1024x1792",
      response_format: "b64_json",
    })).toEqual({ prompt: "portrait", n: 4, size: "1024x1792", responseFormat: "b64_json" });
    for (const value of [
      {},
      { prompt: "x", n: 0 },
      { prompt: "x", n: 1.5 },
      { prompt: "x", n: 5 },
      { prompt: "x", size: "512x512" },
      { prompt: "x", response_format: "binary" },
    ]) expect(errorCode(() => normalizeImageGenerationRequest(value))).toBe("invalid_multimodal_content");
  });

  it("extracts only probable, safe image resources from bounded upstream events", () => {
    const first = "https://cdn.example.test/image/1?sig=kept";
    const second = "https://cdn.example.test/result.webp";
    expect(extractUpstreamImageURLs({
      content: { image: { downloadUrl: first, thumbnailUrl: first } },
      citations: [
        { url: "https://example.test/article" },
        { src: second },
        { imageUrl: "http://cdn.example.test/insecure.png" },
        { imageUrl: "https://127.0.0.1/private.png" },
        { imageUrl: "https://user:pass@cdn.example.test/image/credentialed.png" },
      ],
    })).toEqual([first, second]);
  });

  it("caps extracted image resources at four", () => {
    const events = Array.from({ length: 10 }, (_, index) => ({ imageUrl: `https://cdn.example.test/image/${index}` }));
    expect(extractUpstreamImageURLs(events)).toHaveLength(4);
  });

  it("separates Chat image transport from persistent prompt/session text", () => {
    const signed = "https://cdn.example.test/private.png?signature=must-not-persist";
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const prepared = prepareChatMultimodal([{
      role: "user",
      content: [
        { type: "text", text: "describe both images" },
        { type: "image_url", image_url: { url: signed, detail: "high" } },
        { type: "image_url", image_url: { url: data } },
      ],
    }]);

    expect(prepared.attachments).toHaveLength(2);
    expect(prepared.attachments[0]).toMatchObject({ url: signed, detail: "high" });
    const persistent = JSON.stringify(prepared.value);
    expect(persistent).toContain("describe both images");
    expect(persistent).toContain("IMAGE ATTACHMENTS");
    expect(persistent).not.toContain("signature=must-not-persist");
    expect(persistent).not.toContain("iVBORw0KGgo");
  });

  it("accepts Responses top-level image parts but never persists their URLs", () => {
    const prepared = prepareResponsesMultimodal([
      { type: "input_text", text: "read this" },
      { type: "input_image", image_url: "https://cdn.example.test/scan.png?token=private" },
    ]);
    expect(prepared.attachments).toHaveLength(1);
    expect(JSON.stringify(prepared.value)).toContain("IMAGE ATTACHMENTS");
    expect(JSON.stringify(prepared.value)).not.toContain("token=private");
  });

  it("rejects image injection from system, assistant, or tool content", () => {
    for (const role of ["system", "assistant", "tool"]) {
      expect(() => prepareChatMultimodal([{
        role,
        content: [{ type: "image_url", image_url: { url: "https://cdn.example.test/injected.png" } }],
      }])).toThrowError(MultimodalInputError);
    }
    expect(() => prepareResponsesMultimodal([{
      type: "function_call_output",
      call_id: "call_untrusted",
      output: [{ type: "input_image", image_url: "https://cdn.example.test/tool.png" }],
    }])).toThrowError(MultimodalInputError);
  });

  it("returns image-only ChatHub output to compatibility clients", () => {
    expect(assistantVisibleText({
      text: "",
      conversationId: "conversation",
      sessionId: "session",
      requestId: "request",
      images: ["https://cdn.example.test/generated.webp"],
    })).toBe("![Generated image 1](https://cdn.example.test/generated.webp)");
  });

  it("rejects malformed images before selecting or contacting an account", async () => {
    const selectAccount = vi.fn(async () => null);
    const runtime = {
      CHATS: env.CHATS,
      TENANTS: { getByName: () => ({ selectAccount }) },
      TENANT_NAME: `multimodal-invalid-${crypto.randomUUID()}`,
    } as unknown as Env;
    const request = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/private.png" } }] }],
      }),
    });
    const response = await openAIRequest(request, runtime, new URL(request.url));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_image" } });
    expect(selectAccount).not.toHaveBeenCalled();
  });

  it("maps generated image URLs and inline data without fetching resources", () => {
    expect(imageGenerationData([
      "https://cdn.example.test/image/one.png",
      "https://cdn.example.test/image/two.png",
    ], "url", 1)).toEqual([{ url: "https://cdn.example.test/image/one.png" }]);
    expect(imageGenerationData([
      "data:image/png;base64,iVBORw0KGgo=",
    ], "b64_json", 1)).toEqual([{ b64_json: "iVBORw0KGgo=" }]);
    expect(() => imageGenerationData([
      "https://cdn.example.test/image/one.png",
    ], "b64_json", 1)).toThrow("IMAGE_RESPONSE_FORMAT_UNAVAILABLE");
  });

  it("validates image-generation requests before account selection", async () => {
    const selectAccount = vi.fn(async () => null);
    const runtime = {
      CHATS: env.CHATS,
      TENANTS: { getByName: () => ({ selectAccount }) },
      TENANT_NAME: `image-generation-invalid-${crypto.randomUUID()}`,
    } as unknown as Env;
    const request = new Request("https://example.test/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ prompt: "", n: 99 }),
    });
    const response = await openAIRequest(request, runtime, new URL(request.url));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_multimodal_content" } });
    expect(selectAccount).not.toHaveBeenCalled();
  });
});
