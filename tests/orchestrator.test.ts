import { describe, expect, it } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import type { AgentClient } from "../src/sdk/agent-client.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { toYaml } from "../src/config/parse.js";
import type { TaskConfig } from "../src/config/types.js";
import { buildRepoCreationPrompt } from "../src/prompt-builder.js";
import { extractDelegationPhases, filterEligibleReadyTasks, planRefForConsolidatedRunLine, runOrchestration } from "../src/orchestrator.js";
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

  it("extractDelegationPhases keeps multiple parallel groups from typed delegation_map", () => {
    const config = createConfig(["a", "b", "c"]);
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
    const phases = extractDelegationPhases(config, new Set(["a", "b", "c"]));
    expect(phases).not.toBeNull();
    expect(phases![0]!.groups).toHaveLength(2);
    expect(phases![0]!.groups[0]!.task_ids).toEqual(["a"]);
    expect(phases![0]!.groups[1]!.task_ids).toEqual(["b", "c"]);
  });

  it("extractDelegationPhases returns null when typed map has no overlap with known task ids", () => {
    const config = createConfig(["a"]);
    config.delegation_map = {
      phases: [{ id: "p1", groups: [{ id: "g1", task_ids: ["a"] }] }],
    };
    expect(extractDelegationPhases(config, new Set())).toBeNull();
  });

  it("eligibles multiple tasks in the same parallel group when both are ready", () => {
    const config = createConfig(["a", "b", "c"]);
    config.delegation_map = {
      phases: [
        {
          id: "phase-1",
          groups: [
            { id: "g0", task_ids: ["a"] },
            { id: "g1", task_ids: ["b", "c"] },
          ],
        },
      ],
    };
    const state = createInitialState(config, "run1");
    state.agents.a!.status = "finished";
    const eligible = filterEligibleReadyTasks(state, config, ["b", "c"]);
    expect(eligible).toEqual(["b", "c"]);
  });

  it("treats a failed task in the prior group as terminal for wave advancement", () => {
    const config = createConfig(["a", "b", "c"], { repoFor: { c: "svc2" } });
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
    state.agents.a!.status = "failed";
    const eligible = filterEligibleReadyTasks(state, config, ["b", "c"]);
    expect(eligible).toEqual(["b", "c"]);
    expect(state.delegation_group_index).toBe(1);
  });

  it("after mapped waves complete, eligible ready tasks are only those not in the delegation map (defensive)", () => {
    const config = createConfig(["a", "b", "u"]);
    config.delegation_map = {
      phases: [
        { id: "phase-1", groups: [{ id: "g1", task_ids: ["a"] }] },
        { id: "phase-2", groups: [{ id: "g1", task_ids: ["b"] }] },
      ],
    };
    const state = createInitialState(config, "run1");
    state.agents.a!.status = "finished";
    state.agents.b!.status = "finished";
    const eligible = filterEligibleReadyTasks(state, config, ["u", "a"]);
    expect(eligible).toEqual(["u"]);
  });

  it("repairs negative delegation cursor indices", () => {
    const config = createConfig(["a", "b", "c"], {
      deps: { b: ["a"] },
      repoFor: { c: "svc2" },
    });
    config.delegation_map = {
      phases: [
        { id: "phase-1", groups: [{ id: "g1", task_ids: ["a"] }] },
        { id: "phase-2", groups: [{ id: "g1", task_ids: ["b", "c"] }] },
      ],
    };
    const state = createInitialState(config, "run1");
    state.delegation_phase_index = -3;
    state.delegation_group_index = -1;
    const eligible = filterEligibleReadyTasks(state, config, ["a"]);
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

describe("planRefForConsolidatedRunLine", () => {
  it("returns null for create_repo", () => {
    const task = { create_repo: true } as TaskConfig;
    expect(planRefForConsolidatedRunLine(task, "main")).toBeNull();
  });
  it("returns resolved ref for __new__ surrogate", () => {
    const task = { create_repo: false } as TaskConfig;
    expect(planRefForConsolidatedRunLine(task, "develop")).toBe("develop");
  });
});

describe("buildRepoCreationPrompt consolidated run line", () => {
  it("includes exampleRunBranch when passed", () => {
    const task: TaskConfig = {
      id: "r1",
      repo: "svc",
      prompt: "create",
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: true,
      repo_config: null,
    };
    const example = "p/run-x/main";
    const p = buildRepoCreationPrompt(task, "run-x", {}, { exampleRunBranch: example });
    expect(p).toContain(example);
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
    const agentClient = {} as unknown as AgentClient;
    await expect(runOrchestration("run-gate-1", agentClient, repoStore)).rejects.toThrow(/unknown task/);
    expect(writeCount).toBe(0);
  });
});
