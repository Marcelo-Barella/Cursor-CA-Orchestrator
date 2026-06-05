import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { toYaml } from "../src/config/parse.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { runLogsCommand } from "../src/lib/commands/logs-impl.js";
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
      {
        id: "t2",
        repo: "svc",
        prompt: "p2",
        model: null,
        depends_on: ["t1"],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
    ],
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "p", branch_layout: "per_task" },
    bootstrap_repo_name: "b",
  };
}

function mockRepoStore(files: Record<string, string>): RepoStoreClient {
  return {
    readFile: async (_runId: string, path: string) => files[path] ?? "",
  } as unknown as RepoStoreClient;
}

describe("runLogsCommand", () => {
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
    const store = mockRepoStore({});
    await expect(runLogsCommand({ run: "run-x" }, { finish, repoStore: store })).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("LOGS-002");
  });

  it("exits 1 when --task is not in run state", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-x");
    const finish = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const store = mockRepoStore({ "state.json": serialize(state) });
    await expect(
      runLogsCommand({ run: "run-x", task: "missing" }, { finish, repoStore: store }),
    ).rejects.toThrow("exit:1");
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("LOGS-003");
  });

  it("prints cascade hint for task failed due to upstream", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-cascade");
    state.status = "failed";
    state.agents.t1.status = "failed";
    state.agents.t1.summary = "root worker error";
    state.agents.t2.status = "failed";
    state.agents.t2.cascade_source_task_id = "t1";
    state.agents.t2.summary = "Upstream task t1 failed";
    const store = mockRepoStore({
      "state.json": serialize(state),
      "transcripts/t2.jsonl": "",
    });
    await runLogsCommand({ run: "run-cascade", task: "t2" }, { repoStore: store });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("upstream task t1");
    expect(text).toContain("--task t1");
  });

  it("prints failure analysis and events for failed runs", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-fail");
    state.status = "failed";
    state.agents.t1.status = "failed";
    state.agents.t1.summary = "SDK timeout";
    const eventLine = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      event_type: "task_failed",
      task_id: "t1",
      detail: "Task t1 failed",
    });
    const store = mockRepoStore({
      "state.json": serialize(state),
      "config.yaml": toYaml(cfg),
      "events.jsonl": eventLine + "\n",
    });
    await runLogsCommand({ run: "run-fail" }, { repoStore: store });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("Failure analysis");
    expect(text).toContain("Root task(s)");
    expect(text).toContain("t1");
    expect(text).toContain("task_failed");
  });

  it("renders assistant transcript lines for --task", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-tr");
    state.agents.t1.status = "finished";
    const transcriptLine = JSON.stringify({
      event: {
        type: "assistant",
        agent_id: "a1",
        run_id: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "hello from worker" }] },
      },
    });
    const store = mockRepoStore({
      "state.json": serialize(state),
      [`transcripts/t1.jsonl`]: transcriptLine + "\n",
    });
    await runLogsCommand({ run: "run-tr", task: "t1" }, { repoStore: store });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("[assistant t1]");
    expect(text).toContain("hello from worker");
  });

  it("ignores malformed transcript lines when rendering --task", async () => {
    const cfg = baseConfig();
    const state = createInitialState(cfg, "run-tr-bad");
    state.agents.t1.status = "finished";
    const valid = JSON.stringify({
      event: {
        type: "assistant",
        agent_id: "a1",
        run_id: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "kept line" }] },
      },
    });
    const store = mockRepoStore({
      "state.json": serialize(state),
      "transcripts/t1.jsonl": `${valid}\nnot valid json {{{\n`,
    });
    await runLogsCommand({ run: "run-tr-bad", task: "t1" }, { repoStore: store });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("kept line");
    expect(text).not.toContain("not valid json");
  });
});
