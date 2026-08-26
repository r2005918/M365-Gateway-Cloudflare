import { afterEach, describe, expect, it, vi } from "vitest";
import { base64url } from "../src/crypto";
import { chatHub, type ChatHubRelay } from "../src/chathub";
import type { OAuthTokenSet } from "../src/types";

const RS = "\u001e";
const encoder = new TextEncoder();
const relaySecret = "test-only-fixed-relay-secret-with-more-than-32-characters";

function account(): OAuthTokenSet {
  return {
    accessToken: `test-only-relay-access-${"a".repeat(32)}`,
    refreshToken: `test-only-relay-refresh-${"r".repeat(32)}`,
    expiresAt: Date.now() + 3_600_000,
    email: "relay-account@example.test",
    displayName: "Relay account",
    oid: "11111111-2222-4333-8444-555555555555",
    tid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  };
}

function relay(overrides: Partial<ChatHubRelay> = {}): ChatHubRelay {
  return {
    baseURL: "https://relay-five.example.test",
    hmacSecret: relaySecret,
    origin: "https://candidate.example.test",
    ...overrides,
  };
}

async function expectedSignature(canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(relaySecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical))));
}

afterEach(() => vi.unstubAllGlobals());

describe("fixed-target relay egress", () => {
  it("signs the repository relay protocol and keeps the access token out of every URL", async () => {
    const selected = account();
    let capturedURL = "";
    let capturedHeaders = new Headers();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedURL = String(input);
      capturedHeaders = new Headers(init?.headers);
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      let messages = 0;
      server.addEventListener("message", () => {
        messages += 1;
        if (messages === 1) server.send(`{}${RS}`);
        if (messages === 2) {
          server.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ writeAtCursor: "relay ok" }] })}${RS}${JSON.stringify({ type: 3 })}${RS}`);
        }
      });
      return new Response(null, { status: 101, webSocket: client });
    }));

    const result = await chatHub(selected, {
      text: "relay protocol test",
      conversationId: "conversation-test",
      sessionId: "session-test",
      started: true,
      tone: "Gpt_5_6_Chat",
      deadlineAt: Date.now() + 10_000,
    }, undefined, relay());

    expect(result.text).toBe("relay ok");
    expect(capturedURL).toBe(`https://relay-five.example.test/v1/chathub/${selected.oid}@${selected.tid}`);
    expect(capturedURL).not.toContain(selected.accessToken);
    expect(capturedURL).not.toContain("access_token");
    expect(capturedHeaders.get("Origin")).toBe("https://candidate.example.test");
    expect(capturedHeaders.get("X-M365-Access-Token")).toBe(selected.accessToken);
    const targetQuery = capturedHeaders.get("X-M365-Target-Query") ?? "";
    const parsedQuery = new URLSearchParams(targetQuery);
    expect(parsedQuery.has("access_token")).toBe(false);
    expect(parsedQuery.get("X-SessionId")).toBe("session-test");
    expect(parsedQuery.get("ConversationId")).toBe("conversation-test");

    const digestInput = `token:${encoder.encode(selected.accessToken).byteLength}:${selected.accessToken}\nquery:${encoder.encode(targetQuery).byteLength}:${targetQuery}`;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(digestInput))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(capturedHeaders.get("X-Relay-Content-SHA256")).toBe(digest);
    const timestamp = capturedHeaders.get("X-Relay-Timestamp") ?? "";
    const nonce = capturedHeaders.get("X-Relay-Nonce") ?? "";
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22,128}$/u);
    const path = `/v1/chathub/${selected.oid}@${selected.tid}`;
    const canonical = ["M365-RELAY-V1", timestamp, nonce, "GET", path, "https://candidate.example.test", digest].join("\n");
    await expect(expectedSignature(canonical)).resolves.toBe(capturedHeaders.get("X-Relay-Signature"));
  });

  it.each([
    ["plain HTTP relay", { baseURL: "http://relay.example.test" }],
    ["relay URL with credentials", { baseURL: "https://user:pass@relay.example.test" }],
    ["relay URL with attacker path", { baseURL: "https://relay.example.test/arbitrary" }],
    ["non-origin caller value", { origin: "https://candidate.example.test/path" }],
    ["short relay secret", { hmacSecret: "short" }],
  ])("fails closed before fetch for %s", async (_label, overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatHub(account(), {
      text: "must not dial",
      conversationId: "conversation-test",
      sessionId: "session-test",
      started: true,
      tone: "Gpt_5_6_Chat",
      deadlineAt: Date.now() + 1_000,
    }, undefined, relay(overrides))).rejects.toThrow("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
