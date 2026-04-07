import { describe, expect, it } from "vitest";
import { parseTaskPlan } from "../src/planner.js";
import type { OrchestratorConfig } from "../src/config/types.js";

describe("planner", () => {
  it("parses minimal legacy task plan without delegation map", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [],
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const json = JSON.stringify({
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "do work",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    const tasks = parseTaskPlan(json, config);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("t1");
    expect(config.delegation_map).toBeNull();
  });

  it("parses task plan with delegation map phases and groups", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [],
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const json = JSON.stringify({
      delegation_map: {
        version: 1,
        phases: [
          {
            id: "phase-1",
            parallel_groups: [{ id: "group-a", tasks: ["t1"] }],
          },
        ],
      },
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "do work",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    const tasks = parseTaskPlan(json, config);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("t1");
    expect(config.delegation_map).toEqual({
      phases: [{ id: "phase-1", groups: [{ id: "group-a", task_ids: ["t1"] }] }],
    });
  });

  it("rejects delegation map that references unknown task IDs", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [],
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const json = JSON.stringify({
      delegation_map: {
        version: 1,
        phases: [
          {
            id: "phase-1",
            parallel_groups: [{ id: "group-a", tasks: ["t-missing"] }],
          },
        ],
      },
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "do work",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    expect(() => parseTaskPlan(json, config)).toThrow(/Delegation map references unknown task/);
  });

  it("resolves repo name to URL-keyed repository alias", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: { "https://github.com/o/bergamota.git": { url: "https://github.com/o/bergamota.git", ref: "main" } },
      tasks: [],
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const json = JSON.stringify({
      tasks: [
        {
          id: "t1",
          repo: "bergamota",
          prompt: "do work",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    const tasks = parseTaskPlan(json, config);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.repo).toBe("https://github.com/o/bergamota.git");
  });
});
