import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "../src/config/types.js";
import { filterEligibleReadyTasks } from "../src/orchestrator.js";
import { createInitialState } from "../src/state.js";

function createConfig(taskIds: string[]): OrchestratorConfig {
  return {
    name: "n",
    model: "m",
    prompt: "",
    repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      repo: "svc",
      prompt: `task ${taskId}`,
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
    })),
    target: { auto_create_pr: true, branch_prefix: "p" },
    bootstrap_repo_name: "b",
  };
}

describe("orchestrator launch eligibility", () => {
  it("keeps current behavior when delegation map is absent", () => {
    const config = createConfig(["a", "b"]);
    const state = createInitialState(config, "run1");
    const ready = ["a", "b"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(ready);
    expect(state.delegation_phase_index).toBeNull();
  });

  it("filters ready tasks by current delegation phase", () => {
    const config = createConfig(["a", "b", "c"]);
    config.delegation_map = {
      phases: [
        { id: "phase-1", groups: [{ id: "group-1", task_ids: ["a"] }] },
        { id: "phase-2", groups: [{ id: "group-1", task_ids: ["b", "c"] }] },
      ],
    };
    const state = createInitialState(config, "run1");
    const ready = ["a", "b", "c"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(["a"]);
    expect(state.delegation_phase_index).toBe(0);
  });

  it("advances phase when the current phase is terminal", () => {
    const config = createConfig(["a", "b", "c"]);
    config.delegation_map = {
      phases: [
        { id: "phase-1", groups: [{ id: "group-1", task_ids: ["a"] }] },
        { id: "phase-2", groups: [{ id: "group-1", task_ids: ["b", "c"] }] },
      ],
    };
    const state = createInitialState(config, "run1");
    state.agents.a!.status = "finished";
    const ready = ["b", "c"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(["b", "c"]);
    expect(state.delegation_phase_index).toBe(1);
  });

  it("allows unmapped tasks while enforcing mapped phase gating", () => {
    const config = createConfig(["a", "b", "x"]);
    config.delegation_map = {
      phases: [
        { id: "phase-1", groups: [{ id: "group-1", task_ids: ["a"] }] },
        { id: "phase-2", groups: [{ id: "group-1", task_ids: ["b"] }] },
      ],
    };
    const state = createInitialState(config, "run1");
    const ready = ["a", "b", "x"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(["a", "x"]);
    expect(state.delegation_phase_index).toBe(0);
  });
});
