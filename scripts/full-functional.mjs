import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configuredBaseUrl = process.env.M365_BASE_URL || "";
if (!configuredBaseUrl) throw new Error("M365_BASE_URL is required; point it at an isolated candidate deployment");
const baseUrl = configuredBaseUrl.replace(/\/$/u, "");
const target = new URL(baseUrl);
const protectedHostname = (process.env.M365_PRODUCTION_HOST || "").trim().toLowerCase();
if (protectedHostname && target.hostname.toLowerCase() === protectedHostname && process.env.M365_ALLOW_PRODUCTION !== "1") {
  throw new Error("refusing to test the configured production hostname without M365_ALLOW_PRODUCTION=1");
}
let apiKey = process.env.M365_TEST_API_KEY || "";
delete process.env.M365_TEST_API_KEY;
if (!apiKey) throw new Error("M365_TEST_API_KEY is required");

const defaultModels = [
  "gpt-5.5",
  "gpt-5.5-reasoning",
  "gpt-5.6-sol",
  "gpt-5.6-reasoning",
  "claude-sonnet",
  "claude-sonnet-reasoning",
];
const requestedModels = (process.env.M365_TEST_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean);
const models = requestedModels.length ? requestedModels : defaultModels;
const runId = `ff-${Date.now().toString(36)}`;
const regressionOnly = process.env.M365_TEST_SCOPE === "regression";
const startedAt = new Date();
const checks = [];
const timings = [];

function record(name, passed, detail = "") {
  checks.push({ name, passed: Boolean(passed), detail: String(detail).slice(0, 300) });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function stage(name, task) {
  try {
    await task();
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : "unknown error");
  }
}

async function request(path, { method = "POST", body, auth = true, timeoutMs = 240_000, signal } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = { "User-Agent": "m365-gateway-full-functional/1.0" };
  if (auth) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: combinedSignal,
  });
  timings.push({ path, status: response.status, milliseconds: Math.round(performance.now() - started) });
  return response;
}

async function jsonRequest(path, body, options = {}) {
  const response = await request(path, { ...options, body });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON status=${response.status}`);
  }
  return { response, json, text };
}

function chatText(json) {
  return String(json?.choices?.[0]?.message?.content ?? "");
}

function responseText(json) {
  return (json?.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => String(item.text || ""))
    .join("");
}

function parseChatSSE(raw) {
  let text = "";
  let done = false;
  let finish = "";
  let error = "";
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    if (!data) continue;
    const event = JSON.parse(data);
    text += String(event?.choices?.[0]?.delta?.content ?? "");
    finish ||= String(event?.choices?.[0]?.finish_reason ?? "");
    error ||= String(event?.error?.code ?? "");
  }
  return { text, done, finish, error };
}

function parseResponsesSSE(raw) {
  let text = "";
  let done = false;
  let completed = false;
  let failed = false;
  const sequences = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    if (!data) continue;
    const event = JSON.parse(data);
    if (Number.isInteger(event.sequence_number)) sequences.push(event.sequence_number);
    if (event.type === "response.output_text.delta") text += String(event.delta || "");
    if (event.type === "response.completed") completed = true;
    if (event.type === "response.failed") failed = true;
  }
  const sequenceValid = sequences.every((value, index) => value === index);
  return { text, done, completed, failed, sequenceValid };
}

const tool = {
  type: "function",
  function: {
    name: "lookup_gateway_value",
    description: "Return one deterministic value for gateway verification",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
};

await stage("catalog", async () => {
  const { response, json } = await jsonRequest("/v1/models", undefined, { method: "GET" });
  const ids = (json.data || []).map((item) => item.id);
  record("catalog.status", response.status === 200, `status=${response.status}`);
  // M365_TEST_MODELS limits only the request matrix. The public catalog must
  // remain stable and continue advertising every supported model.
  record("catalog.models", JSON.stringify(ids) === JSON.stringify(defaultModels), ids.join(","));
});

for (const model of models) {
  if (!regressionOnly) {
  await stage(`${model}.chat.nonstream`, async () => {
    const marker = `CHAT-${model}-${runId}`;
    const { response, json } = await jsonRequest("/v1/chat/completions", {
      model,
      session_key: `${runId}-${model}-chat-ns`,
      messages: [{ role: "user", content: `Return exactly this marker and nothing else: ${marker}` }],
    });
    record(`${model}.chat.nonstream`, response.status === 200 && chatText(json).includes(marker), `status=${response.status};finish=${json?.choices?.[0]?.finish_reason || ""}`);
  });

  await stage(`${model}.chat.stream`, async () => {
    const marker = `CHAT-STREAM-${model}-${runId}`;
    const response = await request("/v1/chat/completions", { body: {
      model,
      stream: true,
      session_key: `${runId}-${model}-chat-stream`,
      messages: [{ role: "user", content: `Return exactly this marker and nothing else: ${marker}` }],
    } });
    const parsed = parseChatSSE(await response.text());
    record(`${model}.chat.stream`, response.status === 200 && parsed.done && parsed.finish === "stop" && !parsed.error && parsed.text.includes(marker), `status=${response.status};done=${parsed.done};finish=${parsed.finish};chars=${parsed.text.length}`);
  });

  await stage(`${model}.responses.nonstream`, async () => {
    const marker = `RESP-${model}-${runId}`;
    const { response, json } = await jsonRequest("/v1/responses", {
      model,
      session_key: `${runId}-${model}-resp-ns`,
      input: `Return exactly this marker and nothing else: ${marker}`,
    });
    record(`${model}.responses.nonstream`, response.status === 200 && json.status === "completed" && responseText(json).includes(marker), `status=${response.status};state=${json.status || ""}`);
  });

  await stage(`${model}.responses.stream`, async () => {
    const marker = `RESP-STREAM-${model}-${runId}`;
    const response = await request("/v1/responses", { body: {
      model,
      stream: true,
      session_key: `${runId}-${model}-resp-stream`,
      input: `Return exactly this marker and nothing else: ${marker}`,
    } });
    const parsed = parseResponsesSSE(await response.text());
    record(`${model}.responses.stream`, response.status === 200 && parsed.done && parsed.completed && !parsed.failed && parsed.sequenceValid && parsed.text.includes(marker), `status=${response.status};done=${parsed.done};completed=${parsed.completed};sequence=${parsed.sequenceValid};chars=${parsed.text.length}`);
  });
  }

  await stage(`${model}.responses.tool`, async () => {
    const expected = `RESP-TOOL-${model}-${runId}`;
    const first = await jsonRequest("/v1/responses", {
      model,
      input: `Call lookup_gateway_value with key ${model}-${runId}. Do not answer directly.`,
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
    });
    const call = (first.json.output || []).find((item) => item?.type === "function_call");
    if (first.response.status !== 200 || !call?.call_id || call.name !== "lookup_gateway_value") {
      throw new Error(`missing call status=${first.response.status};code=${first.json?.error?.code || "none"}`);
    }
    const second = await jsonRequest("/v1/responses", {
      model,
      previous_response_id: first.json.id,
      input: [{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ value: expected }) }],
    });
    record(`${model}.responses.tool`, second.response.status === 200 && responseText(second.json).includes(expected), `first=${first.response.status};second=${second.response.status}`);
  });

  await stage(`${model}.chat.tool`, async () => {
    const expected = `CHAT-TOOL-${model}-${runId}`;
    const sessionKey = `${runId}-${model}-chat-tool`;
    const first = await jsonRequest("/v1/chat/completions", {
      model,
      session_key: sessionKey,
      messages: [{ role: "user", content: `Call lookup_gateway_value with key ${model}-${runId}. Do not answer directly.` }],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
    });
    const call = first.json?.choices?.[0]?.message?.tool_calls?.[0];
    if (first.response.status !== 200 || !call?.id || call?.function?.name !== "lookup_gateway_value") {
      throw new Error(`missing call status=${first.response.status};code=${first.json?.error?.code || "none"}`);
    }
    const second = await jsonRequest("/v1/chat/completions", {
      model,
      session_key: sessionKey,
      messages: [
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: JSON.stringify({ value: expected }) },
      ],
    });
    record(`${model}.chat.tool`, second.response.status === 200 && chatText(second.json).includes(expected), `first=${first.response.status};second=${second.response.status}`);
  });
}

if (!regressionOnly) {
await stage("chat.context", async () => {
  const marker = `CHAT-MEMORY-${runId}`;
  const sessionKey = `${runId}-chat-context`;
  let passed = true;
  for (let turn = 0; turn < 8; turn += 1) {
    const prompt = turn === 0
      ? `Remember this exact marker for later turns and output only it: ${marker}`
      : "Output only the exact marker you were told to remember in this conversation.";
    const { response, json } = await jsonRequest("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      session_key: sessionKey,
      messages: [{ role: "user", content: prompt }],
    });
    passed &&= response.status === 200 && chatText(json).includes(marker);
  }
  record("chat.context.8-turn", passed, `marker=${passed ? "preserved" : "missing"}`);
});

await stage("responses.context", async () => {
  const marker = `RESP-MEMORY-${runId}`;
  let previous = "";
  let passed = true;
  for (let turn = 0; turn < 8; turn += 1) {
    const body = turn === 0
      ? { model: "gpt-5.6-sol", session_key: `${runId}-resp-context`, input: `Remember this exact marker and output only it: ${marker}` }
      : { model: "gpt-5.6-sol", previous_response_id: previous, input: "Output only the exact marker you were told to remember." };
    const result = await jsonRequest("/v1/responses", body);
    passed &&= result.response.status === 200 && responseText(result.json).includes(marker);
    previous = String(result.json.id || "");
  }
  record("responses.context.8-turn", passed, `marker=${passed ? "preserved" : "missing"}`);
});

await stage("responses.tool-ledger", async () => {
  const first = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    input: "Call lookup_gateway_value with key ledger-test.",
    tools: [tool],
    tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
  });
  const call = (first.json.output || []).find((item) => item?.type === "function_call");
  if (!call?.call_id) throw new Error("tool call missing");
  const mismatch = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    previous_response_id: first.json.id,
    input: [{ type: "function_call_output", call_id: "call_wrong", output: "wrong" }],
  });
  const correct = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    previous_response_id: first.json.id,
    input: [{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ value: `LEDGER-${runId}` }) }],
  });
  const replay = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    previous_response_id: first.json.id,
    input: [{ type: "function_call_output", call_id: call.call_id, output: "replayed" }],
  });
  record("responses.tool-ledger", mismatch.response.status === 400 && correct.response.status === 200 && replay.response.status === 409, `mismatch=${mismatch.response.status};correct=${correct.response.status};replay=${replay.response.status}`);
});

await stage("error-contracts", async () => {
  const unauth = await jsonRequest("/v1/models", undefined, { method: "GET", auth: false });
  const malformed = await jsonRequest("/v1/responses", "{", {});
  const unsupported = await jsonRequest("/v1/responses", { model: "gpt-5.4", input: "test" });
  const empty = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: "" });
  const unsafeVision = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_image", image_url: "http://127.0.0.1/private.png" }] }] });
  const unexpectedTool = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: [{ type: "function_call_output", call_id: "call_orphan", output: "x" }] });
  const missingPrevious = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", previous_response_id: `resp_missing_${runId}`, input: "continue" });
  const tooManyTools = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: "test", tools: Array.from({ length: 129 }, (_, index) => ({ ...tool, function: { ...tool.function, name: `tool_${index}` } })) });
  const statuses = [unauth.response.status, malformed.response.status, unsupported.response.status, empty.response.status, unsafeVision.response.status, unexpectedTool.response.status, missingPrevious.response.status, tooManyTools.response.status];
  record("error-contracts", JSON.stringify(statuses) === JSON.stringify([401, 400, 400, 400, 400, 400, 404, 400]), statuses.join(","));
});

await stage("vision.input", async () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const result = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Briefly describe the attached image. Return a non-empty answer." },
        { type: "input_image", image_url: `data:image/png;base64,${tinyPng}` },
      ],
    }],
  });
  record("vision.input", result.response.status === 200 && responseText(result.json).trim().length > 0, `status=${result.response.status};chars=${responseText(result.json).length}`);
});

await stage("image.generation.url", async () => {
  const result = await jsonRequest("/v1/images/generations", {
    model: "gpt-5.6-sol",
    prompt: "A minimal blue circle centered on a plain white background",
    n: 1,
    size: "1024x1024",
    response_format: "url",
  }, { timeoutMs: 570_000 });
  const image = String(result.json?.data?.[0]?.url ?? "");
  record("image.generation.url", result.response.status === 200 && (/^https:\/\//u.test(image) || /^data:image\//u.test(image)), `status=${result.response.status};resource=${image ? "present" : "missing"}`);
});

await stage("concurrency", async () => {
  const jobs = Array.from({ length: 4 }, async (_, index) => {
    const marker = `CONCURRENT-${index}-${runId}`;
    const result = await jsonRequest("/v1/responses", {
      model: "gpt-5.6-sol",
      session_key: `${runId}-concurrent-${index}`,
      input: `Return exactly: ${marker}`,
    });
    return result.response.status === 200 && responseText(result.json).includes(marker);
  });
  const results = await Promise.all(jobs);
  record("concurrency.4-independent-sessions", results.every(Boolean), results.join(","));
});
}

await stage("downstream-cancel", async () => {
  const sessionKey = `${runId}-cancel`;
  const response = await request("/v1/responses", { body: {
    model: "gpt-5.6-reasoning",
    stream: true,
    session_key: sessionKey,
    input: "Produce a detailed 2000-word technical discussion about deterministic state machines.",
  } });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream body unavailable");
  await reader.read();
  await reader.cancel("functional cancellation test");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const retry = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    session_key: sessionKey,
    input: `Return exactly: CANCEL-RECOVERED-${runId}`,
  });
  record("downstream-cancel.lease-release", retry.response.status === 200 && responseText(retry.json).includes(`CANCEL-RECOVERED-${runId}`), `retry=${retry.response.status}`);
});

if (!regressionOnly) await stage("long-stream", async () => {
  const response = await request("/v1/responses", { timeoutMs: 570_000, body: {
    model: "gpt-5.6-reasoning",
    stream: true,
    session_key: `${runId}-long-stream`,
    input: "Write a rigorous Chinese engineering review of a production AI gateway. Cover streaming state machines, cancellation, tool-call ledgers, context persistence, security boundaries and observability. Use at least 1800 Chinese characters and finish with a concise acceptance checklist.",
  } });
  const parsed = parseResponsesSSE(await response.text());
  record("long-stream.completed", response.status === 200 && parsed.done && parsed.completed && !parsed.failed && parsed.sequenceValid && parsed.text.length >= 800, `status=${response.status};chars=${parsed.text.length};done=${parsed.done};completed=${parsed.completed}`);
});

const ordered = timings.map((item) => item.milliseconds).sort((a, b) => a - b);
const percentile = (fraction) => ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] : 0;
const report = {
  runId,
  scope: regressionOnly ? "regression" : "full",
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  models,
  passed: checks.every((item) => item.passed),
  checks,
  summary: {
    total: checks.length,
    passed: checks.filter((item) => item.passed).length,
    failed: checks.filter((item) => !item.passed).length,
  },
  latencyMs: {
    count: ordered.length,
    min: ordered[0] || 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1) || 0,
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = process.env.M365_REPORT_PATH || resolve(here, `../reports/full-functional-${runId}.json`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`REPORT ${reportPath}\n`);
apiKey = "";
if (!report.passed) process.exitCode = 1;
