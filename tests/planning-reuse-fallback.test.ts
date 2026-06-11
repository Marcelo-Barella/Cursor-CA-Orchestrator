import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { FakeAgentClient, statusMessage } from "./support/fake-agent-client.js";
import * as planner from "../src/planner.js";

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

describe("planning reuse fallback", () => {
  let waitForPlanSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installGithubBranchPrepMock();
    process.env.GH_TOKEN = "gh-test";
    process.env.CURSOR_API_KEY = "sk-fake";
    listRunsMock.mockReset();
    waitForPlanSpy = vi.spyOn(planner, "waitForPlan").mockResolvedValue(null);
  });

  afterEach(() => {
    globalThis.fetch = unmockedFetch;
    waitForPlanSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("falls back to full planning when task-plan.json cannot be reused", async () => {
    const config = promptOnlyConfig();
    const validPlan = JSON.stringify({
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "Planned work.",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    listRunsMock.mockResolvedValue({
      items: [{ result: validPlan }],
    });
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: { id: "r-plan", status: "finished", result: "" },
        },
        {
          events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
          result: {
            id: "r-t1",
            status: "finished",
            git: { branches: [{ repoUrl: "https://github.com/acme/svc", branch: "cursor-orch/run-reuse-fallback/t1" }] },
          },
          artifacts: {
            "cursor-orch-output.json": JSON.stringify({
              task_id: "t1",
              status: "completed",
              summary: "ok",
              outputs: {},
            }),
          },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "task-plan.json": "{not-valid-json",
    });

    await runOrchestration("run-reuse-fallback", fake, store);

    expect(fake.launches).toHaveLength(2);
    expect(listRunsMock).toHaveBeenCalled();
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
    const events = files.get("events.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e: { event_type: string }) => e.event_type === "planning_started")).toBe(true);
    expect(events.some((e: { event_type: string; detail?: string }) => e.event_type === "planning_completed" && !e.detail?.includes("reused"))).toBe(
      true,
    );
  });
});
