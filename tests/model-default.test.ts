import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID } from "../src/config/constants.js";
import { normalizeModelFromYaml } from "../src/lib/model-selection.js";

describe("default model", () => {
  it("exports cursor-grok-4.5-high", () => {
    expect(DEFAULT_MODEL_ID).toBe("cursor-grok-4.5-high");
  });

  it("normalizeModelFromYaml falls back to DEFAULT_MODEL_ID", () => {
    expect(normalizeModelFromYaml(null)).toEqual({ id: "cursor-grok-4.5-high" });
    expect(normalizeModelFromYaml("")).toEqual({ id: "cursor-grok-4.5-high" });
  });
});
