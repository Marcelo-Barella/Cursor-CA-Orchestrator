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

  it("uses default task name and empty status when fields are absent", () => {
    const result = mirrorTasksFromOrchestrationState({
      tasks: [{}, { status: 42 }],
    });
    expect(result).toEqual([
      { key: "task#0", status: "" },
      { key: "task#1", status: "42" },
    ]);
  });

  it("sorts by key lexicographically regardless of input order", () => {
    const result = mirrorTasksFromOrchestrationState({
      tasks: [
        { name: "z", status: "b" },
        { name: "a", status: "a" },
      ],
    });
    expect(result.map((t) => t.key)).toEqual(["a#1", "z#0"]);
  });
});
