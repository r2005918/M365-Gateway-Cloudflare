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

const sessionKey = `cancel-${Date.now().toString(36)}`;
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const first = await fetch(`${baseUrl}/v1/responses`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: "gpt-5.6-reasoning",
    stream: true,
    session_key: sessionKey,
    input: "Produce a detailed 2000-word technical discussion about deterministic state machines.",
  }),
});
const reader = first.body?.getReader();
if (!reader) throw new Error("stream body unavailable");
await reader.read();
await reader.cancel("cancel regression");
await new Promise((resolve) => setTimeout(resolve, 2_000));

const marker = `CANCEL-RECOVERED-${sessionKey}`;
const retry = await fetch(`${baseUrl}/v1/responses`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model: "gpt-5.6-sol", session_key: sessionKey, input: `Return exactly: ${marker}` }),
});
const body = await retry.text();
const passed = retry.status === 200 && body.includes(marker);
process.stdout.write(`${passed ? "PASS" : "FAIL"} downstream-cancel.lease-release — retry=${retry.status}\n`);
process.exitCode = passed ? 0 : 1;
