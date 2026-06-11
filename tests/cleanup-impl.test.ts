import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleted: string[] = [];
const repoStoreMock = {
  listRunBranches: vi.fn(async () => ["run/old", "run/new"]),
  getRunBranchCommitDate: vi.fn(async (runId: string) => {
    if (runId === "old") return new Date("2026-06-01T00:00:00.000Z");
    return new Date("2026-06-10T00:00:00.000Z");
  }),
  deleteRunBranch: vi.fn(async (runId: string) => {
    deleted.push(runId);
  }),
};

vi.mock("../src/api/repo-store.js", () => ({
  RepoStoreClient: vi.fn(() => repoStoreMock),
}));

import { runCleanupCommand } from "../src/lib/commands/cleanup-impl.js";

describe("runCleanupCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    deleted.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.GH_TOKEN = "ghp-test";
    process.env.BOOTSTRAP_OWNER = "owner";
    process.env.BOOTSTRAP_REPO = "repo";
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-06-11T00:00:00.000Z").getTime());
  });

  afterEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.BOOTSTRAP_OWNER;
    delete process.env.BOOTSTRAP_REPO;
    vi.restoreAllMocks();
  });

  it("deletes only branches older than the cutoff", async () => {
    await runCleanupCommand({ olderThan: "7" });
    expect(deleted).toEqual(["old"]);
  });

  it("lists only eligible branches during dry run", async () => {
    await runCleanupCommand({ olderThan: "7", dryRun: true });
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("run/old");
    expect(output).not.toContain("run/new");
    expect(repoStoreMock.deleteRunBranch).not.toHaveBeenCalled();
  });
});
