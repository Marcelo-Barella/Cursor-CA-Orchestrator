import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let unmockedFetch: typeof fetch;

function installGithubBranchPrepMock(): void {
  unmockedFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.github.com/")) {
      return unmockedFetch(input, init);
    }
    if (url.includes("/git/ref/heads/")) {
      const tail = url.split("/git/ref/heads/")[1] ?? "";
      const decoded = decodeURIComponent(tail);
      if (decoded === "main" || decoded.endsWith("/main")) {
        return new Response(JSON.stringify({ object: { sha: "0123456789abcdef0123456789abcdef01234567" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/git/refs") && init?.method === "POST") {
      return new Response(JSON.stringify({ ref: "refs/heads/x" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return unmockedFetch(input, init);
  }) as typeof fetch;
}

function twoRepoParallelTaskConfig(): OrchestratorConfig {
  const mk = (id: string, repo: "svc" | "svc2") => ({
    id,
    repo,
    prompt: `task ${id}`,
    model: null,
    depends_on: [] as string[],
    timeout_minutes: 30,
    create_repo: false,
    repo_config: null,
  });
  return {
    name: "demo",
    model: "composer-2",
    prompt: "",
    repositories: {
      svc: { url: "https://github.com/acme/svc", ref: "main" },
      svc2: { url: "https://github.com/acme/svc2", ref: "main" },
    },
    tasks: [mk("t-a", "svc"), mk("t-b", "svc2")],
    delegation_map: {
      phases: [{ id: "p1", groups: [{ id: "g1", task_ids: ["t-a", "t-b"] }] }],
    },
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "cursor-orch", branch_layout: "per_task" },
    bootstrap_repo_name: "cursor-orch-bootstrap",
  };
}

describe("runOrchestration with SDK (happy path)", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.CURSOR_API_KEY = "sk-fake";
    process.env.GH_TOKEN = "ghp-fake";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "0";
    delete process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS;
    installGithubBranchPrepMock();
  });
  afterEach(() => {
    globalThis.fetch = unmockedFetch;
    process.env = { ...originalEnv };
  });

  it("launches all eligible workers in one delegation group before send() returns (overlapping sends)", async () => {
    const config = twoRepoParallelTaskConfig();
    const scriptFor = (taskId: string) => ({
      events: [statusMessage("CREATING"), statusMessage("RUNNING"), assistantText("ok"), statusMessage("FINISHED")],
      result: { id: `r-${taskId}`, status: "finished" as const, git: { branch: `cursor-orch/run-parallel/${taskId}` } },
      artifacts: {
        "cursor-orch-output.json": JSON.stringify({ task_id: taskId, status: "completed", summary: "ok", outputs: {} }),
      },
    });
    const fake = new FakeAgentClient({
      sendPreDelayMs: 30,
      defaultScripts: [scriptFor("t-a"), scriptFor("t-b")],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-parallel", fake, store);
    expect(fake.maxConcurrentSends).toBe(2);
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
    expect(JSON.parse(files.get("state.json")!).agents["t-a"].status).toBe("finished");
    expect(JSON.parse(files.get("state.json")!).agents["t-b"].status).toBe("finished");
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
    expect(fake.launches[0]!.opts.startingRef).toBe("cursor-orch/run-1/t1");
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

  it("after run error, retries resolving output and finishes when conversation JSON appears on a later attempt", async () => {
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "4";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS = "0";
    const config = singleTaskConfig();
    const workerJson = { task_id: "t1", status: "completed", summary: "late conversation", outputs: { k: "v" } };
    let convCalls = 0;
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING")],
          result: { id: "r1", status: "error" },
        },
      ],
      conversationText: () => {
        convCalls += 1;
        if (convCalls < 2) {
          return "still generating screens";
        }
        return `\n\n\`\`\`json\n${JSON.stringify(workerJson)}\n\`\`\`\n`;
      },
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-conv-retry", fake, store);
    expect(convCalls).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(files.get("agent-t1.json")!)).toMatchObject(workerJson);
    expect(JSON.parse(files.get("state.json")!).agents.t1.status).toBe("finished");
  });

  it("recovers a completed task from the conversation API when the stream ends before the final JSON", async () => {
    const config = singleTaskConfig();
    const workerJson = { task_id: "t1", status: "completed", summary: "recovered from conversation", outputs: { k: "v" } };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING")],
          result: { id: "r1", status: "error" },
        },
      ],
      conversationText: `\n\n\`\`\`json\n${JSON.stringify(workerJson)}\n\`\`\`\n`,
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-conv-ok", fake, store);
    expect(fake.conversationCalls.length).toBe(1);
    const payload = JSON.parse(files.get("agent-t1.json")!);
    expect(payload).toMatchObject(workerJson);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.status).toBe("finished");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    const finishedEvent = events.find((e) => e.event_type === "task_finished" && e.task_id === "t1");
    expect(finishedEvent?.payload?.payload_source).toBe("conversation");
  });

  it("stays failed when the conversation API yields no JSON block", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING")],
          result: { id: "r1", status: "error" },
        },
      ],
      conversationText: "still retrying stitch screen generation; no final output produced.",
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-conv-none", fake, store)).rejects.toThrow();
    expect(fake.conversationCalls.length).toBe(1);
    expect(files.get("agent-t1.json")).toBeUndefined();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    const failedEvent = events.find((e) => e.event_type === "task_failed" && e.task_id === "t1");
    expect(failedEvent?.payload?.payload_source).toBe("none");
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

  it("passes configured mcp_servers to worker launches", async () => {
    const config = singleTaskConfig();
    config.mcp_servers = {
      linear: { type: "http", url: "https://mcp.linear.app/sse" },
      gh: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({ task_id: "t1", status: "completed", summary: "ok", outputs: {} }),
          },
        },
      ],
    });
    const { store } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-mcp", fake, store);
    expect(fake.launches[0]!.opts.mcpServers).toEqual(config.mcp_servers);
  });

  it("omits mcp_servers when none configured", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({ task_id: "t1", status: "completed", summary: "ok", outputs: {} }),
          },
        },
      ],
    });
    const { store } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-no-mcp", fake, store);
    expect(fake.launches[0]!.opts.mcpServers).toBeUndefined();
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
