import { describe, expect, it } from "vitest";
import { buildFixTasks, isFixWaveTaskId, resolveClaimsWorkerForkBase } from "../../src/engine/fix-plan.js";

describe("fix wave task helpers", () => {
  it("detects fix wave task ids", () => {
    expect(isFixWaveTaskId("fix-iter-1-code_quality")).toBe(true);
    expect(isFixWaveTaskId("t-a")).toBe(false);
  });

  it("forks fix workers from the integrated run branch", () => {
    expect(
      resolveClaimsWorkerForkBase({
        taskId: "fix-iter-2-code_review",
        branchPrefix: "cursor-orch",
        runId: "run-1",
        repoRef: "main",
        planRef: "main",
      }),
    ).toBe("cursor-orch/run-1/main/run");
  });

  it("forks initial implement workers from the repo ref", () => {
    expect(
      resolveClaimsWorkerForkBase({
        taskId: "t-a",
        branchPrefix: "cursor-orch",
        runId: "run-1",
        repoRef: "main",
        planRef: "main",
      }),
    ).toBe("main");
  });
});

describe("buildFixTasks", () => {
  it("builds fix tasks with path claims from findings", () => {
    const built = buildFixTasks({
      iteration: 1,
      repoAlias: "svc",
      results: [
        {
          gate: "code_quality",
          passed: false,
          summary: "x",
          findings: [{ severity: "blocking", message: "complex", path: "src/foo.ts" }],
        },
      ],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.tasks[0]!.id).toBe("fix-iter-1-code_quality");
      expect(built.tasks[0]!.allowed_paths).toEqual(["src/foo.ts"]);
      expect(built.tasks[0]!.repo).toBe("svc");
    }
  });

  it("flags claim collisions across fix tasks", () => {
    const built = buildFixTasks({
      iteration: 2,
      repoAlias: "svc",
      results: [
        {
          gate: "code_quality",
          passed: false,
          summary: "",
          findings: [{ severity: "blocking", message: "a", path: "src" }],
        },
        {
          gate: "code_review",
          passed: false,
          summary: "",
          findings: [{ severity: "blocking", message: "b", path: "src/a.ts" }],
        },
      ],
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.claimCollision).toBe(true);
  });

  it("flags collision when pathful fix overlaps pathless '.' claim", () => {
    const built = buildFixTasks({
      iteration: 3,
      repoAlias: "svc",
      results: [
        {
          gate: "code_quality",
          passed: false,
          summary: "",
          findings: [{ severity: "blocking", message: "a", path: "src/foo.ts" }],
        },
        {
          gate: "code_review",
          passed: false,
          summary: "",
          findings: [{ severity: "blocking", message: "b" }],
        },
      ],
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.claimCollision).toBe(true);
      expect(built.tasks.map((t) => t.allowed_paths)).toEqual([["src/foo.ts"], ["."]]);
    }
  });
});
