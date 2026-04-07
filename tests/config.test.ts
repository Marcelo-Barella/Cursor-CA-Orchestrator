import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { OrchestratorConfig, TaskConfig } from "../src/config/types.js";
import { parseConfig, toYaml } from "../src/config/parse.js";
import { canonicalizeOrchestratorConfig } from "../src/config/canonicalize.js";
import { resolveConfigPrecedence } from "../src/config/resolve.js";
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    const output = toYaml(config);
    expect(output).toContain("create_repo: true");
    expect(output).toContain("branch_layout: consolidated");
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/appears multiple times/);
  });

  it("validateConfig rejects delegation_map that does not assign all tasks", () => {
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
        phases: [{ id: "phase-1", groups: [{ id: "group-a", task_ids: ["t1"] }] }],
      },
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/must assign every task exactly once/);
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/later phase/);
  });

  it("validateConfig accepts same-phase dependency on an earlier group", () => {
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("validateConfig rejects impossible same-phase dependency on a later group", () => {
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
          {
            id: "phase-1",
            groups: [
              { id: "group-a", task_ids: ["t1"] },
              { id: "group-b", task_ids: ["t2"] },
            ],
          },
        ],
      },
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/later parallel group/);
  });

  it("resolveConfigPrecedence includes delegation_map from project YAML for validateConfig", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-orch-resolve-dm-"));
    const yamlPath = path.join(dir, "orch.yaml");
    const yaml = `
name: test
model: composer-2
prompt: "seed"
repositories:
  svc:
    url: https://github.com/o/r
    ref: main
tasks:
  - id: t1
    repo: svc
    prompt: p
delegation_map:
  phases:
    - id: phase-1
      groups:
        - id: g1
          task_ids: [t1]
target:
  auto_create_pr: true
  branch_prefix: cursor-orch
`;
    fs.writeFileSync(yamlPath, yaml, "utf8");
    const prevCk = process.env.CURSOR_API_KEY;
    const prevGh = process.env.GH_TOKEN;
    process.env.CURSOR_API_KEY = "test-key";
    process.env.GH_TOKEN = "test-token";
    try {
      const r = resolveConfigPrecedence(yamlPath, undefined);
      const blocking = r.findings.filter((f) => f.is_blocking);
      expect(blocking).toEqual([]);
      expect(r.config.delegation_map).toEqual({
        phases: [{ id: "phase-1", groups: [{ id: "g1", task_ids: ["t1"] }] }],
      });
    } finally {
      if (prevCk === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevCk;
      if (prevGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevGh;
    }
  });

  it("resolveConfigPrecedence surfaces delegation_map validation errors on merged config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-orch-resolve-dm-bad-"));
    const yamlPath = path.join(dir, "orch.yaml");
    const yaml = `
name: test
model: composer-2
prompt: "seed"
repositories:
  svc:
    url: https://github.com/o/r
    ref: main
tasks:
  - id: t1
    repo: svc
    prompt: p
delegation_map:
  phases:
    - id: phase-1
      groups:
        - id: g1
          task_ids: [not-a-task]
target:
  auto_create_pr: true
  branch_prefix: cursor-orch
`;
    fs.writeFileSync(yamlPath, yaml, "utf8");
    const prevCk = process.env.CURSOR_API_KEY;
    const prevGh = process.env.GH_TOKEN;
    process.env.CURSOR_API_KEY = "test-key";
    process.env.GH_TOKEN = "test-token";
    try {
      const r = resolveConfigPrecedence(yamlPath, undefined);
      const blocking = r.findings.filter((f) => f.is_blocking);
      expect(blocking.length).toBeGreaterThan(0);
      expect(blocking.some((f) => /unknown task/.test(f.message))).toBe(true);
    } finally {
      if (prevCk === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevCk;
      if (prevGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevGh;
    }
  });

  it("parseConfig defaults target.branch_layout to consolidated when omitted", () => {
    const yaml = `
name: test
tasks: []
target:
  auto_create_pr: true
  branch_prefix: cursor-orch
`;
    expect(parseConfig(yaml).target.branch_layout).toBe("consolidated");
  });

  it("parseConfig and toYaml round-trip target.branch_layout per_task", () => {
    const yaml = `
name: test
model: composer-2
prompt: seed
repositories:
  svc:
    url: https://github.com/o/r
    ref: main
tasks:
  - id: t1
    repo: svc
    prompt: p
target:
  auto_create_pr: true
  branch_prefix: p
  branch_layout: per_task
`;
    const c = parseConfig(yaml);
    expect(c.target.branch_layout).toBe("per_task");
    const again = parseConfig(toYaml(c));
    expect(again.target.branch_layout).toBe("per_task");
  });

  it("validateConfig rejects invalid target.branch_layout", () => {
    const target = {
      auto_create_pr: true,
      branch_prefix: "cursor-orch",
      branch_layout: "merged",
    } as unknown as OrchestratorConfig["target"];
    const config: OrchestratorConfig = {
      name: "t",
      model: "composer-2",
      prompt: "x",
      repositories: {},
      tasks: [],
      target,
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    expect(() => validateConfig(config)).toThrow(/branch_layout/);
  });

  it("resolveConfigPrecedence applies CURSOR_ORCH_BRANCH_LAYOUT over project YAML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-orch-resolve-bl-"));
    const yamlPath = path.join(dir, "orch.yaml");
    const yaml = `
name: test
model: composer-2
prompt: "seed"
repositories:
  svc:
    url: https://github.com/o/r
    ref: main
tasks:
  - id: t1
    repo: svc
    prompt: p
target:
  auto_create_pr: true
  branch_prefix: cursor-orch
  branch_layout: consolidated
`;
    fs.writeFileSync(yamlPath, yaml, "utf8");
    const prevCk = process.env.CURSOR_API_KEY;
    const prevGh = process.env.GH_TOKEN;
    const prevBl = process.env.CURSOR_ORCH_BRANCH_LAYOUT;
    process.env.CURSOR_API_KEY = "test-key";
    process.env.GH_TOKEN = "test-token";
    process.env.CURSOR_ORCH_BRANCH_LAYOUT = "per_task";
    try {
      const r = resolveConfigPrecedence(yamlPath, undefined);
      const blocking = r.findings.filter((f) => f.is_blocking);
      expect(blocking).toEqual([]);
      expect(r.config.target.branch_layout).toBe("per_task");
      expect(r.provenance["target.branch_layout"]?.source).toBe("env");
      expect(r.provenance["target.branch_layout"]?.source_ref).toBe("CURSOR_ORCH_BRANCH_LAYOUT");
    } finally {
      if (prevCk === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevCk;
      if (prevGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevGh;
      if (prevBl === undefined) delete process.env.CURSOR_ORCH_BRANCH_LAYOUT;
      else process.env.CURSOR_ORCH_BRANCH_LAYOUT = prevBl;
    }
  });
});
