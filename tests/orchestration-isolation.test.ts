import { describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../src/prompt-builder.js";
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

const plannerConfig: OrchestratorConfig = {
  name: "parallel-run",
  model: "gpt",
  prompt: "Ship the feature across repos.",
  repositories: {
    backend: { url: "https://github.com/acme/backend", ref: "main" },
  },
  tasks: [],
  target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
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
      "gh-token",
      {},
      "bootstrap-owner",
      "bootstrap-repo",
    );

    expect(prompt).toContain("/tmp/cursor-orch-run-123-sync-backend-payload.json");
    expect(prompt).toContain('branch: "run/run-123"');
  });

  it("writes planner output to a run-scoped temp path", () => {
    const prompt = buildPlannerPrompt(
      plannerConfig,
      "run-123",
      "gh-token",
      "bootstrap-owner",
      "bootstrap-repo",
    );

    expect(prompt).toContain("/tmp/cursor-orch-run-123-task-plan.json");
    expect(prompt).toContain('branch="run/run-123"');
  });
});
