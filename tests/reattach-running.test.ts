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
    restoreGithubBranchPrepMock();
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

  it("prefers the running SDK run when listRuns returns multiple runs", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-multi-run";
    const liveAgentId = "agent-live-multi";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });
    state.agents.t1 = {
      ...state.agents.t1!,
      agent_id: liveAgentId,
      status: "running",
    };

    const staleRun = new FakeSdkRun(liveAgentId, {
      events: [statusMessage("FINISHED")],
      result: { id: "stale-run", status: "finished" },
    });
    staleRun.status = "finished";
    Object.defineProperty(staleRun, "createdAt", { value: 200 });

    const activeScript = completedResumeScript(runId);
    const activeRun = new FakeSdkRun(liveAgentId, activeScript);
    activeRun.status = "running";
    Object.defineProperty(activeRun, "createdAt", { value: 100 });

    listRunsMock.mockResolvedValue({ items: [staleRun, activeRun] });

    const fake = new FakeAgentClient({
      runsByAgent: { [liveAgentId]: [activeScript] },
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
  });

  it("reattaches from task_launched events when state.json lost agent_id", async () => {
    const config = singleTaskConfig();
    const runId = "run-recover-from-events";
    const liveAgentId = "agent-live-events";
    const state = createInitialState(config, runId);
    state.status = "running";
    state.started_at = new Date().toISOString();
    seedMainAgent(state, { agent_id: "orch-1", status: "running", started_at: state.started_at });

    const resumeScript = completedResumeScript(runId);
    const resumedRun = new FakeSdkRun(liveAgentId, resumeScript);
    listRunsMock.mockResolvedValue({ items: [resumedRun] });

    const fake = new FakeAgentClient({
      runsByAgent: { [liveAgentId]: [resumeScript] },
      conversationText: null,
    });

    const launchEvent = JSON.stringify({
      timestamp: "2026-06-01T00:00:00.000Z",
      event_type: "task_launched",
      task_id: "t1",
      phase_id: "execution",
      agent_node_id: "t1",
      agent_kind: "task",
      detail: `Launched t1 (${liveAgentId})`,
      payload: {
        agent_id: liveAgentId,
        run_id: "run-live",
        repository: "https://github.com/acme/svc",
        ref: "main",
        branch: `cursor-orch/${runId}/t1`,
      },
    });

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
      "events.jsonl": `${launchEvent}\n`,
    });

    await runOrchestration(runId, fake, store);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.status).toBe("completed");
    expect(final.agents.t1.agent_id).toBe(liveAgentId);
    expect(final.agents.t1.status).toBe("finished");
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
