import { vi } from "vitest";
import type { RunResult as SdkRunResult } from "@cursor/sdk";
import type { RepoStoreClient } from "../../src/api/repo-store.js";
import type { OrchestratorConfig } from "../../src/config/types.js";
import { statusMessage, type FakeRunScript } from "./fake-agent-client.js";

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

export function promptOnlyConfig(): OrchestratorConfig {
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

export function completedWorkerScript(
  taskId: string,
  runId: string,
  outputs: Record<string, unknown> = {},
): FakeRunScript {
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
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "acme-user" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return unmockedFetch(input, init);
  }) as typeof fetch;
}

export function restoreGithubBranchPrepMock(): void {
  globalThis.fetch = unmockedFetch;
}
