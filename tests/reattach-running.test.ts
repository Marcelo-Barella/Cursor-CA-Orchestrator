import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult as SdkRunResult } from "@cursor/sdk";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { createInitialState, seedMainAgent, serialize } from "../src/state.js";
import { FakeAgentClient, FakeSdkRun, statusMessage } from "./support/fake-agent-client.js";

const listRunsMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@cursor/sdk")>();
  return {
    ...mod,
    Agent: {
      ...mod.Agent,
      listRuns: listRunsMock,
    },
  };
});

type FileStore = Map<string, string>;

function runGit(branch: string): NonNullable<SdkRunResult["git"]> {
  return { branches: [{ repoUrl: "https://github.com/acme/svc", branch }] };
}

function createInMemoryRepoStore(initial: Record<string, string>): { store: RepoStoreClient; files: FileStore } {
  const files: FileStore = new Map(Object.entries(initial));
  const store = {
    rateLimitRemaining: null,
    rateLimitLimit: null,
    async readFile(_runId: string, filename: string): Promise<string> {
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

function completedResumeScript(runId: string) {
  return {
    events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
    result: { id: "r-resume", status: "finished" as const, git: runGit(`cursor-orch/${runId}/t1`) },
    artifacts: {
      "cursor-orch-output.json": JSON.stringify({
        task_id: "t1",
        status: "completed",
        summary: "done after resume",
        outputs: {},
      }),
    },
  };
}

describe("reattachWorkers running tasks", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CURSOR_API_KEY = "sk-fake";
    process.env.GH_TOKEN = "ghp-fake";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "0";
    delete process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS;
    delete process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES;
    installGithubBranchPrepMock();
    listRunsMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = unmockedFetch;
    process.env = { ...originalEnv };
  });

  it("reattaches running workers via resumeCloudAgent and listRuns without relaunching", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-running";
    const liveAgentId = "agent-live-1";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
    state.agents.t1 = {
      ...state.agents.t1!,
      agent_id: liveAgentId,
      status: "running",
      summary: "in flight",
    };

    const resumeScript = completedResumeScript(runId);
    const resumedRun = new FakeSdkRun(liveAgentId, resumeScript);
    listRunsMock.mockResolvedValue({ items: [resumedRun] });

    const fake = new FakeAgentClient({
      runsByAgent: {
        [liveAgentId]: [resumeScript],
      },
      conversationText: null,
    });

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
    });

    await runOrchestration(runId, fake, store);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.status).toBe("completed");
    expect(final.agents.t1.status).toBe("finished");
    expect(listRunsMock).toHaveBeenCalledWith(liveAgentId, { runtime: "cloud", apiKey: "sk-fake" });
    expect(fake.launches).toHaveLength(0);
  });

  it("marks the task failed when resume finds no SDK runs", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-no-runs";
    const liveAgentId = "agent-live-2";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
    state.agents.t1 = {
      ...state.agents.t1!,
      agent_id: liveAgentId,
      status: "running",
    };

    listRunsMock.mockResolvedValue({ items: [] });

    const fake = new FakeAgentClient({
      runsByAgent: { [liveAgentId]: [] },
      conversationText: null,
    });

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
    });

    await expect(runOrchestration(runId, fake, store)).rejects.toThrow(/Failed tasks: t1/);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.agents.t1.status).toBe("failed");
    expect(final.agents.t1.summary).toBe("Resume: no runs found for agent");
    expect(fake.launches).toHaveLength(0);
  });

  it("marks the task failed when resumeCloudAgent throws", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-resume-fail";
    const liveAgentId = "agent-live-3";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
    state.agents.t1 = {
      ...state.agents.t1!,
      agent_id: liveAgentId,
      status: "launching",
    };

    const fake = new FakeAgentClient({ conversationText: null });
    vi.spyOn(fake, "resumeCloudAgent").mockRejectedValue(new Error("resume boom"));

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
    });

    await expect(runOrchestration(runId, fake, store)).rejects.toThrow(/Failed tasks: t1/);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.agents.t1.status).toBe("failed");
    expect(final.agents.t1.summary).toBe("Resume failed: resume boom");
    expect(listRunsMock).not.toHaveBeenCalled();
    expect(fake.launches).toHaveLength(0);
  });
});
