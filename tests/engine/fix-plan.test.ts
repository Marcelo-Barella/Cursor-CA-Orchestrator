import { describe, expect, it } from "vitest";
import { buildFixTasks } from "../../src/engine/fix-plan.js";

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
});
