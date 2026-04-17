import { describe, expect, it } from "vitest";
import { parseTaskPlan } from "../src/planner.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { validateConfig } from "../src/config/validate.js";

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

  it("parseTaskPlan merged config fails validateConfig when delegation_map omits a task", () => {
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
        phases: [{ id: "phase-1", parallel_groups: [{ id: "group-a", tasks: ["t1"] }] }],
      },
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "do work",
          depends_on: [],
          timeout_minutes: 30,
        },
        {
          id: "t2",
          repo: "svc",
          prompt: "more work",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    const tasks = parseTaskPlan(json, config);
    config.tasks = tasks;
    expect(() => validateConfig(config)).toThrow(/must assign every task exactly once/);
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

  it("resolves repo to create_repo task id and injects depends_on when two create_repo tasks exist", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: {},
      tasks: [],
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const json = JSON.stringify({
      tasks: [
        {
          id: "create-backend-repo",
          repo: "__new__",
          prompt: "create backend",
          depends_on: [],
          timeout_minutes: 30,
          create_repo: true,
          repo_config: { url_template: "https://github.com/{owner}/{repo_name}", ref: "main" },
        },
        {
          id: "create-frontend-repo",
          repo: "__new__",
          prompt: "create frontend",
          depends_on: [],
          timeout_minutes: 30,
          create_repo: true,
          repo_config: { url_template: "https://github.com/{owner}/{repo_name}", ref: "main" },
        },
        {
          id: "ui-financial-core-and-dashboards",
          repo: "create-frontend-repo",
          prompt: "build dashboards",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    const tasks = parseTaskPlan(json, config);
    const ui = tasks.find((t) => t.id === "ui-financial-core-and-dashboards");
    expect(ui?.repo).toBe("__new__");
    expect(ui?.depends_on).toContain("create-frontend-repo");
  });

  it("resolves tideglass-style plan when repo is the create_repo task id", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: {},
      tasks: [],
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const json = JSON.stringify({
      tasks: [
        {
          id: "create-repo-tideglass-metrics-api",
          repo: "__new__",
          prompt: "create api",
          depends_on: [],
          timeout_minutes: 30,
          create_repo: true,
          repo_config: { url_template: "https://github.com/{owner}/{repo_name}", ref: "main" },
        },
        {
          id: "create-repo-tideglass-web",
          repo: "__new__",
          prompt: "create web",
          depends_on: [],
          timeout_minutes: 30,
          create_repo: true,
          repo_config: { url_template: "https://github.com/{owner}/{repo_name}", ref: "main" },
        },
        {
          id: "tideglass-web-generated-client-only-integration",
          repo: "create-repo-tideglass-web",
          prompt: "build",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    const tasks = parseTaskPlan(json, config);
    const dash = tasks.find((t) => t.id === "tideglass-web-generated-client-only-integration");
    expect(dash?.repo).toBe("__new__");
    expect(dash?.depends_on).toContain("create-repo-tideglass-web");
  });

  it("rejects __new__ downstream task when multiple create_repo tasks exist and repo is not disambiguated", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: {},
      tasks: [],
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const json = JSON.stringify({
      tasks: [
        {
          id: "create-a",
          repo: "__new__",
          prompt: "a",
          depends_on: [],
          timeout_minutes: 30,
          create_repo: true,
          repo_config: { url_template: "https://github.com/{owner}/{repo_name}", ref: "main" },
        },
        {
          id: "create-b",
          repo: "__new__",
          prompt: "b",
          depends_on: [],
          timeout_minutes: 30,
          create_repo: true,
          repo_config: { url_template: "https://github.com/{owner}/{repo_name}", ref: "main" },
        },
        {
          id: "orphan-impl",
          repo: "__new__",
          prompt: "work",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    expect(() => parseTaskPlan(json, config)).toThrow(/Set "repo" to the id of the create_repo task/);
  });
});
