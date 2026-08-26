import { afterEach, describe, expect, it, vi } from "vitest";
import protocolCorpus from "../testdata/m365-signalr-fixtures.json";
import {
  chatHub,
  chatHubInvocationWasSubmitted,
  isTerminalEmptyQuotaFailure,
  mayFailOverChatHubFailure,
} from "../src/chathub";
import type { OAuthTokenSet } from "../src/types";

interface FixtureExpectation {
  outcome: "success" | "empty_quota" | "completion_error" | "closed" | "transport_error";
  text?: string;
  tool_name?: string;
  image_count?: number;
  invocation_submitted: boolean;
  may_fail_over?: boolean;
  attempts?: number;
}

interface ProtocolFixture {
  id: string;
  handshake: unknown[];
  frames: unknown[];
  tools?: unknown[];
  close_after_submit?: boolean;
  expect: FixtureExpectation;
}

const fixtures = protocolCorpus as { schema_version: number; cases: ProtocolFixture[] };
const RS = "\u001e";

function fixtureWire(parts: readonly unknown[]): string {
  return parts.map((part) => `${typeof part === "string" ? part : JSON.stringify(part)}${RS}`).join("");
}

function token(): OAuthTokenSet {
  return {
    accessToken: "sanitized-fixture-access",
    refreshToken: "sanitized-fixture-refresh",
    expiresAt: Date.now() + 60_000,
    email: "fixture@example.test",
    displayName: "Protocol Fixture",
    oid: "fixture-oid",
    tid: "fixture-tenant",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared sanitized SignalR protocol fixtures", () => {
  it("uses the supported fixture schema", () => {
    expect(fixtures.schema_version).toBe(1);
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of fixtures.cases) {
    it(fixture.id, async () => {
      let attempts = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        let messages = 0;
        server.addEventListener("message", () => {
          messages += 1;
          if (messages === 1) {
            server.send(fixtureWire(fixture.handshake));
            return;
          }
          attempts += 1;
          if (fixture.close_after_submit) {
            server.close(1011, "sanitized fixture drop");
            return;
          }
          server.send(fixtureWire(fixture.frames));
        });
        return new Response(null, { status: 101, webSocket: client });
      }));

      let result: Awaited<ReturnType<typeof chatHub>> | undefined;
      let failure: unknown;
      try {
        result = await chatHub(token(), {
          text: "fixture",
          conversationId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          started: true,
          tone: "Gpt_5_6_Chat",
          tools: fixture.tools,
          deadlineAt: Date.now() + 10_000,
        });
      } catch (cause) {
        failure = cause;
      }

      if (fixture.expect.outcome === "success") {
        expect(failure).toBeUndefined();
        expect(result?.text).toBe(fixture.expect.text ?? "");
        if (fixture.expect.tool_name) expect(result?.functionCall?.name).toBe(fixture.expect.tool_name);
        expect(result?.images?.length ?? 0).toBe(fixture.expect.image_count ?? 0);
      } else {
        expect(failure).toBeDefined();
        expect(chatHubInvocationWasSubmitted(failure)).toBe(fixture.expect.invocation_submitted);
        expect(mayFailOverChatHubFailure(failure)).toBe(fixture.expect.may_fail_over ?? false);
        if (fixture.expect.outcome === "empty_quota") expect(isTerminalEmptyQuotaFailure(failure)).toBe(true);
      }

      if (fixture.expect.attempts) expect(attempts).toBe(fixture.expect.attempts);
    });
  }
});
