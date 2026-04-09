import { describe, expect, it } from "vitest";
import { buildRepoCreationPrompt, buildWorkerPrompt } from "../src/prompt-builder.js";
import { buildPlannerPrompt } from "../src/planner.js";
import { computeBranchName } from "../src/orchestrator.js";
import type { OrchestratorConfig, TaskConfig } from "../src/config/types.js";

const workerTask: TaskConfig = {
  id: "sync-backend",
  repo: "backend",
  prompt: "Ship the API change.",
  model: null,
  depends_on: [],
  timeout_minutes: 30,
  create_repo: false,
  repo_config: null,
};

const LEAK_PROBE = "gh-token-leak-check";

const repoCreateTask: TaskConfig = {
  id: "create-backend",
  repo: "__new__",
  prompt: "Create a new repo.",
  model: null,
  depends_on: [],
  timeout_minutes: 30,
  create_repo: true,
  repo_config: { url_template: "https://github.com/{owner}/{repo_name}", ref: "main" },
};

const plannerConfig: OrchestratorConfig = {
  name: "parallel-run",
  model: "gpt",
  prompt: "Ship the feature across repos.",
  repositories: {
    backend: { url: "https://github.com/acme/backend", ref: "main" },
  },
  tasks: [],
  target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
  bootstrap_repo_name: "cursor-orch-bootstrap",
};

describe("orchestration isolation", () => {
  it("scopes worker branches by run id", () => {
    expect(computeBranchName("cursor-orch", "run-123", "sync-backend", 0)).toBe(
      "cursor-orch/run-123/sync-backend",
    );
  });

  it("keeps retry suffix on run-scoped worker branches", () => {
    expect(computeBranchName("cursor-orch", "run-123", "sync-backend", 2)).toBe(
      "cursor-orch/run-123/sync-backend-retry-2",
    );
  });

  it("writes worker payloads to a run-scoped temp path", () => {
    const prompt = buildWorkerPrompt(
      workerTask,
      "run-123",
      {},
      "bootstrap-owner",
      "bootstrap-repo",
    );

    expect(prompt).toContain("/tmp/cursor-orch-run-123-sync-backend-payload.json");
    expect(prompt).toContain('branch: "run/run-123"');
  });

  it("injects git run-line section when opts.runBranch is set", () => {
    const prompt = buildWorkerPrompt(workerTask, "run-123", {}, "o", "b", {
      runBranch: "cursor-orch/run-123/main/run",
      launchRef: "main",
      perTaskBranch: "cursor-orch/run-123/sync-backend",
    });
    expect(prompt).toContain("GIT TARGET (run-line workflow):");
    expect(prompt).toContain('branch "cursor-orch/run-123/main/run"');
    expect(prompt).toContain("Do not create a pull request yourself");
  });

  it("writes planner output to a run-scoped temp path", () => {
    const prompt = buildPlannerPrompt(
      plannerConfig,
      "run-123",
      "bootstrap-owner",
      "bootstrap-repo",
    );

    expect(prompt).toContain("/tmp/cursor-orch-run-123-task-plan.json");
    expect(prompt).toContain('branch="run/run-123"');
  });

  it("does not embed probe secrets or token-in-prompt patterns in agent prompts", () => {
    const worker = buildWorkerPrompt(workerTask, "run-123", {}, "o", "b");
    const planner = buildPlannerPrompt(plannerConfig, "run-123", "o", "b");
    const repoCreate = buildRepoCreationPrompt(repoCreateTask, "run-123", {}, "o", "b");
    for (const p of [worker, planner, repoCreate]) {
      expect(p).not.toContain(LEAK_PROBE);
      expect(p).not.toMatch(/GH_TOKEN="/);
    }
    expect(worker).not.toContain("x-access-token:");
    expect(repoCreate).not.toContain("x-access-token:");
    expect(planner).not.toContain("Authorization: token <GH_TOKEN>");
  });
});
