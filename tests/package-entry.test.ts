import { describe, expect, it } from "vitest";
import * as orch from "../src/index.js";

describe("package entry", () => {
  it("exports launch helper symbol", () => {
    expect(orch.launchOrchestrationRun).toBeTypeOf("function");
  });
});
