import { describe, expect, it } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import type { CursorClient } from "../src/api/cursor-client.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { toYaml } from "../src/config/parse.js";
import { filterEligibleReadyTasks, runOrchestration } from "../src/orchestrator.js";
import { createInitialState, deserialize, serialize } from "../src/state.js";

function createConfig(
  taskIds: string[],
  opts?: { deps?: Record<string, string[]>; repoFor?: Record<string, string> },
): OrchestratorConfig {
  const deps = opts?.deps ?? {};
  const repoFor = opts?.repoFor ?? {};
  return {
    name: "n",
    model: "m",
    prompt: "",
    repositories: {
      svc: { url: "https://github.com/o/r", ref: "main" },
      svc2: { url: "https://github.com/o/r2", ref: "main" },
    },
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      repo: repoFor[taskId] ?? "svc",
      prompt: `task ${taskId}`,
      model: null,
      depends_on: deps[taskId] ?? [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
    })),
    target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
    bootstrap_repo_name: "b",
  };
}

describe("orchestrator launch eligibility", () => {
  it("keeps current behavior when delegation map is absent", () => {
    const config = createConfig(["a"]);
    const state = createInitialState(config, "run1");
    const ready = ["a"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(ready);
    expect(state.delegation_phase_index).toBeNull();
    expect(state.delegation_group_index).toBeNull();
  });

  it("filters ready tasks by current delegation phase", () => {
    const config = createConfig(["a", "b", "c"], {
      deps: { b: ["a"] },
      repoFor: { c: "svc2" },
    });
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
    expect(state.delegation_group_index).toBe(0);
  });

  it("advances phase when the current phase is terminal", () => {
    const config = createConfig(["a", "b", "c"], {
      deps: { b: ["a"] },
      repoFor: { c: "svc2" },
    });
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
    expect(state.delegation_group_index).toBe(0);
  });

  it("does not schedule a later group in the same phase until the earlier group is terminal", () => {
    const config = createConfig(["a", "b", "c"], {
      deps: { b: ["a"] },
      repoFor: { c: "svc2" },
    });
    config.delegation_map = {
      phases: [
        {
          id: "phase-1",
          groups: [
            { id: "g1", task_ids: ["a"] },
            { id: "g2", task_ids: ["b", "c"] },
          ],
        },
      ],
    };
    const state = createInitialState(config, "run1");
    const ready = ["a", "b", "c"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(["a"]);
    expect(state.delegation_phase_index).toBe(0);
    expect(state.delegation_group_index).toBe(0);
  });

  it("advances to the next group within a phase when the prior group is terminal", () => {
    const config = createConfig(["a", "b", "c"], {
      deps: { b: ["a"] },
      repoFor: { c: "svc2" },
    });
    config.delegation_map = {
      phases: [
        {
          id: "phase-1",
          groups: [
            { id: "g1", task_ids: ["a"] },
            { id: "g2", task_ids: ["b", "c"] },
          ],
        },
      ],
    };
    const state = createInitialState(config, "run1");
    state.agents.a!.status = "finished";
    const ready = ["b", "c"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(["b", "c"]);
    expect(state.delegation_phase_index).toBe(0);
    expect(state.delegation_group_index).toBe(1);
  });

  it("excludes tasks not assigned in the delegation map", () => {
    const config = createConfig(["a", "b", "x"], { deps: { b: ["a"] } });
    config.delegation_map = {
      phases: [
        { id: "phase-1", groups: [{ id: "group-1", task_ids: ["a"] }] },
        { id: "phase-2", groups: [{ id: "group-1", task_ids: ["b"] }] },
      ],
    };
    const state = createInitialState(config, "run1");
    const ready = ["a", "b", "x"];
    const eligible = filterEligibleReadyTasks(state, config, ready);
    expect(eligible).toEqual(["a"]);
    expect(state.delegation_phase_index).toBe(0);
    expect(state.delegation_group_index).toBe(0);
  });

  it("preserves eligibility after deserialize when delegation cursors were set", () => {
    const config = createConfig(["a", "b", "c"], {
      deps: { b: ["a"] },
      repoFor: { c: "svc2" },
    });
    config.delegation_map = {
      phases: [
        {
          id: "phase-1",
          groups: [
            { id: "g1", task_ids: ["a"] },
            { id: "g2", task_ids: ["b", "c"] },
          ],
        },
      ],
    };
    const state = createInitialState(config, "run1");
    state.agents.a!.status = "finished";
    filterEligibleReadyTasks(state, config, ["b", "c"]);
    expect(state.delegation_group_index).toBe(1);
    const restored = deserialize(serialize(state));
    const eligible = filterEligibleReadyTasks(restored, config, ["b", "c"]);
    expect(eligible).toEqual(["b", "c"]);
    expect(restored.delegation_phase_index).toBe(0);
    expect(restored.delegation_group_index).toBe(1);
  });
});

describe("runOrchestration validation gate", () => {
  it("aborts before repo writes when delegation_map fails validateConfig", async () => {
    const bad: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "p",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
      ],
      delegation_map: {
        phases: [{ id: "p1", groups: [{ id: "g1", task_ids: ["missing-id"] }] }],
      },
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "orch", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const yaml = toYaml(bad);
    let writeCount = 0;
    const repoStore = {
      async readFile(_runId: string, filePath: string): Promise<string> {
        if (filePath === "config.yaml") return yaml;
        throw new Error(`unexpected read: ${filePath}`);
      },
      async writeFile(): Promise<void> {
        writeCount += 1;
      },
      async deleteFile(): Promise<void> {},
      async updateFile(): Promise<void> {
        writeCount += 1;
      },
      rateLimitRemaining: null,
      rateLimitLimit: null,
    } as unknown as RepoStoreClient;
    const cursorClient = {} as unknown as CursorClient;
    await expect(runOrchestration("run-gate-1", cursorClient, repoStore)).rejects.toThrow(/unknown task/);
    expect(writeCount).toBe(0);
  });
});
