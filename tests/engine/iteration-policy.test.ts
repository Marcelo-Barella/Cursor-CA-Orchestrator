import { describe, expect, it } from "vitest";
import { decideRecovery } from "../../src/engine/iteration-policy.js";

describe("decideRecovery", () => {
  it("chooses fix on first gate failure", () => {
    expect(
      decideRecovery({
        failedGates: ["code_quality"],
        gatesFailedAfterFix: [],
        claimCollision: false,
        iteration: 0,
        maxIterations: 10,
      }),
    ).toEqual({ action: "fix", iteration: 1 });
  });

  it("escalates when same gate fails again", () => {
    expect(
      decideRecovery({
        failedGates: ["code_quality", "code_review"],
        gatesFailedAfterFix: ["code_quality"],
        claimCollision: false,
        iteration: 1,
        maxIterations: 10,
      }),
    ).toEqual({ action: "replan", iteration: 2 });
  });

  it("escalates on claim collision", () => {
    expect(
      decideRecovery({
        failedGates: ["computer_use"],
        gatesFailedAfterFix: [],
        claimCollision: true,
        iteration: 1,
        maxIterations: 10,
      }),
    ).toEqual({ action: "replan", iteration: 2 });
  });

  it("fails at cap", () => {
    expect(
      decideRecovery({
        failedGates: ["code_review"],
        gatesFailedAfterFix: [],
        claimCollision: false,
        iteration: 10,
        maxIterations: 10,
      }),
    ).toEqual({ action: "fail_cap", iteration: 10 });
  });
});
