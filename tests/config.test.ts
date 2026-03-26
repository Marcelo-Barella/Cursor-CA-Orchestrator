import { describe, expect, it } from "vitest";
import { OrchestratorConfig, TaskConfig } from "../src/config/types.js";
import { parseConfig, toYaml } from "../src/config/parse.js";
import { validateRepoRefs } from "../src/config/validate.js";

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
      model: "default",
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
});
