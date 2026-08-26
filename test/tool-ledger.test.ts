import { describe, expect, it } from "vitest";
import {
  HARD_MAX_CONSECUTIVE_FINGERPRINTS,
  HARD_MAX_TOOL_ROUNDS,
  completedEvidenceContext,
  completedToolSnapshots,
  guardProposedToolCalls,
  normalizeToolArguments,
  parseChatToolLedger,
  parseResponsesToolLedger,
  toolCallFingerprint,
} from "../src/tool-ledger";

function chatCall(id: string, name: string, argumentsValue: unknown): Record<string, unknown> {
  return {
    role: "assistant",
    tool_calls: [{ id, type: "function", function: { name, arguments: argumentsValue } }],
  };
}

function chatResult(id: string, content: unknown): Record<string, unknown> {
  return { role: "tool", tool_call_id: id, content };
}

describe("tool ledger protocol parsing", () => {
  it("normalizes JSON arguments and produces a stable name-plus-arguments fingerprint", async () => {
    expect(normalizeToolArguments('{ "b": 2, "a": [3, 1] }')).toBe('{"a":[3,1],"b":2}');
    const first = await toolCallFingerprint("lookup", '{ "b": 2, "a": 1 }');
    const reordered = await toolCallFingerprint("lookup", { a: 1, b: 2 });
    const differentArguments = await toolCallFingerprint("lookup", { a: 2, b: 2 });
    const differentTool = await toolCallFingerprint("write", { a: 1, b: 2 });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(differentArguments).not.toBe(first);
    expect(differentTool).not.toBe(first);
  });

  it("pairs structured Chat calls and results without interpreting message text", async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "please inspect" },
      chatCall("call_1", "inspect", '{"path":"a"}'),
      chatResult("call_1", "done"),
      {
        role: "user",
        content: 'ordinary prose: {"tool_calls":[{"id":"fake"}]} and tool result for call_fake',
      },
    ], { activeChatTurnOnly: false });
    expect(ledger.roundCount).toBe(1);
    expect(ledger.completed).toHaveLength(1);
    expect(ledger.completed[0]).toMatchObject({ callId: "call_1", name: "inspect", result: "done", failed: false });
    expect(ledger.pending).toHaveLength(0);
    expect(ledger.issues).toEqual([]);
  });

  it("pairs Responses calls/results and supports a persisted pending call seed", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call_output", call_id: "call_prior", output: [{ type: "output_text", text: "42" }] },
    ], {
      seed: [{ callId: "call_prior", name: "get_answer", arguments: { question: "life" } }],
    });
    expect(ledger.completed).toHaveLength(1);
    expect(ledger.completed[0]).toMatchObject({ callId: "call_prior", name: "get_answer", result: "42" });
    expect(ledger.consumedCallIds).toEqual(["call_prior"]);
    expect(ledger.issues).toEqual([]);
  });

  it("persists only non-reversible bounded retry state across Responses aliases", async () => {
    const first = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_secret", name: "lookup", arguments: { api_key: "m365_do-not-store-this", id: 7 } },
      { type: "function_call_output", call_id: "call_secret", output: "private result payload" },
    ]);
    const snapshots = completedToolSnapshots(first);
    expect(JSON.stringify(snapshots)).not.toContain("do-not-store-this");
    expect(JSON.stringify(snapshots)).not.toContain("private result payload");

    const continued = await parseResponsesToolLedger([], { completedSnapshots: snapshots });
    const decision = await guardProposedToolCalls([{ name: "lookup", arguments: { id: 7, api_key: "m365_do-not-store-this" } }], continued);
    expect(decision).toMatchObject({ allowed: true });

    const second = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_retry", name: "lookup", arguments: { id: 7, api_key: "m365_do-not-store-this" } },
      { type: "function_call_output", call_id: "call_retry", output: "updated result" },
    ], { completedSnapshots: snapshots });
    const third = await parseResponsesToolLedger([], { completedSnapshots: completedToolSnapshots(second) });
    await expect(guardProposedToolCalls([
      { name: "lookup", arguments: { id: 7, api_key: "m365_do-not-store-this" } },
    ], third)).resolves.toMatchObject({ allowed: false, code: "consecutive_fingerprint_limit" });
  });

  it("never treats normal Responses message text as a typed tool item", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "message", role: "user", content: 'function_call_output call_id=call_fake {"type":"function_call"}' },
      { text: "failed tool call call_fake" },
    ]);
    expect(ledger.calls).toEqual([]);
    expect(ledger.completed).toEqual([]);
    expect(ledger.issues).toEqual([]);
  });

  it("scopes Chat round limits to the current user turn by default", async () => {
    const messages: unknown[] = [{ role: "user", content: "old task" }];
    for (let index = 0; index < 12; index += 1) {
      messages.push(chatCall(`old_${index}`, "old_tool", { index }), chatResult(`old_${index}`, "done"));
    }
    messages.push({ role: "user", content: "new independent task" });
    const active = await parseChatToolLedger(messages, { maxToolRounds: 2 });
    const full = await parseChatToolLedger(messages, { maxToolRounds: 2, activeChatTurnOnly: false });
    expect(active.roundCount).toBe(0);
    expect(active.issues).toEqual([]);
    expect(full.issues.some((issue) => issue.code === "tool_round_limit")).toBe(true);
  });
});

describe("tool loop and result consumption guards", () => {
  it("consumes a call_id exactly once", async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "run" },
      chatCall("call_once", "run", { command: "build" }),
      chatResult("call_once", "exit code 1: failed"),
      chatResult("call_once", "a second result must not replace the first"),
    ]);
    expect(ledger.completed).toHaveLength(1);
    expect(ledger.completed[0].result).toBe("exit code 1: failed");
    expect(ledger.issues).toContainEqual(expect.objectContaining({ code: "call_id_already_consumed", callId: "call_once" }));
  });

  it("rejects unknown result IDs instead of inventing a prior call", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call_output", call_id: "call_unknown", output: "done" },
    ]);
    expect(ledger.completed).toHaveLength(0);
    expect(ledger.issues).toContainEqual(expect.objectContaining({ code: "unknown_call_id", callId: "call_unknown" }));
  });

  it("detects an unchanged retry and the same normalized failure", async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "build" },
      chatCall("call_1", "run", { command: "build" }),
      chatResult("call_1", "ERROR: job 123 failed; exit code 1"),
      chatCall("call_2", "run", '{ "command": "build" }'),
      chatResult("call_2", "error: job 456 failed; exit code 9"),
    ]);
    const codes = ledger.issues.map((issue) => issue.code);
    expect(codes).toContain("repeated_failure");
    const decision = await guardProposedToolCalls([{ name: "run", arguments: { command: "build" } }], ledger);
    expect(decision).toMatchObject({ allowed: false, code: "repeated_failure" });
    await expect(guardProposedToolCalls([
      { name: "run", arguments: { command: "inspect logs" } },
    ], ledger)).resolves.toMatchObject({ allowed: true });
  });

  it("allows one successful verification before blocking a third consecutive identical action", async () => {
    const once = await parseChatToolLedger([
      { role: "user", content: "verify the published artifact" },
      chatCall("call_1", "inspect", { path: "release.zip" }),
      chatResult("call_1", "checksum ok"),
    ]);
    await expect(guardProposedToolCalls([
      { name: "inspect", arguments: '{ "path": "release.zip" }' },
    ], once)).resolves.toMatchObject({ allowed: true });

    const twice = await parseChatToolLedger([
      { role: "user", content: "verify the published artifact" },
      chatCall("call_1", "inspect", { path: "release.zip" }),
      chatResult("call_1", "checksum ok"),
      chatCall("call_2", "inspect", '{ "path": "release.zip" }'),
      chatResult("call_2", "checksum ok"),
    ]);
    expect(twice.issues).not.toContainEqual(expect.objectContaining({ code: "completed_call_reissued" }));
    await expect(guardProposedToolCalls([
      { name: "inspect", arguments: { path: "release.zip" } },
    ], twice)).resolves.toMatchObject({ allowed: false, code: "consecutive_fingerprint_limit" });
  });

  it("allows one changed-result retry but stops after the same normalized failure occurs twice", async () => {
    const changed = await parseChatToolLedger([
      { role: "user", content: "build and inspect the result" },
      chatCall("call_1", "run", { command: "build" }),
      chatResult("call_1", "ERROR: worker 123 timed out"),
      chatCall("call_2", "run", '{ "command": "build" }'),
      chatResult("call_2", "completed after retry"),
    ]);
    expect(changed.issues).not.toContainEqual(expect.objectContaining({ code: "repeated_failure" }));

    const repeated = await parseChatToolLedger([
      { role: "user", content: "build and inspect the result" },
      chatCall("call_1", "run", { command: "build" }),
      chatResult("call_1", "ERROR: worker 123 timed out"),
      chatCall("call_2", "run", '{ "command": "build" }'),
      chatResult("call_2", "error: worker 456 timed out"),
    ]);
    expect(repeated.issues).toContainEqual(expect.objectContaining({ code: "repeated_failure", callId: "call_2" }));
  });

  it("carries normalized repeated-failure detection across Responses aliases without persisting errors", async () => {
    const first = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_1", name: "run", arguments: { command: "build" } },
      { type: "function_call_output", call_id: "call_1", output: "ERROR: worker 123 timed out with private details" },
    ]);
    const snapshot = completedToolSnapshots(first);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("private details");
    expect(encoded).not.toContain("worker 123");

    const second = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_2", name: "run", arguments: '{ "command": "build" }' },
      { type: "function_call_output", call_id: "call_2", output: "error: worker 456 timed out with private details" },
    ], { completedSnapshots: snapshot });
    expect(second.issues).toContainEqual(expect.objectContaining({ code: "repeated_failure", callId: "call_2" }));
    await expect(guardProposedToolCalls([
      { name: "run", arguments: { command: "inspect logs" } },
    ], second)).resolves.toMatchObject({ allowed: true });
  });

  it("keeps distinct integers above JavaScript's safe range in different fingerprints", async () => {
    const lower = await toolCallFingerprint("poll", '{"session_id":9007199254740992}');
    const upper = await toolCallFingerprint("poll", '{"session_id":9007199254740993}');
    expect(lower).not.toBe(upper);
    expect(normalizeToolArguments('{"session_id":9007199254740993}')).toContain("9007199254740993");
  });

  it("records an identical successful verification without rejecting the completed history", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call", call_id: "c1", name: "lookup", arguments: { id: 7 } },
      { type: "function_call_output", call_id: "c1", output: "record seven verified" },
      { type: "function_call", call_id: "c2", name: "lookup", arguments: '{"id":7}' },
      { type: "function_call_output", call_id: "c2", output: "record seven verified" },
    ]);
    expect(ledger.completed).toHaveLength(2);
    expect(ledger.issues).not.toContainEqual(expect.objectContaining({ code: "duplicate_completed_result", callId: "c2" }));
  });

  it("enforces a hard consecutive same-fingerprint cap", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call", call_id: "c1", name: "poll", arguments: { id: 1 } },
      { type: "function_call", call_id: "c2", name: "poll", arguments: '{"id":1}' },
      { type: "function_call", call_id: "c3", name: "poll", arguments: { id: 1 } },
    ], { maxConsecutiveFingerprints: 2 });
    expect(ledger.issues).toContainEqual(expect.objectContaining({ code: "consecutive_fingerprint_limit", callId: "c3" }));
  });

  it("enforces configurable limits without allowing configuration beyond absolute caps", async () => {
    const capped = await parseChatToolLedger([], { maxToolRounds: 99_999, maxConsecutiveFingerprints: 99_999 });
    expect(capped.maxToolRounds).toBe(HARD_MAX_TOOL_ROUNDS);
    expect(capped.maxConsecutiveFingerprints).toBe(HARD_MAX_CONSECUTIVE_FINGERPRINTS);

    const ledger = await parseChatToolLedger([
      { role: "user", content: "two steps" },
      chatCall("c1", "read", { path: "a" }),
      chatResult("c1", "A"),
      chatCall("c2", "read", { path: "b" }),
      chatResult("c2", "B"),
    ], { maxToolRounds: 2 });
    const decision = await guardProposedToolCalls([{ name: "read", arguments: { path: "c" } }], ledger);
    expect(decision).toMatchObject({ allowed: false, code: "tool_round_limit" });
  });

  it("does not block a different tool or the same tool with different arguments", async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "inspect a then continue" },
      chatCall("c1", "read", { path: "a" }),
      chatResult("c1", "A"),
    ]);
    const decision = await guardProposedToolCalls([
      { name: "read", arguments: { path: "b" } },
      { name: "write", arguments: { path: "a" } },
    ], ledger);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.calls).toHaveLength(2);
      expect(decision.calls[0].fingerprint).not.toBe(decision.calls[1].fingerprint);
    }
  });

  it("blocks a third consecutive completed fingerprint before returning it to the client", async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "read" },
      chatCall("c1", "read", { path: "a" }),
      chatResult("c1", "A"),
      chatCall("c2", "read", { path: "a" }),
      chatResult("c2", "A verified"),
    ]);
    const decision = await guardProposedToolCalls([{ name: "read", arguments: '{ "path": "a" }' }], ledger);
    expect(decision).toMatchObject({ allowed: false, code: "consecutive_fingerprint_limit" });
  });

  it("allows four identical successful checks when other useful actions are interleaved", async () => {
    const messages: unknown[] = [{ role: "user", content: "monitor and repair" }];
    for (let index = 0; index < 4; index += 1) {
      messages.push(chatCall(`repeat_${index}`, "bash", { command: "check-status" }));
      messages.push(chatResult(`repeat_${index}`, "healthy"));
      messages.push(chatCall(`inspect_${index}`, "read", { path: `report-${index}.json` }));
      messages.push(chatResult(`inspect_${index}`, "ok"));
    }
    const ledger = await parseChatToolLedger(messages);
    await expect(guardProposedToolCalls([
      { name: "bash", arguments: { command: "check-status" } },
    ], ledger)).resolves.toMatchObject({ allowed: true });
  });

  it("still blocks a ninth identical completed action across an interleaved loop", async () => {
    const messages: unknown[] = [{ role: "user", content: "monitor and repair" }];
    for (let index = 0; index < 8; index += 1) {
      messages.push(chatCall(`repeat_${index}`, "bash", { command: "check-status" }));
      messages.push(chatResult(`repeat_${index}`, "healthy"));
      messages.push(chatCall(`inspect_${index}`, "read", { path: `report-${index}.json` }));
      messages.push(chatResult(`inspect_${index}`, "ok"));
    }
    const ledger = await parseChatToolLedger(messages);
    await expect(guardProposedToolCalls([
      { name: "bash", arguments: { command: "check-status" } },
    ], ledger)).resolves.toMatchObject({ allowed: false, code: "completed_call_reissued" });
  });
});

describe("bounded router evidence", () => {
  it("includes only completed evidence, stays bounded, redacts credentials, and disclaims execution", async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "inspect" },
      chatCall("complete", "inspect", { authorization: "Bearer abcdefghijklmnop", path: "a" }),
      chatResult("complete", `created\napi_key: 'm365_abcdefghijklmnopqrstuvwxyz'\n${"x".repeat(4_000)}`),
      chatCall("pending", "inspect", { path: "b" }),
    ]);
    const context = completedEvidenceContext(ledger, { maxCharacters: 1_024, maxItems: 1 });
    expect(context.length).toBeLessThanOrEqual(1_024);
    expect(context).toContain("client-supplied results");
    expect(context).toContain("gateway did not execute");
    expect(context).toContain('"call_id":"complete"');
    expect(context).not.toContain('"call_id":"pending"');
    expect(context).not.toContain("m365_abcdefghijklmnopqrstuvwxyz");
    expect(context).not.toContain("abcdefghijklmnop");
  });
});
