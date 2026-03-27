import { describe, expect, it } from "vitest";
import { OrchestratorConfig, TaskConfig } from "../src/config/types.js";
import { parseConfig, toYaml } from "../src/config/parse.js";
import { canonicalizeOrchestratorConfig } from "../src/config/canonicalize.js";
import { validateConfig, validateRepoRefs } from "../src/config/validate.js";

describe("config", () => {
  it("task config create_repo defaults", () => {
    const task: TaskConfig = {
      id: "t1",
      repo: "r",
      prompt: "p",
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
    };
    expect(task.create_repo).toBe(false);
    expect(task.repo_config).toBeNull();
  });

  it("toYaml includes create_repo", () => {
    const config: OrchestratorConfig = {
      name: "test",
      model: "composer-2",
      prompt: "",
      repositories: {},
      tasks: [
        {
          id: "create-it",
          repo: "__new__",
          prompt: "make repo",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: true,
          repo_config: null,
        },
      ],
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    const output = toYaml(config);
    expect(output).toContain("create_repo: true");
  });

  it("validate repo refs skips create_repo", () => {
    const repos = { backend: { url: "https://github.com/o/backend", ref: "main" } };
    const tasks: TaskConfig[] = [
      {
        id: "new-repo",
        repo: "__new__",
        prompt: "create",
        model: null,
        depends_on: [],
        timeout_minutes: 30,
        create_repo: true,
        repo_config: null,
      },
    ];
    validateRepoRefs(tasks, repos);
  });

  it("validate repo refs accepts repo name that matches URL-keyed repository", () => {
    const repos = { "https://github.com/o/bergamota.git": { url: "https://github.com/o/bergamota.git", ref: "main" } };
    const tasks: TaskConfig[] = [
      {
        id: "motion-doc",
        repo: "bergamota",
        prompt: "write docs",
        model: null,
        depends_on: [],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
    ];
    validateRepoRefs(tasks, repos);
  });

  it("parseConfig corrects swapped url and ref when ref holds the GitHub URL", () => {
    const yaml = `
name: test
repositories:
  svc:
    url: main
    ref: "https://github.com/o/r"
tasks: []
target:
  auto_create_pr: true
  branch_prefix: cursor-orch
`;
    const config = parseConfig(yaml);
    expect(config.repositories.svc!.url).toBe("https://github.com/o/r");
    expect(config.repositories.svc!.ref).toBe("main");
  });

  it("validateConfig rejects unresolvable repository url (typo in url field)", () => {
    const config: OrchestratorConfig = {
      name: "t",
      model: "composer-2",
      prompt: "goal",
      repositories: {
        "https://github.com/o/bergamota.git": { url: "bergamta", ref: "main" },
      },
      tasks: [],
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/bergamta/);
  });

  it("canonicalizeOrchestratorConfig rewrites repositories and tasks to canonical GitHub URLs", () => {
    const config: OrchestratorConfig = {
      name: "t",
      model: "composer-2",
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
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    const c = canonicalizeOrchestratorConfig(config);
    expect(c.repositories["https://github.com/o/r"]).toEqual({ url: "https://github.com/o/r", ref: "main" });
    expect(c.tasks[0]!.repo).toBe("https://github.com/o/r");
  });

  it("canonicalizeOrchestratorConfig preserves __bootstrap__ entry", () => {
    const config: OrchestratorConfig = {
      name: "t",
      model: "m",
      prompt: "p",
      repositories: {
        svc: { url: "https://github.com/o/r", ref: "main" },
        __bootstrap__: { url: "https://github.com/u/b", ref: "main" },
      },
      tasks: [],
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    const c = canonicalizeOrchestratorConfig(config);
    expect(c.repositories["__bootstrap__"]).toEqual({ url: "https://github.com/u/b", ref: "main" });
    expect(c.repositories["https://github.com/o/r"]).toEqual({ url: "https://github.com/o/r", ref: "main" });
  });

  it("parseConfig leaves correct url and ref unchanged", () => {
    const yaml = `
name: test
repositories:
  svc:
    url: "https://github.com/o/r"
    ref: main
tasks: []
target:
  auto_create_pr: true
  branch_prefix: cursor-orch
`;
    const config = parseConfig(yaml);
    expect(config.repositories.svc!.url).toBe("https://github.com/o/r");
    expect(config.repositories.svc!.ref).toBe("main");
  });

  it("parseConfig accepts delegationMap camelCase and normalizes to delegation_map", () => {
    const yaml = `
name: test
tasks:
  - id: t1
    repo: svc
    prompt: p1
  - id: t2
    repo: svc
    prompt: p2
    depends_on: [t1]
repositories:
  svc:
    url: "https://github.com/o/r"
    ref: main
delegationMap:
  phases:
    - id: phase-a
      parallelGroups:
        - id: group-a
          taskIds: [t1, t2]
target:
  auto_create_pr: true
  branch_prefix: cursor-orch
`;
    const config = parseConfig(yaml);
    expect(config.delegation_map).toEqual({
      phases: [{ id: "phase-a", groups: [{ id: "group-a", task_ids: ["t1", "t2"] }] }],
    });
  });

  it("validateConfig rejects delegation_map unknown task reference", () => {
    const config: OrchestratorConfig = {
      name: "t",
      model: "composer-2",
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
        phases: [{ id: "phase-1", groups: [{ id: "group-1", task_ids: ["missing"] }] }],
      },
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/unknown task 'missing'/);
  });

  it("validateConfig rejects task repeated in multiple delegation groups", () => {
    const config: OrchestratorConfig = {
      name: "t",
      model: "composer-2",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "p1",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
        {
          id: "t2",
          repo: "svc",
          prompt: "p2",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
      ],
      delegation_map: {
        phases: [
          {
            id: "phase-1",
            groups: [
              { id: "group-a", task_ids: ["t1"] },
              { id: "group-b", task_ids: ["t1", "t2"] },
            ],
          },
        ],
      },
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/appears multiple times/);
  });

  it("validateConfig rejects impossible cross-phase dependency ordering", () => {
    const config: OrchestratorConfig = {
      name: "t",
      model: "composer-2",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "p1",
          model: null,
          depends_on: ["t2"],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
        {
          id: "t2",
          repo: "svc",
          prompt: "p2",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
      ],
      delegation_map: {
        phases: [
          { id: "phase-1", groups: [{ id: "group-a", task_ids: ["t1"] }] },
          { id: "phase-2", groups: [{ id: "group-b", task_ids: ["t2"] }] },
        ],
      },
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/later phase/);
  });

  it("validateConfig rejects impossible same-phase cross-group dependency ordering", () => {
    const config: OrchestratorConfig = {
      name: "t",
      model: "composer-2",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "p1",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
        {
          id: "t2",
          repo: "svc",
          prompt: "p2",
          model: null,
          depends_on: ["t1"],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
      ],
      delegation_map: {
        phases: [
          {
            id: "phase-1",
            groups: [
              { id: "group-a", task_ids: ["t1"] },
              { id: "group-b", task_ids: ["t2"] },
            ],
          },
        ],
      },
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/parallel group/);
  });
});
