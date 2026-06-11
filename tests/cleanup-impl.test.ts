import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { runCleanupCommand } from "../src/lib/commands/cleanup-impl.js";

function mockStore(branches: string[], dates: Record<string, Date>) {
  const deleted: string[] = [];
  const store = {
    listRunBranches: async () => branches,
    getRunBranchCommitDate: async (runId: string) => dates[runId] ?? null,
    deleteRunBranch: async (runId: string) => {
      deleted.push(runId);
    },
  } as unknown as RepoStoreClient;
  return { store, deleted };
}

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
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-06-11T00:00:00.000Z").getTime());
  });

  afterEach(() => {
    logSpy.mockRestore();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
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

  it("exits 1 when BOOTSTRAP_REPO is missing", async () => {
    delete process.env.BOOTSTRAP_REPO;
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCleanupCommand({ olderThan: "7" }, { finish })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("ENV-001");
    expect(text).toContain("BOOTSTRAP_REPO");
  });

  it("exits 1 when --older-than is invalid", async () => {
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCleanupCommand({ olderThan: "bad" }, { finish })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("CLEANUP-002");
  });

  it("dry run lists only branches older than the cutoff", async () => {
    const { store, deleted } = mockStore(["run/old", "run/new"], {
      old: new Date("2026-06-01T00:00:00.000Z"),
      new: new Date("2026-06-10T00:00:00.000Z"),
    });
    await runCleanupCommand({ olderThan: "7", dryRun: true }, { repoStore: store });
    expect(deleted).toEqual([]);
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("run/old");
    expect(text).not.toContain("run/new");
  });

  it("deletes only branches older than the cutoff", async () => {
    const { store, deleted } = mockStore(["run/old", "run/new"], {
      old: new Date("2026-06-01T00:00:00.000Z"),
      new: new Date("2026-06-10T00:00:00.000Z"),
    });
    await runCleanupCommand({ olderThan: "7" }, { repoStore: store });
    expect(deleted).toEqual(["old"]);
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("Deleted 1 run branch(es)");
  });

  it("skips branches whose commit date cannot be resolved", async () => {
    const { store, deleted } = mockStore(["run/old", "run/unknown"], {
      old: new Date("2026-06-01T00:00:00.000Z"),
    });
    await runCleanupCommand({ olderThan: "7" }, { repoStore: store });
    expect(deleted).toEqual(["old"]);
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).not.toContain("run/unknown");
  });

  it("prints message when no run branches exist", async () => {
    const { store } = mockStore([], {});
    await runCleanupCommand({ olderThan: "7" }, { repoStore: store });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("No run branches found");
  });
});
