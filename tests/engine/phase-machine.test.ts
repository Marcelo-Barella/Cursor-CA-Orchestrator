import { describe, expect, it } from "vitest";
import { nextPhase } from "../../src/engine/phase-machine.js";

describe("nextPhase", () => {
  it("advances happy path", () => {
    expect(nextPhase("plan", "plan_ready")).toBe("implement");
    expect(nextPhase("implement", "implement_done")).toBe("integrate");
    expect(nextPhase("integrate", "integrate_ok")).toBe("gate");
    expect(nextPhase("gate", "gates_pass")).toBe("finalize");
    expect(nextPhase("finalize", "finalize_done")).toBe("completed");
  });

  it("routes failures to fix or replan", () => {
    expect(nextPhase("gate", "fix_scheduled")).toBe("fix");
    expect(nextPhase("gate", "replan_scheduled")).toBe("replan");
    expect(nextPhase("fix", "fix_scheduled")).toBe("implement");
    expect(nextPhase("replan", "replan_scheduled")).toBe("plan");
    expect(nextPhase("integrate", "integrate_conflict")).toBe("fix");
  });

  it("handles stop and cap", () => {
    expect(nextPhase("implement", "stop")).toBe("stopped");
    expect(nextPhase("gate", "cap_exceeded")).toBe("failed");
  });
});
