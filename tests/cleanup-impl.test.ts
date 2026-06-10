import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoStoreClient } from "../src/api/repo-store.js";
import { runCleanupCommand } from "../src/lib/commands/cleanup-impl.js";

describe("runCleanupCommand", () => {
  const originalEnv = { ...process.env };
  let logSpy: ReturnType<typeof vi.spyOn>;
  let listRunBranches: ReturnType<typeof vi.spyOn>;
  let deleteRunBranch: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GH_TOKEN: "ghp-test",
      BOOTSTRAP_OWNER: "acme",
      BOOTSTRAP_REPO: "bootstrap",
    };
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    listRunBranches = vi.spyOn(RepoStoreClient.prototype, "listRunBranches");
    deleteRunBranch = vi.spyOn(RepoStoreClient.prototype, "deleteRunBranch").mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    logSpy.mockRestore();
    listRunBranches.mockRestore();
    deleteRunBranch.mockRestore();
    exitSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("exits 1 when GH_TOKEN is missing", async () => {
    delete process.env.GH_TOKEN;
    await expect(runCleanupCommand({ olderThan: "7" })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("CLEANUP-001");
  });

  it("exits 1 when BOOTSTRAP_OWNER is missing", async () => {
    delete process.env.BOOTSTRAP_OWNER;
    await expect(runCleanupCommand({ olderThan: "7" })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("ENV-001");
    expect(text).toContain("BOOTSTRAP_OWNER");
  });

  it("prints a note when no run branches exist", async () => {
    listRunBranches.mockResolvedValue([]);
    await runCleanupCommand({ olderThan: "7" });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("No run branches found.");
    expect(deleteRunBranch).not.toHaveBeenCalled();
  });

  it("dry-run lists branches without deleting", async () => {
    listRunBranches.mockResolvedValue(["run/a", "run/b"]);
    await runCleanupCommand({ olderThan: "7", dryRun: true });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("dry run");
    expect(text).toContain("run/a");
    expect(text).toContain("run/b");
    expect(deleteRunBranch).not.toHaveBeenCalled();
  });

  it("deletes every run branch when not in dry-run", async () => {
    listRunBranches.mockResolvedValue(["run/a", "run/b"]);
    await runCleanupCommand({ olderThan: "7" });
    expect(deleteRunBranch).toHaveBeenCalledTimes(2);
    expect(deleteRunBranch).toHaveBeenCalledWith("a");
    expect(deleteRunBranch).toHaveBeenCalledWith("b");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("Deleted 2 run branch(es).");
  });

  it("notes unimplemented age filtering for non-default older-than", async () => {
    listRunBranches.mockResolvedValue(["run/old"]);
    await runCleanupCommand({ olderThan: "30" });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("age-based filtering");
    expect(text).toContain("--older-than 30");
    expect(deleteRunBranch).toHaveBeenCalledWith("old");
  });
});
