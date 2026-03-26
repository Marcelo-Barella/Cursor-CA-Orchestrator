import { describe, expect, it } from "vitest";
import { parseTaskPlan } from "../src/planner.js";
import type { OrchestratorConfig } from "../src/config/types.js";

describe("planner", () => {
  it("parses minimal task plan", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
      tasks: [],
      target: { auto_create_pr: true, branch_prefix: "p" },
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
  });

  it("resolves repo name to URL-keyed repository alias", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: { "https://github.com/o/bergamota.git": { url: "https://github.com/o/bergamota.git", ref: "main" } },
      tasks: [],
      target: { auto_create_pr: true, branch_prefix: "p" },
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
