import { describe, expect, it } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import type { AgentClient } from "../src/sdk/agent-client.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { toYaml } from "../src/config/parse.js";
import type { TaskConfig } from "../src/config/types.js";
import { buildRepoCreationPrompt } from "../src/prompt-builder.js";
import {
  extractDelegationPhases,
  filterEligibleReadyTasks,
  getBlockedTasks,
  getReadyTasks,
  pickReattachRun,
  planRefForConsolidatedRunLine,
  reconcileInFlightLaunchesFromEvents,
  runOrchestration,
} from "../src/orchestrator.js";
import type { AgentState, OrchestrationEvent } from "../src/state.js";
import { createInitialState, deserialize, serialize } from "../src/state.js";

function createConfig(
  taskIds: string[],
  opts?: { deps?: Record<string, string[]>; repoFor?: Record<string, string> },
): OrchestratorConfig {
  const deps = opts?.deps ?? {};
  const repoFor = opts?.repoFor ?? {};
  return {
    name: "n",
    model: { id: "m" },
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

describe("getBlockedTasks", () => {
  it("returns only agents in blocked status", () => {
    const agent = (taskId: string, status: string): AgentState => ({
      task_id: taskId,
      agent_id: null,
      status,
      started_at: null,
      finished_at: null,
      branch_name: null,
      pr_url: null,
      summary: null,
      blocked_reason: status === "blocked" ? "stuck" : null,
      blocked_since: status === "blocked" ? "2026-05-28T00:00:00.000Z" : null,
      retry_count: 0,
      blocked_retry_count: 0,
      cascade_source_task_id: null,
    });
    const blocked = getBlockedTasks({
      a: agent("a", "blocked"),
      b: agent("b", "running"),
      c: agent("c", "pending"),
    });
    expect(blocked.map((a) => a.task_id)).toEqual(["a"]);
  });
});

describe("getReadyTasks", () => {
  it("exposes a dependent task only after upstream tasks are finished", () => {
    const graph = { t1: new Set<string>(), t2: new Set(["t1"]) };
    const agent = (taskId: string, status: string): AgentState => ({
      task_id: taskId,
      agent_id: null,
      status,
      started_at: null,
      finished_at: null,
      branch_name: null,
      pr_url: null,
      summary: null,
      blocked_reason: null,
      blocked_since: null,
      retry_count: 0,
      blocked_retry_count: 0,
      cascade_source_task_id: null,
    });
    expect(
      getReadyTasks(graph, {
        t1: agent("t1", "pending"),
        t2: agent("t2", "pending"),
      }),
    ).toEqual(["t1"]);
    expect(
      getReadyTasks(graph, {
        t1: agent("t1", "finished"),
        t2: agent("t2", "pending"),
      }),
    ).toEqual(["t2"]);
  });

  it("excludes pending tasks that have no agent entry", () => {
    const graph = { t1: new Set<string>(), t2: new Set(["t1"]) };
    const agent = (taskId: string, status: string): AgentState => ({
      task_id: taskId,
      agent_id: null,
      status,
      started_at: null,
      finished_at: null,
      branch_name: null,
      pr_url: null,
      summary: null,
      blocked_reason: null,
      blocked_since: null,
      retry_count: 0,
      blocked_retry_count: 0,
      cascade_source_task_id: null,
    });
    expect(getReadyTasks(graph, {})).toEqual([]);
    expect(
      getReadyTasks(graph, {
        t1: agent("t1", "finished"),
      }),
    ).toEqual([]);
  });
});

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

  it("extractDelegationPhases parses loose waves format with camelCase keys", () => {
    const config = createConfig(["a", "b"]) as OrchestratorConfig & {
      delegationMap?: unknown;
    };
    config.delegation_map = undefined;
    config.delegationMap = {
      waves: [
        {
          phase_id: "wave-1",
          parallelGroups: [{ taskIds: ["a"] }, { tasks: ["b"] }],
        },
      ],
    };
    const phases = extractDelegationPhases(config, new Set(["a", "b"]));
    expect(phases).not.toBeNull();
    expect(phases).toHaveLength(1);
    expect(phases![0]!.id).toBe("wave-1");
    expect(phases![0]!.groups).toHaveLength(1);
    expect(phases![0]!.groups[0]!.task_ids).toEqual(["a", "b"]);
  });

  it("extractDelegationPhases parses legacy delegationMap waves and parallel_groups", () => {
    const config = createConfig(["a", "b", "c"]) as OrchestratorConfig & {
      delegationMap?: unknown;
    };
    config.delegationMap = {
      waves: [
        {
          phase_id: "wave-1",
          parallel_groups: [{ tasks: ["a", "b"] }],
        },
        {
          name: "wave-2",
          parallelGroups: [{ taskIds: ["c"] }],
        },
      ],
    };
    const phases = extractDelegationPhases(config, new Set(["a", "b", "c"]));
    expect(phases).toEqual([
      { id: "wave-1", groups: [{ id: "group-1", task_ids: ["a", "b"] }] },
      { id: "wave-2", groups: [{ id: "group-1", task_ids: ["c"] }] },
    ]);
  });

  it("extractDelegationPhases legacy path drops unknown task ids", () => {
    const config = createConfig(["a"]) as OrchestratorConfig & { delegationMap?: unknown };
    config.delegationMap = {
      waves: [{ tasks: ["a", "ghost"] }],
    };
    const phases = extractDelegationPhases(config, new Set(["a", "b"]));
    expect(phases).toEqual([{ id: "phase-1", groups: [{ id: "group-1", task_ids: ["a"] }] }]);
  });

  it("extractDelegationPhases parses legacy waves with parallel_groups and tasks fields", () => {
    const config = createConfig(["a", "b", "c"]);
    config.delegation_map = undefined;
    Object.assign(config as unknown as Record<string, unknown>, {
      delegation_map: {
        waves: [
          {
            phase_id: "wave-1",
            parallel_groups: [
              { id: "pg1", tasks: ["a", "b"] },
              { id: "pg2", taskIds: ["c"] },
            ],
          },
        ],
      },
    });
    const phases = extractDelegationPhases(config, new Set(["a", "b", "c"]));
    expect(phases).toEqual([
      {
        id: "wave-1",
        groups: [
          { id: "group-1", task_ids: ["a", "b", "c"] },
        ],
      },
    ]);
  });

  it("extractDelegationPhases parses legacy delegationMap camelCase phase task lists", () => {
    const config = createConfig(["a", "b"]);
    config.delegation_map = undefined;
    Object.assign(config as unknown as Record<string, unknown>, {
      delegationMap: {
        phases: [{ name: "setup", tasks: ["a"] }, { id: "run", tasks: ["b"] }],
      },
    });
    const phases = extractDelegationPhases(config, new Set(["a", "b"]));
    expect(phases).toEqual([
      { id: "setup", groups: [{ id: "group-1", task_ids: ["a"] }] },
      { id: "run", groups: [{ id: "group-1", task_ids: ["b"] }] },
    ]);
  });

  it("filterEligibleReadyTasks honors legacy delegation_map wave ordering", () => {
    const config = createConfig(["a", "b"]);
    config.delegation_map = undefined;
    Object.assign(config as unknown as Record<string, unknown>, {
      delegation_map: {
        waves: [{ id: "p1", tasks: ["a"] }, { id: "p2", tasks: ["b"] }],
      },
    });
    const state = createInitialState(config, "run1");
    expect(filterEligibleReadyTasks(state, config, ["a", "b"])).toEqual(["a"]);
    state.agents.a!.status = "finished";
    expect(filterEligibleReadyTasks(state, config, ["a", "b"])).toEqual(["b"]);
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

  it.each(["failed", "stopped"] as const)(
    "treats a %s task in the prior group as terminal for wave advancement",
    (terminalStatus) => {
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
      state.agents.a!.status = terminalStatus;
      const eligible = filterEligibleReadyTasks(state, config, ["b", "c"]);
      expect(eligible).toEqual(["b", "c"]);
      expect(state.delegation_group_index).toBe(1);
    },
  );

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

  it("does not treat a delegation group as terminal when a mapped task has no agent entry", () => {
    const config = createConfig(["a", "b"]);
    config.delegation_map = {
      phases: [{ id: "phase-1", groups: [{ id: "g1", task_ids: ["a", "b"] }] }],
    };
    const state = createInitialState(config, "run1");
    state.agents.a!.status = "finished";
    delete state.agents.b;
    const eligible = filterEligibleReadyTasks(state, config, ["b"]);
    expect(eligible).toEqual(["b"]);
    expect(state.delegation_phase_index).toBe(0);
    expect(state.delegation_group_index).toBe(0);
  });

  it("repairs delegation cursor past end when mapped tasks are still pending", () => {
    const config = createConfig(["a", "b"]);
    config.delegation_map = {
      phases: [{ id: "phase-1", groups: [{ id: "g1", task_ids: ["a", "b"] }] }],
    };
    const state = createInitialState(config, "run1");
    state.delegation_phase_index = 5;
    state.delegation_group_index = 0;
    const eligible = filterEligibleReadyTasks(state, config, ["a", "b"]);
    expect(eligible).toEqual(["a", "b"]);
    expect(state.delegation_phase_index).toBe(0);
    expect(state.delegation_group_index).toBe(0);
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

  it("repairs delegation_phase_index past end when config has fewer phases than state", () => {
    const config = createConfig(["a", "b"], { deps: { b: ["a"] } });
    config.delegation_map = {
      phases: [
        { id: "phase-1", groups: [{ id: "g1", task_ids: ["a"] }] },
        { id: "phase-2", groups: [{ id: "g1", task_ids: ["b"] }] },
      ],
    };
    const state = createInitialState(config, "run1");
    state.delegation_phase_index = 99;
    state.delegation_group_index = 0;
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
  it("rejects corrupt state.json instead of resetting orchestration progress", async () => {
    const config = createConfig(["a"]);
    const repoStore = {
      async readFile(_runId: string, filename: string): Promise<string> {
        if (filename === "config.yaml") return toYaml(config);
        if (filename === "state.json") return "{not valid json";
        return "";
      },
      async writeFile(): Promise<void> {},
      async updateFile(): Promise<void> {},
      async deleteFile(): Promise<void> {},
    } as unknown as RepoStoreClient;
    const agentClient = { createCloudAgent: async () => ({ agentId: "x" }) } as unknown as AgentClient;
    await expect(runOrchestration("run-corrupt-state", agentClient, repoStore)).rejects.toThrow(/Invalid state\.json/);
  });

  it("rejects empty state.json when events.jsonl shows an in-progress run", async () => {
    const config = createConfig(["a"]);
    const repoStore = {
      async readFile(_runId: string, filename: string): Promise<string> {
        if (filename === "config.yaml") return toYaml(config);
        if (filename === "state.json") return "";
        if (filename === "events.jsonl") {
          return `${JSON.stringify({ timestamp: "2026-06-01T00:00:00.000Z", event_type: "orchestration_started", task_id: null, detail: "started" })}\n`;
        }
        return "";
      },
      async writeFile(): Promise<void> {},
      async updateFile(): Promise<void> {},
      async deleteFile(): Promise<void> {},
    } as unknown as RepoStoreClient;
    const agentClient = { createCloudAgent: async () => ({ agentId: "x" }) } as unknown as AgentClient;
    await expect(runOrchestration("run-empty-state", agentClient, repoStore)).rejects.toThrow(/refusing to reset orchestration progress/);
  });

  it("propagates events.jsonl read errors when state.json is empty", async () => {
    const config = createConfig(["a"]);
    const repoStore = {
      async readFile(_runId: string, filename: string): Promise<string> {
        if (filename === "config.yaml") return toYaml(config);
        if (filename === "state.json") return "";
        if (filename === "events.jsonl") {
          throw new Error("GitHub API rate limited");
        }
        return "";
      },
      async writeFile(): Promise<void> {},
      async updateFile(): Promise<void> {},
      async deleteFile(): Promise<void> {},
    } as unknown as RepoStoreClient;
    const agentClient = { createCloudAgent: async () => ({ agentId: "x" }) } as unknown as AgentClient;
    await expect(runOrchestration("run-events-read-fail", agentClient, repoStore)).rejects.toThrow(
      /GitHub API rate limited/,
    );
  });

  it("aborts before repo writes when delegation_map fails validateConfig", async () => {
    const bad: OrchestratorConfig = {
      name: "n",
      model: { id: "m" },
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
        if (filePath === "state.json") return "";
        if (filePath === "events.jsonl") return "";
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

describe("pickReattachRun", () => {
  it("prefers a running run over a newer finished run", () => {
    const staleFinished = { status: "finished" as const, createdAt: 200 };
    const activeRunning = { status: "running" as const, createdAt: 100 };
    expect(pickReattachRun([staleFinished, activeRunning] as never)).toBe(activeRunning);
  });

  it("falls back to the newest createdAt when no run is running", () => {
    const older = { status: "finished" as const, createdAt: 100 };
    const newer = { status: "finished" as const, createdAt: 200 };
    expect(pickReattachRun([older, newer] as never)).toBe(newer);
  });
});

describe("reconcileInFlightLaunchesFromEvents", () => {
  it("restores agent_id for pending tasks with a later task_launched event", () => {
    const config = createConfig(["t1"]);
    const state = createInitialState(config, "run-recover");
    const events: OrchestrationEvent[] = [
      {
        timestamp: "2026-06-01T00:00:00.000Z",
        event_type: "task_launched",
        task_id: "t1",
        phase_id: "execution",
        agent_node_id: "t1",
        agent_kind: "task",
        detail: "Launched t1 (agent-live-9)",
        payload: {
          agent_id: "agent-live-9",
          run_id: "run-9",
          repository: "https://github.com/acme/svc",
          ref: "main",
          branch: "cursor-orch/run-recover/t1",
        },
      },
    ];
    expect(reconcileInFlightLaunchesFromEvents(state, events)).toBe(true);
    expect(state.agents.t1!.agent_id).toBe("agent-live-9");
    expect(state.agents.t1!.status).toBe("launching");
    expect(state.agents.t1!.branch_name).toBe("cursor-orch/run-recover/t1");
  });

  it("ignores stale launches cleared by a terminal task event", () => {
    const config = createConfig(["t1"]);
    const state = createInitialState(config, "run-recover-stale");
    const events: OrchestrationEvent[] = [
      {
        timestamp: "2026-06-01T00:00:00.000Z",
        event_type: "task_launched",
        task_id: "t1",
        phase_id: "execution",
        agent_node_id: "t1",
        agent_kind: "task",
        detail: "Launched t1 (agent-old)",
        payload: { agent_id: "agent-old", run_id: "run-old" },
      },
      {
        timestamp: "2026-06-01T00:01:00.000Z",
        event_type: "task_failed",
        task_id: "t1",
        phase_id: null,
        agent_node_id: "t1",
        agent_kind: "task",
        detail: "Task t1 failed",
        payload: {},
      },
    ];
    expect(reconcileInFlightLaunchesFromEvents(state, events)).toBe(false);
    expect(state.agents.t1!.agent_id).toBeNull();
    expect(state.agents.t1!.status).toBe("pending");
  });
});
