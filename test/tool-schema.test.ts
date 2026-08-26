import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../src/tool-schema";

const tools = [{
  type: "function",
  function: {
    name: "weather",
    parameters: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "object",
          required: ["city"],
          additionalProperties: false,
          properties: {
            city: { type: "string", minLength: 1 },
            unit: { type: "string", enum: ["c", "f"] },
          },
        },
        days: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
  },
}];

describe("bounded function argument validation", () => {
  it("accepts a valid nested argument object", () => {
    expect(validateToolArguments("weather", JSON.stringify({ query: { city: "Paris", unit: "c" }, days: 2 }), tools)).toBe(true);
  });

  it("rejects missing required, enum, extra-property and integer violations", () => {
    expect(validateToolArguments("weather", JSON.stringify({ query: { unit: "c" } }), tools)).toBe(false);
    expect(validateToolArguments("weather", JSON.stringify({ query: { city: "Paris", unit: "kelvin" } }), tools)).toBe(false);
    expect(validateToolArguments("weather", JSON.stringify({ query: { city: "Paris" }, extra: true }), tools)).toBe(false);
    expect(validateToolArguments("weather", JSON.stringify({ query: { city: "Paris" }, days: 1.5 }), tools)).toBe(false);
  });

  it("rejects undeclared tools, non-object arguments and invalid JSON", () => {
    expect(validateToolArguments("missing", "{}", tools)).toBe(false);
    expect(validateToolArguments("weather", "[]", tools)).toBe(false);
    expect(validateToolArguments("weather", "{", tools)).toBe(false);
  });

  it("supports local refs and bounded composition", () => {
    const refTools = [{
      type: "function",
      function: {
        name: "lookup",
        parameters: {
          type: "object",
          required: ["target"],
          properties: { target: { $ref: "#/$defs/target" } },
          $defs: { target: { oneOf: [{ type: "string", minLength: 1 }, { type: "integer", minimum: 1 }] } },
        },
      },
    }];
    expect(validateToolArguments("lookup", JSON.stringify({ target: "abc" }), refTools)).toBe(true);
    expect(validateToolArguments("lookup", JSON.stringify({ target: 2 }), refTools)).toBe(true);
    expect(validateToolArguments("lookup", JSON.stringify({ target: 0 }), refTools)).toBe(false);
  });
});
