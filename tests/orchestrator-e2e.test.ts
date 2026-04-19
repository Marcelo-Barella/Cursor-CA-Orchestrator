import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import {
  FakeAgentClient,
  assistantText,
  statusMessage,
} from "./support/fake-agent-client.js";

type FileStore = Map<string, string>;

function createInMemoryRepoStore(initial: Record<string, string>): { store: RepoStoreClient; files: FileStore } {
  const files: FileStore = new Map(Object.entries(initial));
  const ghCalls: string[] = [];
  const store = {
    rateLimitRemaining: null,
    rateLimitLimit: null,
    async readFile(_runId: string, filename: string): Promise<string> {
      ghCalls.push(`read ${filename}`);
      return files.get(filename) ?? "";
    },
    async writeFile(_runId: string, filename: string, content: string): Promise<void> {
      files.set(filename, content);
    },
    async updateFile(_runId: string, filename: string, updater: (current: string) => string | Promise<string>): Promise<void> {
      const current = files.get(filename) ?? "";
      files.set(filename, await updater(current));
    },
    async deleteFile(_runId: string, filename: string): Promise<void> {
      files.delete(filename);
    },
  } as unknown as RepoStoreClient;
  return { store, files };
}

function singleTaskConfig(): OrchestratorConfig {
  return {
    name: "demo",
    model: "composer-2",
    prompt: "",
    repositories: {
      svc: { url: "https://github.com/acme/svc", ref: "main" },
    },
    tasks: [
      {
        id: "t1",
        repo: "svc",
        prompt: "Do the thing.",
        model: null,
        depends_on: [],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
    ],
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "cursor-orch", branch_layout: "per_task" },
    bootstrap_repo_name: "cursor-orch-bootstrap",
  };
}

describe("runOrchestration with SDK (happy path)", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.CURSOR_API_KEY = "sk-fake";
    process.env.GH_TOKEN = "ghp-fake";
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("launches a worker, reads the artifact, and marks the run completed", async () => {
    const config = singleTaskConfig();
    const workerPayload = {
      task_id: "t1",
      status: "completed",
      summary: "did the thing",
      outputs: { note: "ok" },
    };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("CREATING"), statusMessage("RUNNING"), assistantText("working"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: { branch: "cursor-orch/run-1/t1" } },
          artifacts: { "cursor-orch-output.json": JSON.stringify(workerPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-1", fake, store);
    expect(files.get("agent-t1.json")).toBeTruthy();
    const parsed = JSON.parse(files.get("agent-t1.json")!);
    expect(parsed.status).toBe("completed");
    expect(parsed.summary).toBe("did the thing");
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.status).toBe("finished");
    expect(fake.launches[0]!.opts.branchName).toBe("cursor-orch/run-1/t1");
  });

  it("falls back to assistant JSON when the artifact is absent", async () => {
    const config = singleTaskConfig();
    const workerJson = { task_id: "t1", status: "completed", summary: "from assistant", outputs: {} };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [
            statusMessage("RUNNING"),
            assistantText(`Here is my result:\n\n\`\`\`json\n${JSON.stringify(workerJson)}\n\`\`\``),
            statusMessage("FINISHED"),
          ],
          result: { id: "r1", status: "finished" },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-2", fake, store);
    expect(JSON.parse(files.get("agent-t1.json")!)).toMatchObject(workerJson);
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
  });

  it("marks a task failed when the SDK run returns status=error", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("ERROR")],
          result: { id: "r1", status: "error" },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-3", fake, store)).rejects.toThrow();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
  });

  it("writes a per-worker transcript from streamed SDK events", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), assistantText("step 1"), assistantText("step 2"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({ task_id: "t1", status: "completed", summary: "ok", outputs: {} }),
          },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-4", fake, store);
    const transcript = files.get("transcripts/t1.jsonl") ?? "";
    expect(transcript.trim().split("\n").length).toBeGreaterThanOrEqual(4);
  });

  it("writes the stop sentinel leads to state.status=stopped", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING")],
          result: { id: "r1", status: "cancelled" },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "stop-requested.json": JSON.stringify({ requested_at: new Date().toISOString(), requested_by: "test" }),
    });
    await runOrchestration("run-5", fake, store);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("stopped");
  });
});
