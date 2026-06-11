import { vi } from "vitest";
import type { RunResult as SdkRunResult } from "@cursor/sdk";
import type { RepoStoreClient } from "../../src/api/repo-store.js";
import type { OrchestratorConfig } from "../../src/config/types.js";
import type { AgentState, OrchestrationEvent, OrchestrationState } from "../../src/state.js";
import { createInitialState, seedMainAgent } from "../../src/state.js";
import { statusMessage } from "./fake-agent-client.js";

export type FileStore = Map<string, string>;

export function runGit(branch: string): NonNullable<SdkRunResult["git"]> {
  return { branches: [{ repoUrl: "https://github.com/acme/svc", branch }] };
}

export function createInMemoryRepoStore(initial: Record<string, string>): { store: RepoStoreClient; files: FileStore } {
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

export function singleTaskConfig(): OrchestratorConfig {
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
    bootstrap_repo_name: "b",
  };
}

export function runningOrchestrationState(
  config: OrchestratorConfig,
  runId: string,
  taskPatch?: Partial<AgentState>,
): OrchestrationState {
  const state = createInitialState(config, runId);
  state.status = "running";
  state.started_at = new Date().toISOString();
  seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
  if (taskPatch) {
    state.agents.t1 = { ...state.agents.t1!, ...taskPatch };
  }
  return state;
}

export function completedResumeScript(runId: string) {
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

export function taskLaunchedEvent(
  runId: string,
  agentId: string,
  opts?: { legacyPayload?: boolean; runIdInPayload?: string },
): OrchestrationEvent {
  const payload: Record<string, string> = {
    run_id: opts?.runIdInPayload ?? "run-live",
    repository: "https://github.com/acme/svc",
    ref: "main",
    branch: `cursor-orch/${runId}/t1`,
  };
  if (!opts?.legacyPayload) {
    payload.agent_id = agentId;
  }
  return {
    timestamp: "2026-06-01T00:00:00.000Z",
    event_type: "task_launched",
    task_id: "t1",
    phase_id: "execution",
    agent_node_id: "t1",
    agent_kind: "task",
    detail: `Launched t1 (${agentId})`,
    payload,
  };
}

export function taskLaunchedEventLine(
  runId: string,
  agentId: string,
  opts?: { legacyPayload?: boolean; runIdInPayload?: string },
): string {
  return JSON.stringify(taskLaunchedEvent(runId, agentId, opts));
}

let unmockedFetch: typeof fetch;

export function installGithubBranchPrepMock(): void {
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

export function restoreGithubBranchPrepMock(): void {
  globalThis.fetch = unmockedFetch;
}

export function resetReattachTestEnv(listRunsMock: ReturnType<typeof vi.fn>): void {
  process.env.CURSOR_API_KEY = "sk-fake";
  process.env.GH_TOKEN = "ghp-fake";
  process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "0";
  delete process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS;
  delete process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES;
  installGithubBranchPrepMock();
  listRunsMock.mockReset();
}

export function restoreReattachTestEnv(originalEnv: NodeJS.ProcessEnv): void {
  restoreGithubBranchPrepMock();
  process.env = { ...originalEnv };
}
