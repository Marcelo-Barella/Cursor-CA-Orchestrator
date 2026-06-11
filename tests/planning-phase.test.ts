import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import { FakeAgentClient, statusMessage } from "./support/fake-agent-client.js";
import {
  completedWorkerScript,
  createInMemoryRepoStore,
  installGithubBranchPrepMock,
  parseEvents,
  promptOnlyConfig,
  restoreGithubBranchPrepMock,
  validTaskPlanJson,
} from "./support/reattach-fixtures.js";

const waitForPlanMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/planner.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/planner.js")>();
  return {
    ...mod,
    waitForPlan: waitForPlanMock,
  };
});

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

describe("planning phase", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CURSOR_API_KEY = "sk-fake";
    process.env.GH_TOKEN = "ghp-fake";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "0";
    delete process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS;
    delete process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES;
    installGithubBranchPrepMock();
    waitForPlanMock.mockReset();
    listRunsMock.mockReset();
  });

  afterEach(() => {
    restoreGithubBranchPrepMock();
    process.env = { ...originalEnv };
  });

  it("falls back to planner listRuns result when task-plan.json never appears", async () => {
    const config = promptOnlyConfig();
    const taskPlan = validTaskPlanJson();
    waitForPlanMock.mockResolvedValue(null);
    listRunsMock.mockResolvedValue({ items: [{ result: taskPlan }] });
    const fake = new FakeAgentClient({
      defaultScripts: [
        { events: [statusMessage("FINISHED")], result: { id: "r-plan", status: "finished", result: "" } },
        completedWorkerScript("t1", "run-listruns-fallback"),
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-listruns-fallback", fake, store);
    expect(listRunsMock).toHaveBeenCalled();
    expect(fake.launches).toHaveLength(2);
    expect(JSON.parse(files.get("state.json")!).status).toBe("completed");
  });

  it("reports planning timeout when listRuns fails after task-plan poll misses", async () => {
    const config = promptOnlyConfig();
    waitForPlanMock.mockResolvedValue(null);
    listRunsMock.mockRejectedValue(new Error("sdk listRuns down"));
    const fake = new FakeAgentClient({
      defaultScripts: [{ events: [statusMessage("FINISHED")], result: { id: "r-plan", status: "finished", result: "" } }],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await expect(runOrchestration("run-listruns-fail", fake, store)).rejects.toThrow(/Timed out waiting for task plan/);
    expect(files.get("state.json")).toBeTruthy();
    const events = parseEvents(files);
    expect(events.some((e) => e.event_type === "planning_failed")).toBe(true);
  });

  it("records planning_failed for invalid reused task-plan without launching planner", async () => {
    const config = promptOnlyConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [completedWorkerScript("t1", "run-bad-reuse")],
    });
    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "task-plan.json": "{not-valid-json",
    });
    await expect(runOrchestration("run-bad-reuse", fake, store)).rejects.toThrow();
    expect(fake.launches).toHaveLength(0);
    const events = parseEvents(files);
    expect(events.some((e) => e.event_type === "planning_failed")).toBe(true);
  });

  it("emits planning_started for fresh planning but not when reusing task-plan.json", async () => {
    const config = promptOnlyConfig();
    const taskPlan = validTaskPlanJson();

    waitForPlanMock.mockResolvedValue(taskPlan);
    const freshFake = new FakeAgentClient({
      defaultScripts: [
        { events: [statusMessage("FINISHED")], result: { id: "r-plan", status: "finished", result: "" } },
        completedWorkerScript("t1", "run-fresh-plan"),
      ],
    });
    const fresh = createInMemoryRepoStore({ "config.yaml": toYaml(config) });
    await runOrchestration("run-fresh-plan", freshFake, fresh.store);
    const freshEvents = parseEvents(fresh.files);
    expect(freshEvents.some((e) => e.event_type === "planning_started")).toBe(true);

    waitForPlanMock.mockClear();
    const reuseFake = new FakeAgentClient({
      defaultScripts: [completedWorkerScript("t1", "run-reuse-plan-events")],
    });
    const reuse = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "task-plan.json": taskPlan,
    });
    await runOrchestration("run-reuse-plan-events", reuseFake, reuse.store);
    const reuseEvents = parseEvents(reuse.files);
    expect(reuseEvents.some((e) => e.event_type === "planning_started")).toBe(false);
    expect(waitForPlanMock).not.toHaveBeenCalled();
  });

  it("fails planning when reused plan violates prompt constraints", async () => {
    const config = {
      ...promptOnlyConfig(),
      prompt: "Every route must use your translation method.",
    };
    const taskPlan = JSON.stringify({
      tasks: [
        {
          id: "t1",
          repo: "svc",
          prompt: "Do unrelated work.",
          depends_on: [],
          timeout_minutes: 30,
        },
      ],
    });
    const fake = new FakeAgentClient();
    const { store, files } = createInMemoryRepoStore({
      "config.yaml": toYaml(config),
      "task-plan.json": taskPlan,
    });
    await expect(runOrchestration("run-constraint-reuse", fake, store)).rejects.toThrow(/Plan constraint validation failed/);
    expect(fake.launches).toHaveLength(0);
    const events = parseEvents(files);
    expect(
      events.some((e) => e.event_type === "planning_failed" && e.detail?.includes("Plan constraint validation failed")),
    ).toBe(true);
  });
});
