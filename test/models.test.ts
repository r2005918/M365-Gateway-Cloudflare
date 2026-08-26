import { describe, expect, it } from "vitest";
import { canonicalModel, estimatePromptTokens, modelCatalog, modelMaxInputTokens, modelPromptCharacterLimit, modelTone } from "../src/models";

describe("model routing", () => {
  it("keeps only supported 5.5+ and Claude models", () => {
    const ids = modelCatalog().map((model) => model.id);
    expect(ids).toEqual([
      "gpt-5.5",
      "gpt-5.5-reasoning",
      "gpt-5.6-sol",
      "gpt-5.6-reasoning",
      "claude-sonnet",
      "claude-sonnet-reasoning",
    ]);
    expect(ids).not.toContain("gpt-5.4");
  });

  it("maps model aliases and reasoning effort to verified ChatHub tones", () => {
    expect(canonicalModel("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(modelTone("gpt-5.6-sol")).toBe("Gpt_5_6_Reasoning");
    expect(modelTone("gpt-5.6-sol", "low")).toBe("Gpt_5_6_Chat");
    expect(modelTone("gpt-5.5", "high")).toBe("Gpt_5_5_Reasoning");
    expect(modelTone("claude-sonnet", "none")).toBe("Claude_Sonnet");
    expect(() => canonicalModel("gpt-5.4")).toThrow("UNSUPPORTED_MODEL");
  });

  it("applies bounded, model-specific prompt memory ceilings", () => {
    expect(modelPromptCharacterLimit("gpt-5.6-sol")).toBe(2_766_000);
    expect(modelPromptCharacterLimit("claude-sonnet")).toBe(408_000);
    expect(() => modelPromptCharacterLimit("gpt-5.4")).toThrow("UNSUPPORTED_MODEL");
  });

  it("charges CJK independently instead of assuming every token spans three characters", () => {
    expect(estimatePromptTokens("abcdefgh")).toBe(2);
    expect(estimatePromptTokens("中文测试")).toBe(4);
    expect(estimatePromptTokens("ab cd\n中文")).toBe(3);
    expect(estimatePromptTokens("😀😀")).toBe(4);
    expect(estimatePromptTokens("const x=foo();")).toBeGreaterThanOrEqual(5);
    expect(modelMaxInputTokens("gpt-5.6-sol")).toBe(922_000);
    expect(modelMaxInputTokens("claude-sonnet")).toBe(136_000);
  });
});
