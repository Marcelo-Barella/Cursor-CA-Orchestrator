import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { runStopCommand } from "../src/lib/commands/stop-impl.js";
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
        allowed_paths: [],
      },
    ],
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "p", branch_layout: "per_task" },
    bootstrap_repo_name: "b",
    max_iterations: 10,
  };
}

describe("runStopCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("exits 1 when state.json is missing", async () => {
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = {
      readFile: async () => "",
      writeFile: async () => {},
    } as unknown as RepoStoreClient;
    await expect(runStopCommand({ run: "run-x" }, { finish, repoStore: store })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("STOP-002");
  });

  it("writes stop-requested.json and prints STOP-003 on success", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-stop");
    state.status = "running";
    const writes: Array<{ path: string; content: string }> = [];
    const store = {
      readFile: async (_runId: string, path: string) => {
        if (path === "state.json") return serialize(state);
        return "";
      },
      writeFile: async (_runId: string, path: string, content: string) => {
        writes.push({ path, content });
      },
    } as unknown as RepoStoreClient;
    await runStopCommand({ run: "run-stop" }, { repoStore: store });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("stop-requested.json");
    const payload = JSON.parse(writes[0]!.content) as { requested_by?: string };
    expect(payload.requested_by).toBe("cli");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("STOP-003");
    expect(text).toContain("stop-requested.json");
  });
});
