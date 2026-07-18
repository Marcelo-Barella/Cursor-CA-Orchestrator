import { describe, expect, it } from "vitest";
import { failedGateIds, gateResultBoardPath, parseGateResult } from "../../src/engine/gates.js";

describe("gates", () => {
  it("parses pass/fail artifacts", () => {
    const r = parseGateResult({
      gate: "code_quality",
      passed: false,
      findings: [{ severity: "blocking", message: "god class", path: "src/a.ts" }],
      summary: "fail",
    });
    expect(r.passed).toBe(false);
    expect(failedGateIds([r])).toEqual(["code_quality"]);
    expect(gateResultBoardPath("code_review")).toBe("gate-results/code_review.json");
  });
});
