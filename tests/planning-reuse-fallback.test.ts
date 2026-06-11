import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import { FakeAgentClient, statusMessage } from "./support/fake-agent-client.js";
import {
  createInMemoryRepoStore,
  installGithubBranchPrepMock,
  promptOnlyConfig,
  restoreGithubBranchPrepMock,
} from "./support/reattach-fixtures.js";
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
    restoreGithubBranchPrepMock();
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
