import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Durable Object ChatHub runner", () => {
  it("executes the ChatHub boundary in the DO and preserves structured failure state", async () => {
    const runner = env.CHATS.getByName(`durable-chathub-${crypto.randomUUID()}`);
    const outcome = await runner.runChatHub({
      accessToken: "not-used",
      refreshToken: "not-used",
      expiresAt: Date.now() + 60_000,
      email: "runner@example.test",
      displayName: "Runner Test",
      oid: crypto.randomUUID(),
      tid: crypto.randomUUID(),
    }, {
      text: "inspect",
      conversationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      started: true,
      tone: "Gpt_5_6_Chat",
      attachments: [{
        type: "image",
        url: "http://127.0.0.1/private.png",
        mimeType: "image/*",
        detail: "auto",
      }],
    });

    expect(outcome).toEqual({
      ok: false,
      failure: {
        message: "INVALID_IMAGE",
        invocationSubmitted: false,
        terminalEmptyQuota: false,
      },
    });
  });
});
