import { describe, expect, it } from "vitest";
import type { TaskConfig } from "../src/config/types.js";
import { buildWorkerPrompt } from "../src/prompt-builder.js";

describe("buildWorkerPrompt claims", () => {
  it("includes allowed_paths and forbids run-branch pushes", () => {
    const task: TaskConfig = {
      id: "t1",
      repo: "svc",
      prompt: "do it",
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
      allowed_paths: ["src/api"],
    };
    const prompt = buildWorkerPrompt(task, "run1", {}, {
      runBranch: "cursor-orch/run1/main/run",
      perTaskBranch: "cursor-orch/run1/t1",
      claimsMode: true,
    });
    expect(prompt).toContain("src/api");
    expect(prompt).toMatch(/do not push .*\/run/i);
    expect(prompt).toMatch(/do not open (a )?PR/i);
  });
});
