import { describe, expect, it, vi } from "vitest";
import { launchOrchestrationRun } from "../src/engine/launch-orchestration-run.js";

describe("engine launch", () => {
  it("returns run id without process.exit when orchestrator completes", async () => {
    const fake = vi.fn(async () => ({ orchestrationRunId: "dry-run-id" }));
    const out = await launchOrchestrationRun({
      cwd: "/tmp/demo",
      runOrchestration: fake,
    });
    expect(out.orchestrationRunId).toBe("dry-run-id");
  });
});
