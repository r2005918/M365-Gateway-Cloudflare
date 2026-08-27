interface ModelSpec {
  id: string;
  owner: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
}

const MODELS: ModelSpec[] = [
  { id: "gpt-5.5", owner: "microsoft-365", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "gpt-5.5-reasoning", owner: "microsoft-365", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "gpt-5.6-sol", owner: "microsoft-365", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "gpt-5.6-reasoning", owner: "microsoft-365", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "claude-sonnet", owner: "anthropic-via-microsoft-365", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
  { id: "claude-sonnet-reasoning", owner: "anthropic-via-microsoft-365", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
];

const ALIASES: Record<string, string> = {
  "gpt-5.6": "gpt-5.6-sol",
  "m365-copilot": "gpt-5.6-sol",
  claude: "claude-sonnet",
};

export function canonicalModel(value: string | undefined): string {
  const requested = (value || "gpt-5.6-sol").trim().toLowerCase();
  const canonical = ALIASES[requested] ?? requested;
  if (!MODELS.some((model) => model.id === canonical)) throw new Error("UNSUPPORTED_MODEL");
  return canonical;
}

export function modelTone(model: string, effort = ""): string {
  const normalizedEffort = effort.trim().toLowerCase();
  const wantsReasoning = !["none", "minimal", "low"].includes(normalizedEffort) && normalizedEffort !== "";
  switch (model) {
    case "gpt-5.5": return wantsReasoning ? "Gpt_5_5_Reasoning" : "Gpt_5_5_Chat";
    case "gpt-5.5-reasoning": return "Gpt_5_5_Reasoning";
    case "gpt-5.6-sol": return ["none", "minimal", "low"].includes(normalizedEffort) ? "Gpt_5_6_Chat" : "Gpt_5_6_Reasoning";
    case "gpt-5.6-reasoning": return "Gpt_5_6_Reasoning";
    case "claude-sonnet": return wantsReasoning ? "Claude_Sonnet_Reasoning" : "Claude_Sonnet";
    case "claude-sonnet-reasoning": return "Claude_Sonnet_Reasoning";
    default: throw new Error("UNSUPPORTED_MODEL");
  }
}

// ChatHub receives UTF-16 strings, while advertised model limits are tokens.
// Keep a conservative character ceiling so large client histories cannot make
// a Worker allocate the entire request several times during prompt assembly.
export function modelPromptCharacterLimit(model: string): number {
  const spec = MODELS.find((candidate) => candidate.id === model);
  if (!spec) throw new Error("UNSUPPORTED_MODEL");
  const usableTokens = spec.contextWindow - spec.maxOutputTokens;
  return Math.min(3_000_000, Math.max(64_000, Math.floor(usableTokens * 3)));
}

export function modelMaxInputTokens(model: string): number {
  const spec = MODELS.find((candidate) => candidate.id === model);
  if (!spec) throw new Error("UNSUPPORTED_MODEL");
  return spec.contextWindow - spec.maxOutputTokens;
}

/**
 * Conservative prompt estimate for the gateway's dominant input classes:
 * Latin/code averages roughly four characters per token, while CJK and other
 * non-ASCII code points are charged one token each. Protocol envelopes supply
 * additional slack, so whitespace itself is ignored here.
 */
export function estimatePromptTokens(value: string): number {
  const counts = countPromptTokenClasses(value);
  return Math.ceil(counts.asciiWordCharacters / 4)
    + Math.ceil(counts.asciiSyntaxCharacters / 2)
    + counts.nonAsciiCharacters
    + counts.emojiCharacters * 2;
}

export interface PromptTokenClassCounts {
  asciiWordCharacters: number;
  asciiSyntaxCharacters: number;
  nonAsciiCharacters: number;
  emojiCharacters: number;
}

function isPromptWhitespace(codePoint: number): boolean {
  return (codePoint >= 0x09 && codePoint <= 0x0d)
    || codePoint === 0x20
    || codePoint === 0x85
    || codePoint === 0xa0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000
    || codePoint === 0xfeff;
}

// This covers the emoji and pictographic blocks used in prompts without a
// Unicode property-regexp test for every character in a streamed response.
function isPromptEmoji(codePoint: number): boolean {
  return (codePoint >= 0x1f000 && codePoint <= 0x1faff)
    || (codePoint >= 0x1fc00 && codePoint <= 0x1fffd)
    || (codePoint >= 0x2300 && codePoint <= 0x23ff)
    || (codePoint >= 0x2600 && codePoint <= 0x27bf)
    || (codePoint >= 0x2b00 && codePoint <= 0x2bff);
}

export function countPromptTokenClasses(value: string): PromptTokenClassCounts {
  const counts: PromptTokenClassCounts = {
    asciiWordCharacters: 0,
    asciiSyntaxCharacters: 0,
    nonAsciiCharacters: 0,
    emojiCharacters: 0,
  };
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isPromptWhitespace(codePoint)) continue;
    if (codePoint <= 0x7f) {
      if ((codePoint >= 0x30 && codePoint <= 0x39)
        || (codePoint >= 0x41 && codePoint <= 0x5a)
        || (codePoint >= 0x61 && codePoint <= 0x7a)
        || codePoint === 0x5f) counts.asciiWordCharacters += 1;
      else counts.asciiSyntaxCharacters += 1;
    } else if (isPromptEmoji(codePoint)) counts.emojiCharacters += 1;
    else counts.nonAsciiCharacters += 1;
  }
  return counts;
}

export function modelCatalog(): Record<string, unknown>[] {
  return MODELS.map((model) => ({
    id: model.id,
    object: "model",
    owned_by: model.owner,
    context_window: model.contextWindow,
    max_input_tokens: model.contextWindow - model.maxOutputTokens,
    max_output_tokens: model.maxOutputTokens,
    capabilities: {
      chat_completions: true,
      responses: true,
      streaming: true,
      tools: true,
      reasoning: model.reasoning,
      vision: false,
      image_generation: false,
      audio: false,
      modalities: ["text"],
    },
  }));
}

/** Codex CLI uses its own model-capability manifest when it requests
 * `/models?client_version=...`.  Returning only the standard OpenAI `data`
 * list makes the CLI fall back to metadata with shell execution disabled, so
 * it silently omits exec_command/write_stdin from subsequent Responses calls.
 */
export function codexModelCatalog(): { models: Record<string, unknown>[] } {
  const reasoningLevels = ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
    effort,
    description: `${effort} reasoning`,
  }));
  return {
    models: MODELS.map((model, index) => ({
      slug: model.id,
      display_name: model.id,
      description: "M365 Gateway model for Codex CLI",
      default_reasoning_level: "medium",
      supported_reasoning_levels: model.id === "gpt-5.6-sol"
        ? [...reasoningLevels, { effort: "ultra", description: "ultra reasoning" }]
        : reasoningLevels,
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: index + 1,
      availability_nux: null,
      upgrade: null,
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      supports_image_detail_original: false,
      context_window: model.contextWindow,
      max_context_window: model.contextWindow,
      auto_compact_token_limit: Math.floor(model.contextWindow * 0.9),
      experimental_supported_tools: [],
      input_modalities: ["text"],
      supports_search_tool: false,
      use_responses_lite: false,
      node_repl_auto_review_required: false,
      node_repl_disabled: false,
      tool_mode: "direct",
      base_instructions: "You are Codex. Use the caller-provided local tools for filesystem access and command execution. Never simulate a tool result or substitute a hosted shell for the caller's environment.",
    })),
  };
}
