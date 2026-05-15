import { describe, expect, it } from "vitest";
import { mirrorTasksFromOrchestrationState } from "../../src/mirror/normalize.js";
import fixture from "../fixtures/bootstrap/state.sample.json" with { type: "json" };

describe("mirrorTasksFromOrchestrationState", () => {
  it("normalizes tasks with stable sort", () => {
    const result = mirrorTasksFromOrchestrationState(fixture);
    expect(result).toHaveLength(2);
    expect(result[0].key).toBe("t1#0");
    expect(result[0].status).toBe("done");
    expect(result[1].key).toBe("t2#1");
    expect(result[1].status).toBe("running");
  });

  it("returns empty array for missing tasks", () => {
    expect(mirrorTasksFromOrchestrationState({})).toEqual([]);
  });
});
