import { describe, expect, it } from "vitest";
import * as orch from "../src/index.js";

describe("package entry", () => {
  it("exports launch helper symbol", () => {
    expect(orch.launchOrchestrationRun).toBeTypeOf("function");
  });

  it("exports mirror helpers for library consumers", () => {
    expect(orch.mirrorTasksFromOrchestrationState).toBeTypeOf("function");
    expect(orch.readBootstrapSnapshot).toBeTypeOf("function");
  });
});
