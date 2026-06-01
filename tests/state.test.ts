import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "../src/config/types.js";
import { appendEvent, createInitialState, deserialize, MAX_EVENTS_BYTES, readEvents, serialize } from "../src/state.js";

describe("state", () => {
  it("roundtrip serialize", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: { id: "m" },
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "x", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const state = createInitialState(config, "run1");
    const s = serialize(state);
    const back = deserialize(s);
    expect(back.run_id).toBe("run1");
    expect(back.agents.a).toBeDefined();
    expect(back.agents.a!.cascade_source_task_id).toBeNull();
    expect(back.agents.a!.blocked_retry_count).toBe(0);
  });

  it("deserialize defaults blocked_retry_count to 0 when absent", () => {
    const raw = JSON.stringify({
      orchestration_id: "run1",
      run_id: "run1",
      orchestrator_agent_id: null,
      status: "running",
      started_at: null,
      delegation_phase_index: null,
      agents: {
        a: {
          task_id: "a",
          agent_id: "agent-1",
          status: "blocked",
          started_at: null,
          finished_at: null,
          branch_name: null,
          pr_url: null,
          summary: null,
          blocked_reason: "stuck",
          blocked_since: "2026-05-28T00:00:00.000Z",
          retry_count: 2,
        },
      },
      main_agent: null,
      phase_agents: {},
      task_phase_map: {},
      error: null,
    });
    const back = deserialize(raw);
    expect(back.agents.a!.retry_count).toBe(2);
    expect(back.agents.a!.blocked_retry_count).toBe(0);
  });

  it("roundtrip preserves blocked_retry_count separately from retry_count", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: { id: "m" },
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "x", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const state = createInitialState(config, "run1");
    state.agents.a!.retry_count = 1;
    state.agents.a!.blocked_retry_count = 2;
    const back = deserialize(serialize(state));
    expect(back.agents.a!.retry_count).toBe(1);
    expect(back.agents.a!.blocked_retry_count).toBe(2);
  });

  it("roundtrip preserves delegation phase and group cursors", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: { id: "m" },
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
      target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "x", branch_layout: "consolidated" },
      bootstrap_repo_name: "b",
    };
    const state = createInitialState(config, "run1");
    state.delegation_phase_index = 2;
    state.delegation_group_index = 1;
    const back = deserialize(serialize(state));
    expect(back.delegation_phase_index).toBe(2);
    expect(back.delegation_group_index).toBe(1);
  });

  it("deserialize defaults missing delegation_group_index to null", () => {
    const raw = JSON.stringify({
      orchestration_id: "run1",
      run_id: "run1",
      orchestrator_agent_id: null,
      status: "pending",
      started_at: null,
      delegation_phase_index: 0,
      agents: {},
      main_agent: null,
      phase_agents: {},
      task_phase_map: {},
      error: null,
    });
    const back = deserialize(raw);
    expect(back.delegation_group_index).toBeNull();
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

  it("rotates events.jsonl when append would exceed MAX_EVENTS_BYTES", async () => {
    const filler = "x".repeat(512);
    const mkLine = (n: number) =>
      `${JSON.stringify({
        timestamp: "2026-03-27T00:00:00.000Z",
        event_type: "worker_status",
        task_id: "a",
        phase_id: null,
        agent_node_id: "a",
        agent_kind: "task",
        detail: `event-${n}-${filler}`,
        payload: {},
      })}\n`;
    let content = "";
    while (Buffer.byteLength(content, "utf8") < MAX_EVENTS_BYTES - 1024) {
      content += mkLine(content.length);
    }
    const files: Record<string, string> = { "run1/events.jsonl": content };
    const repoStore = {
      async updateFile(runId: string, filename: string, updater: (current: string) => string | Promise<string>): Promise<void> {
        const key = `${runId}/${filename}`;
        files[key] = await updater(files[key] ?? "");
      },
      async readFile(runId: string, filename: string): Promise<string> {
        return files[`${runId}/${filename}`] ?? "";
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

    const rotated = files["run1/events.jsonl"]!;
    expect(Buffer.byteLength(rotated, "utf8")).toBeLessThanOrEqual(MAX_EVENTS_BYTES);
    expect(rotated).toContain('"event_type":"task_finished"');
    const lines = rotated.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(() => JSON.parse(lines[lines.length - 1]!)).not.toThrow();
  });

  it("readEvents skips corrupt jsonl lines and parses valid ones", async () => {
    const valid = {
      timestamp: "2026-03-27T00:00:00.000Z",
      event_type: "task_finished",
      task_id: "a",
      phase_id: null,
      agent_node_id: "a",
      agent_kind: "task",
      detail: "done",
      payload: {},
    };
    const repoStore = {
      async readFile(_runId: string, filename: string): Promise<string> {
        if (filename !== "events.jsonl") return "";
        return `${JSON.stringify(valid)}\n{not-json\n${JSON.stringify({ ...valid, task_id: "b", detail: "also ok" })}\n`;
      },
    };
    const events = await readEvents(repoStore as never, "run1");
    expect(events).toHaveLength(2);
    expect(events[0]!.task_id).toBe("a");
    expect(events[1]!.task_id).toBe("b");
  });
});
