import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "../src/config/types.js";
import { appendEvent, createInitialState, deserialize, serialize } from "../src/state.js";

describe("state", () => {
  it("roundtrip serialize", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: {},
      tasks: [
        {
          id: "a",
          repo: "r",
          prompt: "p",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
      ],
      target: { auto_create_pr: true, branch_prefix: "x" },
      bootstrap_repo_name: "b",
    };
    const state = createInitialState(config, "run1");
    const s = serialize(state);
    const back = deserialize(s);
    expect(back.run_id).toBe("run1");
    expect(back.agents.a).toBeDefined();
  });

  it("appends events onto the latest repo content", async () => {
    const files: Record<string, string> = {
      "run1/events.jsonl": `${JSON.stringify({
        timestamp: "2026-03-27T00:00:00.000Z",
        event_type: "orchestration_started",
        task_id: null,
        phase_id: null,
        agent_node_id: "main-orchestrator",
        agent_kind: "main",
        detail: "start",
        payload: {},
      })}\n`,
    };
    const repoStore = {
      async updateFile(runId: string, filename: string, updater: (current: string) => string | Promise<string>): Promise<void> {
        const key = `${runId}/${filename}`;
        files[key] = await updater(files[key] ?? "");
      },
    };

    await appendEvent(repoStore as never, "run1", {
      timestamp: "2026-03-27T00:00:01.000Z",
      event_type: "task_finished",
      task_id: "a",
      phase_id: "execution",
      agent_node_id: "a",
      agent_kind: "task",
      detail: "done",
      payload: {},
    });

    expect(files["run1/events.jsonl"]!.trim().split("\n")).toHaveLength(2);
    expect(files["run1/events.jsonl"]).toContain('"event_type":"task_finished"');
  });
});
