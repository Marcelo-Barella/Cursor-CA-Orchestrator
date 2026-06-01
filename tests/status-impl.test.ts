import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { toYaml } from "../src/config/parse.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { runStatusCommand } from "../src/lib/commands/status-impl.js";
import { createInitialState, serialize } from "../src/state.js";

function baseConfig(): OrchestratorConfig {
  return {
    name: "demo",
    model: { id: "m" },
    prompt: "",
    repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
    tasks: [
      {
        id: "t1",
        repo: "svc",
        prompt: "p",
        model: null,
        depends_on: [],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
    ],
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "p", branch_layout: "per_task" },
    bootstrap_repo_name: "b",
  };
}

function mockRepoStore(files: Record<string, string>, readThrows = false): RepoStoreClient {
  return {
    readFile: async (_runId: string, path: string) => {
      if (readThrows) {
        throw new Error("not found");
      }
      return files[path] ?? "";
    },
  } as unknown as RepoStoreClient;
}

describe("runStatusCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("exits 2 when state.json is missing", async () => {
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({ "config.yaml": toYaml(baseConfig()) });
    await expect(
      runStatusCommand({ run: "run-x", watch: false }, { finish, repoStore: store }),
    ).rejects.toThrow("exit:2");
    expect(logSpy).toHaveBeenCalled();
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("STATUS-003");
  });

  it("exits 2 when state.json read fails", async () => {
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({}, true);
    await expect(
      runStatusCommand({ run: "run-x", watch: false }, { finish, repoStore: store }),
    ).rejects.toThrow("exit:2");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("STATUS-002");
  });

  it("exits 2 when config.yaml is missing", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-x");
    state.status = "completed";
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({ "state.json": serialize(state) });
    await expect(
      runStatusCommand({ run: "run-x", watch: false }, { finish, repoStore: store }),
    ).rejects.toThrow("exit:2");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("STATUS-004");
  });

  it("exits 1 for failed runs and prints root transcript hints", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-fail");
    state.status = "failed";
    state.agents.t1.status = "failed";
    state.agents.t1.summary = "tool timed out";
    state.agents.t1.finished_at = "2026-01-01T00:00:00.000Z";
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({
      "state.json": serialize(state),
      "config.yaml": toYaml(cfg),
      "events.jsonl": "",
    });
    await expect(
      runStatusCommand({ run: "run-fail", watch: false }, { finish, repoStore: store }),
    ).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("Inspect root transcript");
    expect(text).toContain("run-fail");
    expect(text).toContain("t1");
  });

  it("exits 2 when config.yaml cannot be parsed", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-bad-cfg");
    state.status = "completed";
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({
      "state.json": serialize(state),
      "config.yaml": "name: [\ninvalid yaml",
      "events.jsonl": "",
    });
    await expect(
      runStatusCommand({ run: "run-bad-cfg", watch: false }, { finish, repoStore: store }),
    ).rejects.toThrow("exit:2");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("STATUS-004");
  });

  it("resolves without calling finish when run status is stopped", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-stopped");
    state.status = "stopped";
    state.agents.t1.status = "stopped";
    state.agents.t1.finished_at = "2026-01-01T00:00:00.000Z";
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({
      "state.json": serialize(state),
      "config.yaml": toYaml(cfg),
      "events.jsonl": "",
    });
    await expect(
      runStatusCommand({ run: "run-stopped", watch: false }, { finish, repoStore: store }),
    ).resolves.toBeUndefined();
    expect(finish).not.toHaveBeenCalled();
  });

  it("exits 0 for completed runs", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-ok");
    state.status = "completed";
    state.agents.t1.status = "finished";
    state.agents.t1.finished_at = "2026-01-01T00:00:00.000Z";
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({
      "state.json": serialize(state),
      "config.yaml": toYaml(cfg),
      "events.jsonl": "",
    });
    await expect(
      runStatusCommand({ run: "run-ok", watch: false }, { finish, repoStore: store }),
    ).rejects.toThrow("exit:0");
  });
});
