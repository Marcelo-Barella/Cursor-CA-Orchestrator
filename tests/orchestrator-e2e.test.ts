import type { RunResult as SdkRunResult } from "@cursor/sdk";
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
        allowed_paths: [],
      },
    ],
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "cursor-orch", branch_layout: "per_task" },
    bootstrap_repo_name: "cursor-orch-bootstrap",
    max_iterations: 10,
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
    allowed_paths: [],
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
    max_iterations: 10,
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
    expect(fake.launches[1]!.opts.startingRef).toBe("cursor-orch/run-retry-ok/t1-retry-1");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string }) => e.event_type === "task_retried")).toBe(true);
    expect(events.filter((e: { event_type: string }) => e.event_type === "task_failed").length).toBeGreaterThanOrEqual(1);
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

function v3ClaimsHappyConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const mk = (id: string, path: string) => ({
    id,
    repo: "svc",
    prompt: `task ${id}`,
    model: null,
    depends_on: [] as string[],
    timeout_minutes: 30,
    create_repo: false,
    repo_config: null,
    allowed_paths: [path],
  });
  return {
    name: "v3-demo",
    model: { id: "composer-2" },
    prompt: "",
    repositories: {
      svc: { url: "https://github.com/acme/svc", ref: "main" },
    },
    tasks: [mk("t-a", "src/a"), mk("t-b", "src/b")],
    target: {
      auto_create_pr: true,
      consolidate_prs: true,
      branch_prefix: "cursor-orch",
      branch_layout: "per_task",
    },
    bootstrap_repo_name: "cursor-orch-bootstrap",
    max_iterations: 10,
    ...overrides,
  };
}

function v3WorkerScript(runId: string, taskId: string) {
  return {
    events: [statusMessage("CREATING"), statusMessage("RUNNING"), assistantText("ok"), statusMessage("FINISHED")],
    result: {
      id: `r-${taskId}`,
      status: "finished" as const,
      git: runGit(`cursor-orch/${runId}/${taskId}`),
    },
    artifacts: {
      "cursor-orch-output.json": JSON.stringify({
        task_id: taskId,
        status: "completed",
        summary: "ok",
        outputs: {},
      }),
    },
  };
}

const v3GateScript = {
  events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
  result: { id: "r-gate", status: "finished" as const },
};

function installV3GateResultWriter(
  fake: FakeAgentClient,
  store: RepoStoreClient,
  runId: string,
  decide: (gate: "code_quality" | "code_review" | "computer_use", wave: number) => {
    passed: boolean;
    findings?: { severity: "blocking" | "info"; message: string; path?: string }[];
    summary?: string;
  },
): void {
  let gateSendCount = 0;
  const originalCreate = fake.createCloudAgent.bind(fake);
  fake.createCloudAgent = async (opts) => {
    const agent = await originalCreate(opts);
    const originalSend = agent.send.bind(agent);
    agent.send = async (prompt: string) => {
      const run = await originalSend(prompt);
      for (const gate of ["code_quality", "code_review", "computer_use"] as const) {
        if (prompt.includes(`Gate: ${gate}`)) {
          const wave = Math.floor(gateSendCount / 3);
          gateSendCount += 1;
          const decision = decide(gate, wave);
          await store.writeFile(
            runId,
            `gate-results/${gate}.json`,
            JSON.stringify({
              gate,
              passed: decision.passed,
              findings: decision.findings ?? [],
              summary: decision.summary ?? (decision.passed ? `${gate} ok` : `${gate} failed`),
            }),
          );
        }
      }
      return run;
    };
    return agent;
  };
}

function installV3GithubMock(tracker: { pulls: number; merges: string[]; createdRefs: Set<string> }): void {
  unmockedFetch = globalThis.fetch;
  tracker.createdRefs.add("main");
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (!url.startsWith("https://api.github.com/")) {
      return unmockedFetch(input, init);
    }
    if (url.endsWith("/user") || url.includes("/user?")) {
      return new Response(JSON.stringify({ login: "acme" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/git/ref/heads/")) {
      const tail = url.split("/git/ref/heads/")[1] ?? "";
      const decoded = decodeURIComponent(tail);
      if (tracker.createdRefs.has(decoded)) {
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
    if (url.includes("/git/refs") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string };
      const ref = (body.ref ?? "").replace(/^refs\/heads\//, "");
      if (ref) tracker.createdRefs.add(ref);
      return new Response(JSON.stringify({ ref: body.ref }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/merges") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { head?: string; base?: string };
      tracker.merges.push(`${body.head ?? ""}->${body.base ?? ""}`);
      return new Response(JSON.stringify({ sha: "mergedsha" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/pulls") && method === "POST") {
      tracker.pulls += 1;
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/svc/pull/1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return unmockedFetch(input, init);
  }) as typeof fetch;
}

describe("runOrchestration v3 claims path", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.CURSOR_API_KEY = "sk-fake";
    process.env.GH_TOKEN = "ghp-fake";
    process.env.BOOTSTRAP_OWNER = "acme";
    process.env.BOOTSTRAP_REPO = "cursor-orch-bootstrap";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "0";
    delete process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS;
    delete process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES;
  });
  afterEach(() => {
    globalThis.fetch = unmockedFetch;
    process.env = { ...originalEnv };
  });

  it("v3 happy path: implement, fan-in, gates, finalize one PR", async () => {
    const config = v3ClaimsHappyConfig();
    const runId = "run-v3-happy";
    const runBranch = `cursor-orch/${runId}/main/run`;
    const tracker = { pulls: 0, merges: [] as string[], createdRefs: new Set<string>() };
    installV3GithubMock(tracker);

    const fake = new FakeAgentClient({
      defaultScripts: [
        v3WorkerScript(runId, "t-a"),
        v3WorkerScript(runId, "t-b"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    installV3GateResultWriter(fake, store, runId, () => ({ passed: true }));

    await runOrchestration(runId, fake, store);

    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.phase).toBe("completed");
    expect(tracker.pulls).toBe(1);
    expect(state.consolidated_pr_urls).toBeTruthy();

    const workerLaunches = fake.launches.filter((l) => {
      const ref = l.opts.startingRef ?? "";
      return ref.includes("/t-a") || ref.includes("/t-b");
    });
    expect(workerLaunches.length).toBe(2);
    for (const launch of workerLaunches) {
      expect(launch.opts.startingRef).not.toBe(runBranch);
      expect(launch.opts.startingRef).not.toMatch(/\/run$/);
    }

    const gateLaunches = fake.launches.filter((l) => l.opts.startingRef === runBranch);
    expect(gateLaunches.length).toBe(3);
    expect(files.get("gate-results/code_quality.json")).toBeTruthy();
    expect(files.get("gate-results/code_review.json")).toBeTruthy();
    expect(files.get("gate-results/computer_use.json")).toBeTruthy();
  });

  it("gate fail then fix: code_quality fails once, fix worker recovers, finalize", async () => {
    const config = v3ClaimsHappyConfig();
    const runId = "run-v3-gate-fix";
    const runBranch = `cursor-orch/${runId}/main/run`;
    const tracker = { pulls: 0, merges: [] as string[], createdRefs: new Set<string>() };
    installV3GithubMock(tracker);

    const fake = new FakeAgentClient({
      defaultScripts: [
        v3WorkerScript(runId, "t-a"),
        v3WorkerScript(runId, "t-b"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
        v3WorkerScript(runId, "fix-iter-1-code_quality"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    installV3GateResultWriter(fake, store, runId, (gate, wave) => {
      if (wave === 0 && gate === "code_quality") {
        return {
          passed: false,
          summary: "complexity too high",
          findings: [{ severity: "blocking", message: "too complex", path: "src/a/foo.ts" }],
        };
      }
      return { passed: true };
    });

    await runOrchestration(runId, fake, store);

    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("completed");
    expect(state.phase).toBe("completed");
    expect(state.iteration).toBe(1);
    expect(tracker.pulls).toBe(1);

    const fixLaunches = fake.launches.filter((l) => (l.opts.startingRef ?? "").includes("fix-iter-1-code_quality"));
    expect(fixLaunches.length).toBe(1);

    const gateLaunches = fake.launches.filter((l) => l.opts.startingRef === runBranch);
    expect(gateLaunches.length).toBe(6);

    const fixPlan = JSON.parse(files.get("fix-plan.json")!) as { tasks: { id: string; allowed_paths: string[] }[] };
    const fixTask = fixPlan.tasks.find((t) => t.id === "fix-iter-1-code_quality");
    expect(fixTask).toBeDefined();
    expect(fixTask!.allowed_paths).toEqual(["src/a/foo.ts"]);
  });

  it("replan escalation: same gate fails twice after fix", async () => {
    const config = v3ClaimsHappyConfig({ prompt: "Rebuild the feature with clean review." });
    const runId = "run-v3-replan";
    const runBranch = `cursor-orch/${runId}/main/run`;
    const tracker = { pulls: 0, merges: [] as string[], createdRefs: new Set<string>() };
    installV3GithubMock(tracker);

    const fake = new FakeAgentClient({
      defaultScripts: [
        v3WorkerScript(runId, "t-a"),
        v3WorkerScript(runId, "t-b"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
        v3WorkerScript(runId, "fix-iter-1-code_review"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r-planner", status: "finished" as const },
        },
        v3WorkerScript(runId, "t-replan"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    installV3GateResultWriter(fake, store, runId, (gate, wave) => {
      if (wave < 2 && gate === "code_review") {
        return {
          passed: false,
          summary: "review findings remain",
          findings: [{ severity: "blocking", message: "needs redesign", path: "src/review.ts" }],
        };
      }
      return { passed: true };
    });

    const originalCreate = fake.createCloudAgent.bind(fake);
    fake.createCloudAgent = async (opts) => {
      const agent = await originalCreate(opts);
      if (opts.repoUrl.includes("cursor-orch-bootstrap")) {
        const originalSend = agent.send.bind(agent);
        agent.send = async (prompt: string) => {
          const run = await originalSend(prompt);
          await store.writeFile(
            runId,
            "task-plan.json",
            JSON.stringify({
              tasks: [
                {
                  id: "t-replan",
                  repo: "svc",
                  prompt: "Implement after replan",
                  depends_on: [],
                  allowed_paths: ["src/replan"],
                },
              ],
            }),
          );
          return run;
        };
      }
      return agent;
    };

    await runOrchestration(runId, fake, store);

    const state = JSON.parse(files.get("state.json")!);
    expect(state.iteration).toBeGreaterThanOrEqual(2);
    expect(state.status).toBe("completed");
    expect(state.phase).toBe("completed");

    const plannerLaunches = fake.launches.filter((l) => l.opts.repoUrl.includes("cursor-orch-bootstrap"));
    expect(plannerLaunches.length).toBeGreaterThanOrEqual(1);

    const fixLaunches = fake.launches.filter((l) => (l.opts.startingRef ?? "").includes("fix-iter-1-code_review"));
    expect(fixLaunches.length).toBe(1);

    const gateLaunches = fake.launches.filter((l) => l.opts.startingRef === runBranch);
    expect(gateLaunches.length).toBe(9);
  });

  it("cap exhaustion: max_iterations 1 fails after second gate failure", async () => {
    const config = v3ClaimsHappyConfig({ max_iterations: 1 });
    const runId = "run-v3-cap";
    const tracker = { pulls: 0, merges: [] as string[], createdRefs: new Set<string>() };
    installV3GithubMock(tracker);

    const fake = new FakeAgentClient({
      defaultScripts: [
        v3WorkerScript(runId, "t-a"),
        v3WorkerScript(runId, "t-b"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
        v3WorkerScript(runId, "fix-iter-1-code_quality"),
        v3GateScript,
        v3GateScript,
        v3GateScript,
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    installV3GateResultWriter(fake, store, runId, (gate, _wave) => {
      if (gate === "code_quality") {
        return {
          passed: false,
          summary: "quality still failing",
          findings: [{ severity: "blocking", message: "lint error", path: "src/a.ts" }],
        };
      }
      return { passed: true };
    });

    await expect(runOrchestration(runId, fake, store)).rejects.toThrow(/quality still failing|Orchestration failed/);

    const state = JSON.parse(files.get("state.json")!);
    expect(state.status).toBe("failed");
    expect(state.phase).toBe("failed");
    expect(String(state.error)).toMatch(/code_quality/);
    expect(String(state.error)).toMatch(/quality still failing/);
    expect(tracker.pulls).toBe(0);
    expect(files.get("summary.md")).toBeTruthy();
    expect(files.get("summary.md")).toMatch(/## Gate results/);
    expect(files.get("summary.md")).toMatch(/quality still failing/);
  });
});
