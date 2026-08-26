import { describe, expect, it } from "vitest";
import { classifyAccountFailure } from "../src/account-routing";

describe("account failure classification", () => {
  it.each([
    ["WS_DIAL_FAILED:429", "rate_limit"],
    ["CHAT_COMPLETION_ERROR:TooManyRequests", "rate_limit"],
    ["CHAT_UPSTREAM_ERROR:request throttled", "rate_limit"],
    ["CHAT_THROTTLED_QUOTA_EXHAUSTED", "rate_limit"],
    ["WS_DIAL_FAILED:401", "auth"],
    ["MICROSOFT_TOKEN_EXCHANGE_FAILED", "auth"],
    ["ACCOUNT_CREDENTIAL_MISSING", "permanent"],
    ["ACCOUNT_CREDENTIAL_CORRUPT", "permanent"],
    ["ACCOUNT_CREDENTIAL_MIRROR_UNAVAILABLE", "transient"],
    ["WS_READ_TIMEOUT", "transient"],
    ["WS_DIAL_FAILED:503", "transient"],
    ["CHAT_UPSTREAM_ERROR:service temporarily unavailable", "transient"],
  ] as const)("classifies %s as %s", (message, kind) => {
    expect(classifyAccountFailure(new Error(message))).toEqual({ kind, mayFailOverBeforeVisibleOutput: true });
  });

  it.each([
    "REQUEST_ABORTED",
    "ACCOUNT_QUEUE_TIMEOUT",
    "INVALID_REQUEST",
    "TOOL_CALL_GENERATION_FAILED",
    "CHAT_OUTPUT_TOO_LARGE",
    "CHAT_COMPLETION_ERROR:model refused tool call",
    "WS_DIAL_FAILED:400",
  ])("does not rotate accounts for unrelated or ambiguous failure %s", (message) => {
    expect(classifyAccountFailure(new Error(message))).toBeNull();
  });
});
