import { describe, expect, it } from "vitest";
import {
  buildFailureDiagnosisLines,
  inferCascadeSourceTaskId,
  isFailedDueToCascade,
  partitionFailedAgents,
} from "../src/lib/failure-diagnostics.js";
import type { AgentState, OrchestrationState } from "../src/state.js";

function baseAgent(over: Partial<AgentState>): AgentState {
  return {
    task_id: "x",
    agent_id: null,
    status: "pending",
    started_at: null,
    finished_at: null,
    branch_name: null,
    pr_url: null,
    summary: null,
    blocked_reason: null,
    blocked_since: null,
    retry_count: 0,
    cascade_source_task_id: null,
    ...over,
  };
}

function shellState(agents: Record<string, AgentState>): OrchestrationState {
  return {
    orchestration_id: "r1",
    run_id: "r1",
    orchestrator_agent_id: null,
    status: "failed",
    started_at: null,
    delegation_phase_index: null,
    delegation_group_index: null,
    agents,
    main_agent: null,
    phase_agents: {},
    task_phase_map: {},
    error: null,
    consolidated_pr_urls: null,
    consolidated_pr_errors: null,
    repo_run_head: null,
  };
}

describe("failure-diagnostics", () => {
  it("treats explicit cascade_source_task_id as cascade", () => {
    const a = baseAgent({ task_id: "a", status: "failed", summary: "Worker error", cascade_source_task_id: null });
    const b = baseAgent({
      task_id: "b",
      status: "failed",
      summary: "Upstream task a failed",
      cascade_source_task_id: "a",
    });
    expect(isFailedDueToCascade(b)).toBe(true);
    expect(inferCascadeSourceTaskId(b)).toBe("a");
    const { roots, cascaded } = partitionFailedAgents({ a, b });
    expect(roots.map((r) => r.taskId).sort()).toEqual(["a"]);
    expect(cascaded).toEqual([{ taskId: "b", sourceTaskId: "a" }]);
  });

  it("infers cascade from summary when field missing (legacy state)", () => {
    const b = baseAgent({ task_id: "b", status: "failed", summary: "Upstream task a failed", cascade_source_task_id: null });
    expect(isFailedDueToCascade(b)).toBe(true);
    expect(inferCascadeSourceTaskId(b)).toBe("a");
  });

  it("buildFailureDiagnosisLines includes roots cascaded and log hints", () => {
    const a = baseAgent({ task_id: "a", status: "failed", summary: "tool timed out" });
    const b = baseAgent({
      task_id: "b",
      status: "failed",
      summary: "Upstream task a failed",
      cascade_source_task_id: "a",
    });
    const state = shellState({ a, b });
    const lines = buildFailureDiagnosisLines(state, "run-z");
    expect(lines).toBeTruthy();
    expect(lines!.some((l) => l.includes("Root task(s)") && l.includes("a"))).toBe(true);
    expect(lines!.some((l) => l.includes("Cascaded") && l.includes("b"))).toBe(true);
    expect(lines!.some((l) => l.includes("cursor-orch logs --run run-z --task a"))).toBe(true);
  });
});
