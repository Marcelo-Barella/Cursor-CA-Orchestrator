import { describe, expect, it } from "vitest";
import { countOrchestrationPromptTokens } from "../src/lib/prompt-token-count.js";

describe("prompt-token-count", () => {
  it("returns zero for empty input", () => {
    expect(countOrchestrationPromptTokens("")).toBe(0);
  });

  it("counts tokens for non-empty text", () => {
    expect(countOrchestrationPromptTokens("hello world")).toBeGreaterThan(0);
  });
});
