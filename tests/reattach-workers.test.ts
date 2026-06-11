import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import { serialize } from "../src/state.js";
import { FakeAgentClient, FakeSdkRun, statusMessage } from "./support/fake-agent-client.js";
import {
  completedResumeScript,
  createInMemoryRepoStore,
  resetReattachTestEnv,
  restoreReattachTestEnv,
  runGit,
  runningOrchestrationState,
  singleTaskConfig,
  taskLaunchedEventLine,
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

describe("reattachWorkers running tasks", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => resetReattachTestEnv(listRunsMock));
  afterEach(() => restoreReattachTestEnv(originalEnv));

  it("reattaches running workers via resumeCloudAgent and listRuns without relaunching", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-running";
    const liveAgentId = "agent-live-1";
    const state = runningOrchestrationState(config, runId, {
      agent_id: liveAgentId,
      status: "running",
      summary: "in flight",
    });

    const resumeScript = completedResumeScript(runId);
    listRunsMock.mockResolvedValue({ items: [new FakeSdkRun(liveAgentId, resumeScript)] });

    const fake = new FakeAgentClient({
      runsByAgent: { [liveAgentId]: [resumeScript] },
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
    const state = runningOrchestrationState(config, runId, {
      agent_id: liveAgentId,
      status: "running",
    });

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
    const state = runningOrchestrationState(config, runId, {
      agent_id: liveAgentId,
      status: "running",
    });

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
    const state = runningOrchestrationState(config, runId);

    const resumeScript = completedResumeScript(runId);
    listRunsMock.mockResolvedValue({ items: [new FakeSdkRun(liveAgentId, resumeScript)] });

    const fake = new FakeAgentClient({
      runsByAgent: { [liveAgentId]: [resumeScript] },
      conversationText: null,
    });

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
      "events.jsonl": `${taskLaunchedEventLine(runId, liveAgentId)}\n`,
    });

    await runOrchestration(runId, fake, store);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.status).toBe("completed");
    expect(final.agents.t1.agent_id).toBe(liveAgentId);
    expect(final.agents.t1.status).toBe("finished");
    expect(fake.launches).toHaveLength(0);
  });

  it("reattaches from legacy task_launched detail when payload omits agent_id", async () => {
    const config = singleTaskConfig();
    const runId = "run-recover-legacy-events";
    const liveAgentId = "agent-legacy-events";
    const state = runningOrchestrationState(config, runId);

    const resumeScript = completedResumeScript(runId);
    listRunsMock.mockResolvedValue({ items: [new FakeSdkRun(liveAgentId, resumeScript)] });

    const fake = new FakeAgentClient({
      runsByAgent: { [liveAgentId]: [resumeScript] },
      conversationText: null,
    });

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
      "events.jsonl": `${taskLaunchedEventLine(runId, liveAgentId, { legacyPayload: true })}\n`,
    });

    await runOrchestration(runId, fake, store);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.status).toBe("completed");
    expect(final.agents.t1.agent_id).toBe(liveAgentId);
    expect(final.agents.t1.status).toBe("finished");
    expect(fake.launches).toHaveLength(0);
  });

  it("relaunches when event-recovered agent resumeCloudAgent throws", async () => {
    const config = singleTaskConfig();
    const runId = "run-recover-resume-throw";
    const deadAgentId = "agent-dead-resume-throw";
    const state = runningOrchestrationState(config, runId);

    const launchScript = completedResumeScript(runId);
    const fake = new FakeAgentClient({
      runsByAgent: { [deadAgentId]: [] },
      defaultScripts: [launchScript],
      conversationText: null,
    });
    vi.spyOn(fake, "resumeCloudAgent").mockRejectedValue(new Error("agent gone"));

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
      "events.jsonl": `${taskLaunchedEventLine(runId, deadAgentId, { runIdInPayload: "run-dead" })}\n`,
    });

    await runOrchestration(runId, fake, store);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.status).toBe("completed");
    expect(final.agents.t1.status).toBe("finished");
    expect(fake.launches).toHaveLength(1);
    expect(listRunsMock).not.toHaveBeenCalled();
  });

  it("relaunches when event-recovered agent has no SDK runs", async () => {
    const config = singleTaskConfig();
    const runId = "run-recover-dead-agent";
    const deadAgentId = "agent-dead-events";
    const branchName = `cursor-orch/${runId}/t1`;
    const state = runningOrchestrationState(config, runId, { branch_name: branchName });

    const launchScript = completedResumeScript(runId);
    listRunsMock.mockResolvedValue({ items: [] });

    const fake = new FakeAgentClient({
      runsByAgent: { [deadAgentId]: [] },
      defaultScripts: [launchScript],
      conversationText: null,
    });

    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "state.json": serialize(state),
      "events.jsonl": `${taskLaunchedEventLine(runId, deadAgentId, { runIdInPayload: "run-dead" })}\n`,
    });

    await runOrchestration(runId, fake, store);

    const final = JSON.parse(files.get("state.json")!);
    expect(final.status).toBe("completed");
    expect(final.agents.t1.status).toBe("finished");
    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]!.opts.startingRef).toBe(branchName);
    expect(final.agents.t1.branch_name).toBe(branchName);
  });

  it("marks the task failed when resumeCloudAgent throws", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-resume-fail";
    const liveAgentId = "agent-live-3";
    const state = runningOrchestrationState(config, runId, {
      agent_id: liveAgentId,
      status: "launching",
    });

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

describe("reattachWorkers blocked tasks", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => resetReattachTestEnv(listRunsMock));
  afterEach(() => restoreReattachTestEnv(originalEnv));

  it("does not re-run finished SDK streams for blocked tasks on resume", async () => {
    const config = singleTaskConfig();
    const runId = "run-reattach-blocked";
    const blockedAgentId = "blocked-agent-1";
    const state = runningOrchestrationState(config, runId, {
      agent_id: blockedAgentId,
      status: "blocked",
      blocked_reason: "needs clarification",
      blocked_since: new Date(Date.now() - 400_000).toISOString(),
      summary: "blocked",
    });

    listRunsMock.mockResolvedValue({
      items: [
        new FakeSdkRun(blockedAgentId, {
          events: [statusMessage("FINISHED")],
          result: { id: "stale-run", status: "finished" },
        }),
      ],
    });

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
        [blockedAgentId]: [
          {
            events: [statusMessage("FINISHED")],
            result: { id: "stale-run", status: "finished" },
          },
        ],
      },
      defaultScripts: [successScript],
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
    expect(listRunsMock).not.toHaveBeenCalled();
  });
});
