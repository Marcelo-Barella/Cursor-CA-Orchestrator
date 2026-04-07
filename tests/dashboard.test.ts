import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { pollOnce, renderLive, renderLiveInline } from "../src/dashboard.js";
import { createInitialState, serialize } from "../src/state.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...mod,
    setTimeout: () => Promise.resolve(undefined),
  };
});

function baseConfig(): OrchestratorConfig {
  return {
    name: "test-orch",
    model: "m",
    prompt: "",
    repositories: {},
    tasks: [
      {
        id: "t1",
        repo: "o/r",
        prompt: "p",
        model: null,
        depends_on: [],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
    ],
    target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "x", branch_layout: "consolidated" },
    bootstrap_repo_name: "b",
  };
}

function mockRepoStore(readFileImpl: (runId: string, path: string) => Promise<string>): RepoStoreClient {
  return { readFile: readFileImpl } as unknown as RepoStoreClient;
}

describe("pollOnce terminal detection", () => {
  it("sets terminal true for completed, failed, and stopped", async () => {
    const config = baseConfig();
    for (const status of ["completed", "failed", "stopped"] as const) {
      const state = createInitialState(config, "run1");
      state.status = status;
      const repoStore = mockRepoStore(async (_rid, name) => {
        if (name === "state.json") return serialize(state);
        if (name === "events.jsonl") return "";
        return "";
      });
      const got = await pollOnce(repoStore, "run1", config);
      expect(got.terminal).toBe(true);
      expect(got.state.status).toBe(status);
    }
  });

  it("sets terminal false while orchestration is still running", async () => {
    const config = baseConfig();
    const state = createInitialState(config, "run1");
    state.status = "running";
    const repoStore = mockRepoStore(async (_rid, name) => {
      if (name === "state.json") return serialize(state);
      if (name === "events.jsonl") return "";
      return "";
    });
    const got = await pollOnce(repoStore, "run1", config);
    expect(got.terminal).toBe(false);
  });
});

describe("renderLiveInline non-TTY final snapshot", () => {
  beforeEach(() => {
    vi.spyOn(console, "clear").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a final snapshot on terminal status after a non-terminal poll (poll interval mocked)", async () => {
    const config = baseConfig();
    let poll = 0;
    const repoStore = mockRepoStore(async (_rid, name) => {
      if (name === "config.yaml") return "";
      if (name === "events.jsonl") return "";
      if (name !== "state.json") return "";
      poll += 1;
      const state = createInitialState(config, "run1");
      state.status = poll === 1 ? "running" : "completed";
      return serialize(state);
    });

    await renderLiveInline(repoStore, "run1", config);

    expect(poll).toBe(2);
    expect(console.clear).toHaveBeenCalledTimes(2);
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("completed");
  });

  it("on immediate terminal state, prints one snapshot and skips the poll wait", async () => {
    const config = baseConfig();
    const state = createInitialState(config, "run1");
    state.status = "failed";
    const repoStore = mockRepoStore(async (_rid, name) => {
      if (name === "config.yaml") return "";
      if (name === "events.jsonl") return "";
      if (name === "state.json") return serialize(state);
      return "";
    });

    await renderLiveInline(repoStore, "run1", config);

    expect(console.clear).toHaveBeenCalledTimes(1);
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("failed");
  });
});

describe("renderLive TTY vs inline", () => {
  let isTTY: boolean;

  beforeEach(() => {
    isTTY = process.stdout.isTTY ?? false;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses inline path when stdout is not a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    vi.spyOn(console, "clear").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const config = baseConfig();
    const state = createInitialState(config, "run1");
    state.status = "completed";
    const repoStore = mockRepoStore(async (_rid, name) => {
      if (name === "config.yaml") return "";
      if (name === "events.jsonl") return "";
      if (name === "state.json") return serialize(state);
      return "";
    });

    await renderLive(repoStore, "run1", config);
    expect(console.clear).toHaveBeenCalled();
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("completed");
  });

  it("uses inline path when TTY but CURSOR_ORCH_QUIET forces non-interactive dashboard", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.stubEnv("CURSOR_ORCH_QUIET", "1");
    vi.spyOn(console, "clear").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const config = baseConfig();
    const state = createInitialState(config, "run1");
    state.status = "stopped";
    const repoStore = mockRepoStore(async (_rid, name) => {
      if (name === "config.yaml") return "";
      if (name === "events.jsonl") return "";
      if (name === "state.json") return serialize(state);
      return "";
    });

    await renderLive(repoStore, "run1", config);
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("stopped");
  });
});
