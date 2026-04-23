import type { AgentState, OrchestrationState } from "../state.js";

const UPSTREAM_FAILURE_SUMMARY = /^Upstream task ([^\s]+) failed$/;

export function inferCascadeSourceTaskId(agent: AgentState): string | null {
  if (agent.cascade_source_task_id) {
    return agent.cascade_source_task_id;
  }
  const s = agent.summary;
  if (!s) return null;
  const m = UPSTREAM_FAILURE_SUMMARY.exec(s);
  return m?.[1] ?? null;
}

export function isFailedDueToCascade(agent: AgentState): boolean {
  if (agent.cascade_source_task_id) {
    return true;
  }
  if (agent.status !== "failed") return false;
  const s = agent.summary;
  return s !== null && UPSTREAM_FAILURE_SUMMARY.test(s);
}

export type RootFailedTask = { taskId: string; agent: AgentState };
export type CascadedFailedTask = { taskId: string; sourceTaskId: string };

export function partitionFailedAgents(agents: Record<string, AgentState>): {
  roots: RootFailedTask[];
  cascaded: CascadedFailedTask[];
} {
  const roots: RootFailedTask[] = [];
  const cascaded: CascadedFailedTask[] = [];
  for (const [taskId, agent] of Object.entries(agents)) {
    if (agent.status !== "failed") continue;
    if (isFailedDueToCascade(agent)) {
      const sourceTaskId = inferCascadeSourceTaskId(agent);
      if (sourceTaskId) {
        cascaded.push({ taskId, sourceTaskId });
      } else {
        roots.push({ taskId, agent });
      }
    } else {
      roots.push({ taskId, agent });
    }
  }
  return { roots, cascaded };
}

export function formatFailureLogHint(runId: string, firstRootTaskId: string): string {
  return `cursor-orch logs --run ${runId} --task ${firstRootTaskId}`;
}

export function hasAnyFailedAgent(agents: Record<string, AgentState>): boolean {
  return Object.values(agents).some((a) => a.status === "failed");
}

export function stateNeedsFailureNarration(state: OrchestrationState): boolean {
  if (state.status === "failed") return true;
  return hasAnyFailedAgent(state.agents);
}

export function buildFailureDiagnosisLines(
  state: OrchestrationState,
  runId: string,
): string[] | null {
  const { roots, cascaded } = partitionFailedAgents(state.agents);
  if (roots.length === 0 && cascaded.length === 0) {
    return null;
  }
  const out: string[] = [];
  if (roots.length) {
    out.push(`Root task(s) (fix these first): ${roots.map((r) => r.taskId).join(", ")}`);
    for (const r of roots) {
      const s = r.agent.summary;
      if (s) {
        const t = s.length > 400 ? `${s.slice(0, 400)}...` : s;
        out.push(`  ${r.taskId}: ${t}`);
      }
    }
  }
  if (cascaded.length) {
    out.push(
      `Cascaded (upstream failure, ${cascaded.length}): ${cascaded.map((c) => c.taskId).join(", ")}`,
    );
  }
  for (const r of roots) {
    out.push(`Transcript: ${formatFailureLogHint(runId, r.taskId)}`);
  }
  return out;
}
