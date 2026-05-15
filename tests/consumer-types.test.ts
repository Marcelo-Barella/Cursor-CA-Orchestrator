import { describe, it, expectTypeOf } from "vitest";
import {
  launchOrchestrationRun,
  mirrorTasksFromOrchestrationState,
  readBootstrapSnapshot,
  type MirroredTask,
  type OrchestratorConfig,
  type LaunchOrchestrationRunDeps,
} from "../src/index.js";

describe("library import surface", () => {
  it("launchOrchestrationRun is an async function", () => {
    expectTypeOf(launchOrchestrationRun).toBeFunction();
    expectTypeOf(launchOrchestrationRun).parameter(0).toMatchTypeOf<LaunchOrchestrationRunDeps>();
  });

  it("mirrorTasksFromOrchestrationState is a function returning MirroredTask[]", () => {
    expectTypeOf(mirrorTasksFromOrchestrationState).toBeFunction();
    expectTypeOf(mirrorTasksFromOrchestrationState).returns.toEqualTypeOf<MirroredTask[]>();
  });

  it("readBootstrapSnapshot is an async function", () => {
    expectTypeOf(readBootstrapSnapshot).toBeFunction();
  });

  it("OrchestratorConfig has required shape", () => {
    expectTypeOf<OrchestratorConfig>().toHaveProperty("name");
    expectTypeOf<OrchestratorConfig>().toHaveProperty("tasks");
    expectTypeOf<OrchestratorConfig>().toHaveProperty("repositories");
  });

  it("MirroredTask has key and status", () => {
    expectTypeOf<MirroredTask>().toHaveProperty("key");
    expectTypeOf<MirroredTask>().toHaveProperty("status");
  });
});
