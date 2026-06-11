import type { RunResult as SdkRunResult } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import { createInitialState, serialize } from "../src/state.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import {
  FakeAgentClient,
  type FakeRunScript,
  assistantText,
  statusMessage,
} from "./support/fake-agent-client.js";

type FileStore = Map<string, string>;

function runGit(branch: string, repoUrl = "https://github.com/acme/svc"): NonNullable<SdkRunResult["git"]> {
  return { branches: [{ repoUrl, branch }] };
}

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
    model: { id: "composer-2" },
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

function promptOnlyConfig(): OrchestratorConfig {
  return {
    name: "plan-demo",
    model: { id: "composer-2" },
    prompt: "Ship the feature across repos.",
    repositories: {
      svc: { url: "https://github.com/acme/svc", ref: "main" },
    },
    tasks: [],
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "cursor-orch", branch_layout: "per_task" },
    bootstrap_repo_name: "cursor-orch-bootstrap",
  };
}

function twoTaskChainConfig(): OrchestratorConfig {
  const base = singleTaskConfig();
  return {
    ...base,
    tasks: [
      {
        id: "t1",
        repo: "svc",
        prompt: "Produce upstream outputs.",
        model: null,
        depends_on: [],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
      {
        id: "t2",
        repo: "svc",
        prompt: "Consume upstream outputs.",
        model: null,
        depends_on: ["t1"],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
    ],
  };
}

function completedWorkerScript(taskId: string, runId: string, outputs: Record<string, unknown> = {}): FakeRunScript {
  return {
    events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
    result: { id: `r-${taskId}`, status: "finished", git: runGit(`cursor-orch/${runId}/${taskId}`) },
    artifacts: {
      "cursor-orch-output.json": JSON.stringify({
        task_id: taskId,
        status: "completed",
        summary: "ok",
        outputs,
      }),
    },
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
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "acme-user" }), {
        status: 200,
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
    model: { id: "composer-2" },
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
    delete process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES;
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
      result: { id: `r-${taskId}`, status: "finished" as const, git: runGit(`cursor-orch/run-parallel/${taskId}`) },
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
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-1/t1") },
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
    expect(fake.launches[0]!.opts.startingRef).toBe("cursor-orch/run-1/t1");
  });

  it("persists truncated agent output when worker JSON exceeds size limits", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-truncate/t1") },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({
              status: "completed",
              summary: "a".repeat(5000),
              outputs: { blob: "z".repeat(300_000) },
            }),
          },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-truncate", fake, store);
    const agent = JSON.parse(files.get("agent-t1.json")!);
    expect(agent.summary).toContain("[TRUNCATED]");
    expect(agent.truncated).toBe(true);
    expect(JSON.parse(files.get("state.json")!).agents.t1.status).toBe("finished");
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

  it("falls back to assistant JSON when the artifact is valid JSON but missing a worker status", async () => {
    const config = singleTaskConfig();
    const workerJson = { task_id: "t1", status: "completed", summary: "from assistant after incomplete artifact", outputs: {} };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [
            statusMessage("RUNNING"),
            assistantText(`\`\`\`json\n${JSON.stringify(workerJson)}\n\`\`\``),
            statusMessage("FINISHED"),
          ],
          result: { id: "r1", status: "finished" },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({ task_id: "t1", summary: "incomplete artifact", outputs: {} }),
          },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-incomplete-artifact-fallback", fake, store);
    expect(JSON.parse(files.get("agent-t1.json")!)).toMatchObject(workerJson);
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    const finishedEvent = events.find((e) => e.event_type === "task_finished" && e.task_id === "t1");
    expect(finishedEvent?.payload?.payload_source).toBe("assistant");
  });

  it("falls back to assistant JSON when the artifact exists but is not valid JSON", async () => {
    const config = singleTaskConfig();
    const workerJson = { task_id: "t1", status: "completed", summary: "from assistant after bad artifact", outputs: {} };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [
            statusMessage("RUNNING"),
            assistantText(`\`\`\`json\n${JSON.stringify(workerJson)}\n\`\`\``),
            statusMessage("FINISHED"),
          ],
          result: { id: "r1", status: "finished" },
          artifacts: { "cursor-orch-output.json": "not-json {{{" },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-bad-artifact-fallback", fake, store);
    expect(JSON.parse(files.get("agent-t1.json")!)).toMatchObject(workerJson);
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    const finishedEvent = events.find((e) => e.event_type === "task_finished" && e.task_id === "t1");
    expect(finishedEvent?.payload?.payload_source).toBe("assistant");
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

  it("retries worker run error once when failure retries allowed and completes on second attempt", async () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "1";
    const config = singleTaskConfig();
    const okPayload = { task_id: "t1", status: "completed", summary: "ok", outputs: {} };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("ERROR")],
          result: { id: "r1", status: "error" },
        },
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r2", status: "finished", git: runGit("cursor-orch/run-retry-ok/t1-retry-1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(okPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-retry-ok", fake, store);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.status).toBe("finished");
    expect(state.agents.t1.retry_count).toBe(1);
    expect(state.agents.t1.blocked_retry_count).toBe(0);
    expect(fake.launches).toHaveLength(2);
    expect(fake.launches[1]!.opts.startingRef).toBe("cursor-orch/run-retry-ok/t1-retry-1");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string }) => e.event_type === "task_retried")).toBe(true);
    expect(events.filter((e: { event_type: string }) => e.event_type === "task_failed").length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e: { event_type: string }) => e.event_type === "task_launched").length).toBe(2);
  });

  it("failure retry clears agent output and resets schedulable fields before relaunch", async () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "1";
    const config = singleTaskConfig();
    const okPayload = { task_id: "t1", status: "completed", summary: "ok", outputs: {} };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("ERROR")],
          result: { id: "r1", status: "error" },
          artifacts: { "cursor-orch-output.json": JSON.stringify({ task_id: "t1", status: "failed", summary: "x", outputs: {} }) },
        },
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r2", status: "finished", git: runGit("cursor-orch/run-retry-reset/t1-retry-1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(okPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const deletedAgentFiles: string[] = [];
    const baseDelete = store.deleteFile.bind(store);
    store.deleteFile = async (runId, filename) => {
      if (filename.startsWith("agent-")) {
        deletedAgentFiles.push(filename);
      }
      return baseDelete(runId, filename);
    };
    await runOrchestration("run-retry-reset", fake, store);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.status).toBe("finished");
    expect(state.agents.t1.retry_count).toBe(1);
    expect(state.agents.t1.agent_id).toBeTruthy();
    expect(deletedAgentFiles).toContain("agent-t1.json");
    expect(fake.launches).toHaveLength(2);
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e: { event_type: string }) => e.event_type === "task_launched").length).toBe(2);
  });

  it("retries after agent output persistence failure when failure retries allowed", async () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "1";
    const config = singleTaskConfig();
    const okPayload = { task_id: "t1", status: "completed", summary: "ok", outputs: {} };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-persist-retry/t1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(okPayload) },
        },
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r2", status: "finished", git: runGit("cursor-orch/run-persist-retry/t1-retry-1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(okPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    let agentWriteAttempts = 0;
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      if (filename === "agent-t1.json") {
        agentWriteAttempts += 1;
        if (agentWriteAttempts === 1) {
          throw new Error("simulated repo store write failure");
        }
      }
      return baseWrite(runId, filename, content);
    };
    await runOrchestration("run-persist-retry", fake, store);
    expect(agentWriteAttempts).toBe(2);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.status).toBe("finished");
    expect(state.agents.t1.retry_count).toBe(1);
    expect(JSON.parse(files.get("agent-t1.json")!)).toMatchObject(okPayload);
    expect(fake.launches).toHaveLength(2);
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string }) => e.event_type === "task_retried")).toBe(true);
  });

  it("stays failed after repeated run errors when failure retries are exhausted", async () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "1";
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("ERROR")],
          result: { id: "r1", status: "error" },
        },
        {
          events: [statusMessage("RUNNING"), statusMessage("ERROR")],
          result: { id: "r2", status: "error" },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-retry-fail", fake, store)).rejects.toThrow();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.agents.t1.status).toBe("failed");
    expect(state.agents.t1.retry_count).toBe(1);
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e: { event_type: string }) => e.event_type === "task_failed").length).toBe(2);
  });

  it("retries after createCloudAgent failure when failure retries allowed", async () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "1";
    const config = singleTaskConfig();
    const okPayload = { task_id: "t1", status: "completed", summary: "ok", outputs: {} };
    const fake = new FakeAgentClient({
      createFailCount: 1,
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-create-retry/t1-retry-1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(okPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-create-retry", fake, store);
    expect(fake.launches).toHaveLength(1);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.retry_count).toBe(1);
  });

  it("retries after send() failure when failure retries allowed", async () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "1";
    const config = singleTaskConfig();
    const okPayload = { task_id: "t1", status: "completed", summary: "ok", outputs: {} };
    const fake = new FakeAgentClient({
      defaultScripts: [
        { sendThrows: new Error("send failed"), result: { id: "skip", status: "finished", result: "" } },
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-send-retry/t1-retry-1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(okPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-send-retry", fake, store);
    expect(fake.launches).toHaveLength(2);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.retry_count).toBe(1);
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

  it("stays failed when worker JSON omits a status field (e.g. empty object)", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), assistantText("```json\n{}\n```"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
          artifacts: { "cursor-orch-output.json": "{}" },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-empty-worker-json", fake, store)).rejects.toThrow();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string }) => e.event_type === "task_finished" && e.task_id === "t1")).toBe(false);
  });

  it("stays failed when persisting agent output to the run branch fails", async () => {
    const config = singleTaskConfig();
    const workerPayload = {
      task_id: "t1",
      status: "completed",
      summary: "ok",
      outputs: { note: "ok" },
    };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-write-fail/t1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(workerPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      if (filename.startsWith("agent-") && filename.endsWith(".json")) {
        throw new Error("simulated repo store write failure");
      }
      return baseWrite(runId, filename, content);
    };
    await expect(runOrchestration("run-write-fail", fake, store)).rejects.toThrow();
    expect(files.get("agent-t1.json")).toBeUndefined();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
    expect(state.agents.t1.summary).toBe("Failed to persist worker output to agent-t1.json on the run branch");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string }) => e.event_type === "task_finished" && e.task_id === "t1")).toBe(false);
    const failedEvent = events.find((e: { event_type: string; task_id: string }) => e.event_type === "task_failed" && e.task_id === "t1");
    expect(failedEvent?.detail).toContain("Failed to persist worker output");
    expect(failedEvent?.detail).not.toBe("Task t1 failed: ok");
  });

  it("stays failed when worker JSON has summary but no status field", async () => {
    const config = singleTaskConfig();
    const payload = JSON.stringify({ task_id: "t1", summary: "looks done", outputs: {} });
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
          artifacts: { "cursor-orch-output.json": payload },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-no-status-field", fake, store)).rejects.toThrow();
    expect(files.get("agent-t1.json")).toBeUndefined();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
  });

  it("stays failed when worker JSON uses a non-canonical status string", async () => {
    const config = singleTaskConfig();
    const payload = JSON.stringify({ task_id: "t1", status: "success", summary: "done", outputs: {} });
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
          artifacts: { "cursor-orch-output.json": payload },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-bad-status", fake, store)).rejects.toThrow();
    expect(files.get("agent-t1.json")).toBeUndefined();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
  });

  it("stays failed when worker JSON is a non-object (array payload)", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
          artifacts: { "cursor-orch-output.json": JSON.stringify([{ status: "completed" }]) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-array-worker-json", fake, store)).rejects.toThrow();
    expect(files.get("agent-t1.json")).toBeUndefined();
    expect(JSON.parse(files.get("state.json")!).agents.t1.status).toBe("failed");
  });

  it("stays failed when the SDK run returns status=finished without worker JSON", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), assistantText("done but no structured output"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished" },
        },
      ],
      conversationText: "orchestration complete; no json block attached.",
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-finished-no-json", fake, store)).rejects.toThrow();
    expect(files.get("agent-t1.json")).toBeUndefined();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    const failedEvent = events.find((e) => e.event_type === "task_failed" && e.task_id === "t1");
    expect(failedEvent?.payload?.payload_source).toBe("none");
    expect(events.some((e: { event_type: string }) => e.event_type === "task_finished" && e.task_id === "t1")).toBe(false);
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

  it("does not relaunch work when resuming a run already marked stopped", async () => {
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
    const stoppedState = createInitialState(config, "run-stopped-resume");
    stoppedState.status = "stopped";
    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(stoppedState),
    });
    await runOrchestration("run-stopped-resume", fake, store);
    expect(fake.launches).toHaveLength(0);
    expect(JSON.parse(files.get("state.json")!).status).toBe("stopped");
  });

  it("skips orchestration loop when stopped state loads after transient read failures", async () => {
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
    const stoppedState = createInitialState(config, "run-stopped-transient");
    stoppedState.status = "stopped";
    const stateJson = serialize(stoppedState);
    let stateReadCount = 0;
    const files: FileStore = new Map([["config.yaml", toYaml(config)], ["state.json", stateJson]]);
    const store = {
      rateLimitRemaining: null,
      rateLimitLimit: null,
      async readFile(_runId: string, filename: string): Promise<string> {
        if (filename === "state.json") {
          stateReadCount += 1;
          if (stateReadCount <= 2) {
            throw new Error("transient repo read failure");
          }
          return files.get(filename) ?? "";
        }
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
    await runOrchestration("run-stopped-transient", fake, store);
    expect(fake.launches).toHaveLength(0);
    expect(JSON.parse(files.get("state.json")!).status).toBe("stopped");
  });

  it("does not launch planning when resuming a stopped prompt-only run", async () => {
    const config = promptOnlyConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r-plan", status: "finished", result: "" },
        },
      ],
    });
    const stoppedState = createInitialState(config, "run-stopped-plan");
    stoppedState.status = "stopped";
    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(stoppedState),
    });
    await runOrchestration("run-stopped-plan", fake, store);
    expect(fake.launches).toHaveLength(0);
    expect(JSON.parse(files.get("state.json")!).status).toBe("stopped");
  });

  it("marks a task blocked when worker JSON reports blocked status", async () => {
    const config = singleTaskConfig();
    const blockedPayload = {
      task_id: "t1",
      status: "blocked",
      summary: "needs credentials",
      blocked_reason: "missing API key",
      outputs: {},
    };
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-blocked/t1") },
          artifacts: { "cursor-orch-output.json": JSON.stringify(blockedPayload) },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "agent-t1.json") {
        await baseWrite(
          runId,
          "stop-requested.json",
          JSON.stringify({ requested_at: new Date().toISOString(), requested_by: "test" }),
        );
      }
    };
    await runOrchestration("run-blocked", fake, store);
    const agentPayload = JSON.parse(files.get("agent-t1.json")!);
    expect(agentPayload.status).toBe("blocked");
    const state = JSON.parse(files.get("state.json")!);
    expect(state.agents.t1.status).toBe("stopped");
    expect(state.status).toBe("stopped");
  }, 20_000);

  it("marks a task failed when worker JSON reports failed status", async () => {
    const config = singleTaskConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-worker-failed/t1") },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({
              task_id: "t1",
              status: "failed",
              summary: "worker could not finish",
              outputs: {},
            }),
          },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-worker-failed", fake, store)).rejects.toThrow();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
    expect(state.agents.t1.summary).toBe("worker could not finish");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string }) => e.event_type === "task_failed" && e.task_id === "t1")).toBe(true);
  });

  it("runs dependent tasks sequentially and injects upstream outputs into the worker prompt", async () => {
    const config = twoTaskChainConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        completedWorkerScript("t1", "run-dep-chain", { upstream_token: "from-t1" }),
        completedWorkerScript("t2", "run-dep-chain"),
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-dep-chain", fake, store);
    expect(fake.launches).toHaveLength(2);
    expect(fake.sentPrompts).toHaveLength(2);
    expect(fake.sentPrompts[1]).toContain("from-t1");
    expect(fake.sentPrompts[1]).toContain('Output from task "t1"');
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.agents.t1.status).toBe("finished");
    expect(state.agents.t2.status).toBe("finished");
  });

  it("does not inject dependency outputs from agent files with empty JSON objects", async () => {
    const config = twoTaskChainConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        completedWorkerScript("t1", "run-dep-empty-json", { upstream_token: "canonical-t1" }),
        completedWorkerScript("t2", "run-dep-empty-json"),
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "agent-t1.json") {
        await baseWrite(runId, filename, "{}");
      }
    };
    await runOrchestration("run-dep-empty-json", fake, store);
    expect(fake.launches).toHaveLength(2);
    const t2Prompt = fake.sentPrompts[1]!;
    expect(t2Prompt).not.toContain("canonical-t1");
    expect(t2Prompt).not.toContain("upstream_token");
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
  });

  it("ignores malformed JSON in agent files when gathering dependency outputs", async () => {
    const config = twoTaskChainConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        completedWorkerScript("t1", "run-dep-bad-json", { upstream_token: "canonical-t1" }),
        completedWorkerScript("t2", "run-dep-bad-json"),
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "agent-t1.json") {
        await baseWrite(runId, filename, "{not valid json");
      }
    };
    await runOrchestration("run-dep-bad-json", fake, store);
    expect(fake.launches).toHaveLength(2);
    const t2Prompt = fake.sentPrompts[1]!;
    expect(t2Prompt).not.toContain("canonical-t1");
    expect(t2Prompt).not.toContain("upstream_token");
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
  });

  it("marks a completed worker stopped when stop is requested while the worker is running", async () => {
    const config = singleTaskConfig();
    const script = completedWorkerScript("t1", "run-stop-finalize");
    script.waitDelayMs = 6_000;
    const fake = new FakeAgentClient({
      defaultScripts: [script],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "state.json") {
        const state = JSON.parse(content) as { agents?: Record<string, { status?: string }> };
        if (state.agents?.t1?.status === "running") {
          await baseWrite(
            runId,
            "stop-requested.json",
            JSON.stringify({ requested_at: new Date().toISOString(), requested_by: "test" }),
          );
        }
      }
    };
    await runOrchestration("run-stop-finalize", fake, store);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("stopped");
    expect(state.agents.t1.status).toBe("stopped");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string; task_id: string }) => e.event_type === "task_finished" && e.task_id === "t1")).toBe(
      false,
    );
  }, 20_000);

  it("marks a worker stopped when stop is requested before the in-memory stop flag is set", async () => {
    const config = singleTaskConfig();
    const script = completedWorkerScript("t1", "run-stop-fast-worker");
    script.waitDelayMs = 3_000;
    const fake = new FakeAgentClient({
      defaultScripts: [script],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "state.json") {
        const state = JSON.parse(content) as { agents?: Record<string, { status?: string }> };
        if (state.agents?.t1?.status === "running") {
          await baseWrite(
            runId,
            "stop-requested.json",
            JSON.stringify({ requested_at: new Date().toISOString(), requested_by: "test" }),
          );
        }
      }
    };
    await runOrchestration("run-stop-fast-worker", fake, store);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("stopped");
    expect(state.agents.t1.status).toBe("stopped");
  }, 20_000);

  it("does not launch the next delegation phase after stop during the current phase", async () => {
    const mk = (id: string) => ({
      id,
      repo: "svc" as const,
      prompt: `task ${id}`,
      model: null,
      depends_on: [] as string[],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
    });
    const config: OrchestratorConfig = {
      name: "demo",
      model: { id: "composer-2" },
      prompt: "",
      repositories: { svc: { url: "https://github.com/acme/svc", ref: "main" } },
      tasks: [mk("t1"), mk("t2")],
      delegation_map: {
        phases: [
          { id: "p1", groups: [{ id: "g1", task_ids: ["t1"] }] },
          { id: "p2", groups: [{ id: "g2", task_ids: ["t2"] }] },
        ],
      },
      target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "cursor-orch", branch_layout: "per_task" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
    const script1 = completedWorkerScript("t1", "run-stop-deleg");
    script1.waitDelayMs = 3_000;
    const fake = new FakeAgentClient({
      defaultScripts: [script1, completedWorkerScript("t2", "run-stop-deleg")],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "state.json") {
        const state = JSON.parse(content) as { agents?: Record<string, { status?: string }> };
        if (state.agents?.t1?.status === "running") {
          await baseWrite(
            runId,
            "stop-requested.json",
            JSON.stringify({ requested_at: new Date().toISOString(), requested_by: "test" }),
          );
        }
      }
    };
    await runOrchestration("run-stop-deleg", fake, store);
    expect(fake.launches).toHaveLength(1);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("stopped");
    expect(state.agents.t1.status).toBe("stopped");
    expect(state.agents.t2.status).toBe("pending");
  }, 20_000);

  it("does not mark a completed worker finished when stop is requested during finalization", async () => {
    const config = singleTaskConfig();
    const script = completedWorkerScript("t1", "run-stop-finalize-late");
    const fake = new FakeAgentClient({
      defaultScripts: [script],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "agent-t1.json") {
        await baseWrite(
          runId,
          "stop-requested.json",
          JSON.stringify({ requested_at: new Date().toISOString(), requested_by: "test" }),
        );
      }
    };
    await runOrchestration("run-stop-finalize-late", fake, store);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("stopped");
    expect(state.agents.t1.status).toBe("stopped");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string; task_id: string }) => e.event_type === "task_finished" && e.task_id === "t1")).toBe(
      false,
    );
  }, 20_000);

  it("ignores non-canonical agent files when gathering dependency outputs", async () => {
    const config = twoTaskChainConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        completedWorkerScript("t1", "run-dep-invalid", { upstream_token: "canonical-t1" }),
        completedWorkerScript("t2", "run-dep-invalid"),
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    const baseWrite = store.writeFile.bind(store);
    store.writeFile = async (runId, filename, content) => {
      await baseWrite(runId, filename, content);
      if (filename === "agent-t1.json") {
        await baseWrite(
          runId,
          filename,
          JSON.stringify({
            task_id: "t1",
            status: "bogus",
            outputs: { poison: "do-not-inject" },
          }),
        );
      }
    };
    await runOrchestration("run-dep-invalid", fake, store);
    expect(fake.launches).toHaveLength(2);
    expect(fake.sentPrompts).toHaveLength(2);
    const t2Prompt = fake.sentPrompts[1]!;
    expect(t2Prompt).not.toContain("do-not-inject");
    expect(t2Prompt).not.toContain("canonical-t1");
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
  });

  it("cascades failure to dependent tasks without launching them", async () => {
    const config = twoTaskChainConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("ERROR")],
          result: { id: "r-t1", status: "error" },
        },
        completedWorkerScript("t2", "run-dep-cascade"),
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-dep-cascade", fake, store)).rejects.toThrow();
    expect(fake.launches).toHaveLength(1);
    const state = JSON.parse(files.get("state.json")!);
    expect(state.agents.t1.status).toBe("failed");
    expect(state.agents.t2.status).toBe("failed");
    expect(state.agents.t2.cascade_source_task_id).toBe("t1");
    expect(state.agents.t2.summary).toContain("Upstream task t1 failed");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string; task_id: string }) => e.event_type === "task_failed" && e.task_id === "t2")).toBe(true);
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

  it("cascades terminal upstream failure to dependent pending tasks without launching them", async () => {
    const config = twoTaskChainConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-cascade-fail/t1") },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({
              task_id: "t1",
              status: "failed",
              summary: "upstream broke",
              outputs: {},
            }),
          },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-cascade-fail", fake, store)).rejects.toThrow();
    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.agents.t1.status).toBe("failed");
    expect(state.agents.t1.summary).toBe("upstream broke");
    expect(state.agents.t2.status).toBe("failed");
    expect(state.agents.t2.cascade_source_task_id).toBe("t1");
    expect(state.agents.t2.summary).toBe("Upstream task t1 failed");
    expect(fake.launches).toHaveLength(1);
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string; task_id: string }) => e.event_type === "task_failed" && e.task_id === "t2")).toBe(
      true,
    );
  });

  it("passes persisted upstream outputs into the dependent worker launch prompt", async () => {
    const config = twoTaskChainConfig();
    const upstreamMarker = "upstream-marker-7f3a";
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r1", status: "finished", git: runGit("cursor-orch/run-dep-chain/t1") },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({
              task_id: "t1",
              status: "completed",
              summary: "t1 done",
              outputs: { marker: upstreamMarker },
            }),
          },
        },
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r2", status: "finished", git: runGit("cursor-orch/run-dep-chain/t2") },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({
              task_id: "t2",
              status: "completed",
              summary: "t2 done",
              outputs: {},
            }),
          },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-dep-chain", fake, store);
    expect(fake.launches).toHaveLength(2);
    expect(fake.launches[0]!.prompt).not.toContain(upstreamMarker);
    expect(fake.launches[1]!.prompt).toContain("CONTEXT FROM UPSTREAM TASKS");
    expect(fake.launches[1]!.prompt).toContain(upstreamMarker);
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
  });

  it("rejects resume when state.json is corrupt", async () => {
    const config = singleTaskConfig();
    const { store } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": "{not-json",
    });
    await expect(runOrchestration("run-corrupt-state", new FakeAgentClient(), store)).rejects.toThrow(
      /Invalid state\.json/,
    );
  });

  it("rejects resume when state.json is empty but events.jsonl exists", async () => {
    const config = singleTaskConfig();
    const { store } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": "",
      "events.jsonl": `${JSON.stringify({
        timestamp: "2026-06-01T00:00:00.000Z",
        event_type: "orchestration_started",
        task_id: null,
        detail: "Orchestration started",
      })}\n`,
    });
    await expect(runOrchestration("run-empty-state", new FakeAgentClient(), store)).rejects.toThrow(
      /refusing to reset orchestration progress/,
    );
  });
});
