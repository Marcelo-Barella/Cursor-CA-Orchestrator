import { describe, expect, it } from "vitest";
import { readBootstrapSnapshot } from "../../src/mirror/read-bootstrap-snapshot.js";
import { createBootstrapRepoStore } from "../../src/storage/bootstrap-repo-store.js";
import fixture from "../fixtures/bootstrap/state.sample.json" with { type: "json" };

describe("readBootstrapSnapshot", () => {
  it("returns normalized tasks and raw state from the store", async () => {
    const store = createBootstrapRepoStore({
      readStateJson: async () => fixture as Record<string, unknown>,
    });
    const snap = await readBootstrapSnapshot(store);
    expect(snap.raw).toMatchObject({ orchestration_run_id: "run-1" });
    expect(snap.tasks).toEqual([
      { key: "t1#0", status: "done" },
      { key: "t2#1", status: "running" },
    ]);
  });

  it("returns empty tasks when state has no task list", async () => {
    const store = createBootstrapRepoStore({
      readStateJson: async () => ({ orchestration_run_id: "empty" }),
    });
    const snap = await readBootstrapSnapshot(store);
    expect(snap.tasks).toEqual([]);
    expect(snap.raw).toMatchObject({ orchestration_run_id: "empty" });
  });
});
