import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import { createInitialState, seedMainAgent, serialize } from "../src/state.js";
import { FakeAgentClient, FakeSdkRun, statusMessage } from "./support/fake-agent-client.js";
import {
  createInMemoryRepoStore,
  installGithubBranchPrepMock,
  restoreGithubBranchPrepMock,
  runGit,
  singleTaskConfig,
} from "./support/reattach-fixtures.js";

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

describe("reattachWorkers blocked tasks", () => {
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
    restoreGithubBranchPrepMock();
    process.env = { ...originalEnv };
  });

  it("does not call listRuns for blocked tasks on resume", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-blocked";
    const blockedAgentId = "blocked-agent-1";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
    state.agents.t1 = {
      ...state.agents.t1!,
      agent_id: blockedAgentId,
      status: "blocked",
      blocked_reason: "needs clarification",
      blocked_since: new Date(Date.now() - 400_000).toISOString(),
      summary: "blocked",
    };

    const successScript = {
      events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
      result: { id: "r-retry", status: "finished" as const, git: runGit(`cursor-orch/${runId}/t1-retry-1`) },
      artifacts: {
        "cursor-orch-output.json": JSON.stringify({
          task_id: "t1",
          status: "completed",
          summary: "done after blocked retry",
          outputs: {},
        }),
      },
    };

    const fake = new FakeAgentClient({
      runsByAgent: {
        [blockedAgentId]: [successScript],
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
    expect(fake.launches).toHaveLength(0);
    expect(listRunsMock).not.toHaveBeenCalled();
  });

  it("calls resumeCloudAgent for blocked retry when the in-memory handle is gone", async () => {
    const config = singleTaskConfig();
    const runId = "run-blocked-resume";
    const blockedAgentId = "blocked-agent-resume";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
    state.agents.t1 = {
      ...state.agents.t1!,
      agent_id: blockedAgentId,
      status: "blocked",
      blocked_reason: "needs clarification",
      blocked_since: new Date(Date.now() - 400_000).toISOString(),
      summary: "blocked",
    };

    const successScript = {
      events: [statusMessage("RUNNING"), statusMessage("FINISHED")],
      result: { id: "r-retry", status: "finished" as const, git: runGit(`cursor-orch/${runId}/t1-retry-1`) },
      artifacts: {
        "cursor-orch-output.json": JSON.stringify({
          task_id: "t1",
          status: "completed",
          summary: "done after blocked resume",
          outputs: {},
        }),
      },
    };

    const fake = new FakeAgentClient({
      runsByAgent: {
        [blockedAgentId]: [successScript],
      },
      conversationText: null,
    });
    const resumeSpy = vi.spyOn(fake, "resumeCloudAgent");

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
    });

    await runOrchestration(runId, fake, store);

    expect(resumeSpy).toHaveBeenCalledWith(
      blockedAgentId,
      expect.objectContaining({ apiKey: "sk-fake" }),
    );
    expect(fake.launches).toHaveLength(0);
    expect(JSON.parse(files.get("state.json")!).agents.t1.status).toBe("finished");
  });

  it("marks blocked task failed when resumeCloudAgent throws during retry", async () => {
    const config = singleTaskConfig();
    const runId = "run-blocked-resume-fail";
    const blockedAgentId = "blocked-agent-gone";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
    state.agents.t1 = {
      ...state.agents.t1!,
      agent_id: blockedAgentId,
      status: "blocked",
      blocked_reason: "stuck",
      blocked_since: new Date(Date.now() - 400_000).toISOString(),
      summary: "blocked",
    };

    const fake = new FakeAgentClient({ conversationText: null });
    vi.spyOn(fake, "resumeCloudAgent").mockRejectedValue(new Error("agent gone"));

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
    });

    await expect(runOrchestration(runId, fake, store)).rejects.toThrow(/Failed tasks: t1/);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.agents.t1.status).toBe("failed");
    expect(final.agents.t1.summary).toBe("Blocked retry resume failed: agent gone");
    expect(fake.launches).toHaveLength(0);
  });
});
