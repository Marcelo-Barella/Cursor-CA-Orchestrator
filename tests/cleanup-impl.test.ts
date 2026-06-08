import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { runCleanupCommand } from "../src/lib/commands/cleanup-impl.js";

describe("runCleanupCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const key of ["GH_TOKEN", "BOOTSTRAP_OWNER", "BOOTSTRAP_REPO"]) {
      envBackup[key] = process.env[key];
    }
    process.env.GH_TOKEN = "ghp-test";
    process.env.BOOTSTRAP_OWNER = "owner";
    process.env.BOOTSTRAP_REPO = "bootstrap";
  });

  afterEach(() => {
    logSpy.mockRestore();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("exits 1 when GH_TOKEN is missing", async () => {
    delete process.env.GH_TOKEN;
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCleanupCommand({ olderThan: "7" }, { finish })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("CLEANUP-001");
  });

  it("exits 1 when BOOTSTRAP_OWNER is missing", async () => {
    delete process.env.BOOTSTRAP_OWNER;
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCleanupCommand({ olderThan: "7" }, { finish })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("ENV-001");
    expect(text).toContain("BOOTSTRAP_OWNER");
  });

  it("dry run lists branches without deleting", async () => {
    const deleted: string[] = [];
    const store = {
      listRunBranches: async () => ["run/a", "run/b"],
      deleteRunBranch: async (runId: string) => {
        deleted.push(runId);
      },
    } as unknown as RepoStoreClient;
    await runCleanupCommand({ olderThan: "7", dryRun: true }, { repoStore: store });
    expect(deleted).toEqual([]);
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("dry run");
    expect(text).toContain("run/a");
    expect(text).toContain("run/b");
  });

  it("deletes every listed run branch when not dry run", async () => {
    const deleted: string[] = [];
    const store = {
      listRunBranches: async () => ["run/one", "run/two"],
      deleteRunBranch: async (runId: string) => {
        deleted.push(runId);
      },
    } as unknown as RepoStoreClient;
    await runCleanupCommand({ olderThan: "7" }, { repoStore: store });
    expect(deleted).toEqual(["one", "two"]);
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("Deleted 2 run branch(es)");
  });

  it("prints message when no run branches exist", async () => {
    const store = {
      listRunBranches: async () => [],
      deleteRunBranch: async () => {},
    } as unknown as RepoStoreClient;
    await runCleanupCommand({ olderThan: "7" }, { repoStore: store });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("No run branches found");
  });
});
