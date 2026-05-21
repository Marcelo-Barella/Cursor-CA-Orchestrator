import { describe, expect, it } from "vitest";
import { createBootstrapRepoStore } from "../src/storage/bootstrap-repo-store.js";

describe("bootstrap store", () => {
  it("reads state blob", async () => {
    const store = createBootstrapRepoStore({
      readStateJson: async () => ({ orchestration_run_id: "abc" }),
    });
    await expect(store.readOrchestrationState()).resolves.toMatchObject({
      orchestration_run_id: "abc",
    });
  });

  it("writes synced snapshot", async () => {
    const written: unknown[] = [];
    const store = createBootstrapRepoStore({
      readStateJson: async () => ({}),
      writeSyncedSnapshot: async (data: unknown) => { written.push(data); },
    });
    await store.writeSyncedSnapshot({ status: "done" });
    expect(written).toHaveLength(1);
  });

  it("no-ops writeSyncedSnapshot when adapter has no writer", async () => {
    const store = createBootstrapRepoStore({
      readStateJson: async () => ({}),
    });
    await expect(store.writeSyncedSnapshot({ status: "done" })).resolves.toBeUndefined();
  });
});
