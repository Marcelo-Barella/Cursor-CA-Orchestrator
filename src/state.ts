import type { RepoStoreClient } from "./api/repo-store.js";
import type { OrchestratorConfig } from "./config/types.js";

export const MAX_EVENTS_BYTES = 256 * 1024;
export const ROTATE_KEEP_BYTES = 128 * 1024;

export interface AgentState {
  task_id: string;
  agent_id: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  pr_url: string | null;
  summary: string | null;
  blocked_reason: string | null;
  blocked_since: string | null;
  retry_count: number;
}

export interface LifecycleAgentState {
  node_id: string;
  label: string;
  kind: string;
  status: string;
  parent_node_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface OrchestrationState {
  orchestration_id: string;
  run_id: string;
  orchestrator_agent_id: string | null;
  status: string;
  started_at: string | null;
  delegation_phase_index: number | null;
  agents: Record<string, AgentState>;
  main_agent: LifecycleAgentState | null;
  phase_agents: Record<string, LifecycleAgentState>;
  task_phase_map: Record<string, string>;
  error: string | null;
}

export interface OrchestrationEvent {
  timestamp: string;
  event_type: string;
  task_id: string | null;
  phase_id: string | null;
  agent_node_id: string | null;
  agent_kind: string | null;
  detail: string;
  payload: Record<string, string>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultPhaseAgents(): Record<string, LifecycleAgentState> {
  return {
    planning: {
      node_id: "phase-planning",
      label: "Planning",
      kind: "phase",
      status: "pending",
      parent_node_id: "main-orchestrator",
      task_id: null,
      agent_id: null,
      started_at: null,
      finished_at: null,
    },
    scheduling: {
      node_id: "phase-scheduling",
      label: "Scheduling",
      kind: "phase",
      status: "pending",
      parent_node_id: "main-orchestrator",
      task_id: null,
      agent_id: null,
      started_at: null,
      finished_at: null,
    },
    execution: {
      node_id: "phase-execution",
      label: "Execution",
      kind: "phase",
      status: "pending",
      parent_node_id: "main-orchestrator",
      task_id: null,
      agent_id: null,
      started_at: null,
      finished_at: null,
    },
    finalization: {
      node_id: "phase-finalization",
      label: "Finalization",
      kind: "phase",
      status: "pending",
      parent_node_id: "main-orchestrator",
      task_id: null,
      agent_id: null,
      started_at: null,
      finished_at: null,
    },
  };
}

export function createInitialState(config: OrchestratorConfig, runId: string): OrchestrationState {
  const agents: Record<string, AgentState> = {};
  for (const task of config.tasks) {
    agents[task.id] = { task_id: task.id, agent_id: null, status: "pending", started_at: null, finished_at: null, pr_url: null, summary: null, blocked_reason: null, blocked_since: null, retry_count: 0 };
  }
  const state: OrchestrationState = {
    orchestration_id: runId,
    run_id: runId,
    orchestrator_agent_id: null,
    status: "pending",
    started_at: null,
    delegation_phase_index: null,
    agents,
    main_agent: null,
    phase_agents: {},
    task_phase_map: {},
    error: null,
  };
  ensureLifecycleAgents(state);
  return state;
}

export function ensureLifecycleAgents(state: OrchestrationState): void {
  if (state.main_agent === null) {
    state.main_agent = {
      node_id: "main-orchestrator",
      label: "Main Orchestrator",
      kind: "main",
      status: state.status,
      parent_node_id: null,
      task_id: null,
      agent_id: state.orchestrator_agent_id,
      started_at: state.started_at,
      finished_at: null,
    };
  } else {
    if (state.main_agent.agent_id === null && state.orchestrator_agent_id) {
      state.main_agent.agent_id = state.orchestrator_agent_id;
    }
    if (state.main_agent.started_at === null && state.started_at) {
      state.main_agent.started_at = state.started_at;
    }
  }
  if (Object.keys(state.phase_agents).length === 0) {
    state.phase_agents = defaultPhaseAgents();
  } else {
    const defaults = defaultPhaseAgents();
    for (const [phaseId, def] of Object.entries(defaults)) {
      if (!state.phase_agents[phaseId]) {
        state.phase_agents[phaseId] = def;
      }
    }
  }
}

export function seedMainAgent(
  state: OrchestrationState,
  opts: { agent_id: string | null; status: string; started_at?: string | null },
): void {
  ensureLifecycleAgents(state);
  state.orchestrator_agent_id = opts.agent_id;
  if (state.main_agent === null) return;
  state.main_agent.agent_id = opts.agent_id;
  state.main_agent.status = opts.status;
  if (opts.started_at) {
    state.main_agent.started_at = opts.started_at;
  } else if (state.main_agent.started_at === null) {
    state.main_agent.started_at = nowIso();
  }
}

export function setPhaseStatus(
  state: OrchestrationState,
  phaseId: string,
  status: string,
  opts?: { timestamp?: string | null },
): void {
  ensureLifecycleAgents(state);
  let phase = state.phase_agents[phaseId];
  if (!phase) {
    phase = {
      node_id: `phase-${phaseId}`,
      label: phaseId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      kind: "phase",
      status: "pending",
      parent_node_id: "main-orchestrator",
      task_id: null,
      agent_id: null,
      started_at: null,
      finished_at: null,
    };
    state.phase_agents[phaseId] = phase;
  }
  phase.status = status;
  const ts = opts?.timestamp ?? null;
  if ((status === "running" || status === "launching") && phase.started_at === null) {
    phase.started_at = ts ?? nowIso();
  }
  if (status === "finished" || status === "failed" || status === "stopped") {
    phase.finished_at = ts ?? nowIso();
  }
}

export function assignTaskPhase(state: OrchestrationState, taskId: string, phaseId: string): void {
  ensureLifecycleAgents(state);
  state.task_phase_map[taskId] = phaseId;
}

export function serialize(state: OrchestrationState): string {
  return JSON.stringify(state, null, 2);
}

function lifecycleFromDict(d: Record<string, unknown>, defaultNodeId: string, defaultLabel: string, defaultKind: string): LifecycleAgentState {
  return {
    node_id: (d.node_id as string) || defaultNodeId,
    label: (d.label as string) || defaultLabel,
    kind: (d.kind as string) || defaultKind,
    status: (d.status as string) || "pending",
    parent_node_id: (d.parent_node_id as string) ?? null,
    task_id: (d.task_id as string) ?? null,
    agent_id: (d.agent_id as string) ?? null,
    started_at: (d.started_at as string) ?? null,
    finished_at: (d.finished_at as string) ?? null,
  };
}

export function deserialize(jsonStr: string): OrchestrationState {
  const raw = JSON.parse(jsonStr) as Record<string, unknown>;
  if ("gist_id" in raw && !("run_id" in raw)) {
    raw.run_id = raw.gist_id;
    delete raw.gist_id;
  } else if ("gist_id" in raw) {
    delete raw.gist_id;
  }
  const agentsRaw = (raw.agents as Record<string, Record<string, unknown>>) || {};
  const agents: Record<string, AgentState> = {};
  for (const [k, v] of Object.entries(agentsRaw)) {
    agents[k] = v as unknown as AgentState;
  }
  const rawMain = raw.main_agent as Record<string, unknown> | null | undefined;
  const mainAgent =
    rawMain && typeof rawMain === "object"
      ? lifecycleFromDict(rawMain, "main-orchestrator", "Main Orchestrator", "main")
      : null;
  const phaseAgents: Record<string, LifecycleAgentState> = {};
  const phaseRaw = (raw.phase_agents as Record<string, Record<string, unknown>>) || {};
  for (const [phaseId, phaseData] of Object.entries(phaseRaw)) {
    if (typeof phaseData !== "object" || !phaseData) continue;
    const defaultNodeId = `phase-${phaseId}`;
    const defaultLabel = phaseId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    phaseAgents[phaseId] = lifecycleFromDict(phaseData, defaultNodeId, defaultLabel, "phase");
  }
  const taskPhaseMap: Record<string, string> = {};
  const tpm = (raw.task_phase_map as Record<string, string>) || {};
  for (const [a, b] of Object.entries(tpm)) {
    taskPhaseMap[String(a)] = String(b);
  }
  const state: OrchestrationState = {
    orchestration_id: String(raw.orchestration_id ?? ""),
    run_id: String(raw.run_id ?? ""),
    orchestrator_agent_id: (raw.orchestrator_agent_id as string) ?? null,
    status: String(raw.status ?? "pending"),
    started_at: (raw.started_at as string) ?? null,
    delegation_phase_index: typeof raw.delegation_phase_index === "number" ? raw.delegation_phase_index : null,
    agents,
    main_agent: mainAgent,
    phase_agents: phaseAgents,
    task_phase_map: taskPhaseMap,
    error: (raw.error as string) ?? null,
  };
  ensureLifecycleAgents(state);
  return state;
}

export function serializeEvent(event: OrchestrationEvent): string {
  return JSON.stringify(event);
}

export function deserializeEvent(jsonStr: string): OrchestrationEvent {
  return JSON.parse(jsonStr) as OrchestrationEvent;
}

export async function syncToRepo(repoStore: RepoStoreClient, runId: string, state: OrchestrationState): Promise<void> {
  await repoStore.writeFile(runId, "state.json", serialize(state));
}

export async function syncFromRepo(repoStore: RepoStoreClient, runId: string): Promise<OrchestrationState> {
  const content = await repoStore.readFile(runId, "state.json");
  return deserialize(content);
}

export async function appendEvent(repoStore: RepoStoreClient, runId: string, event: OrchestrationEvent): Promise<void> {
  const line = serializeEvent(event);
  await repoStore.updateFile(runId, "events.jsonl", (current) => {
    const nextContent = current ? `${current}${line}\n` : `${line}\n`;
    return rotateEvents(nextContent);
  });
}

function rotateEvents(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_EVENTS_BYTES) {
    return content;
  }
  const encoded = Buffer.from(content, "utf8");
  const tail = encoded.subarray(Math.max(0, encoded.length - ROTATE_KEEP_BYTES));
  let text = tail.toString("utf8");
  const firstNl = text.indexOf("\n");
  if (firstNl >= 0) {
    return text.slice(firstNl + 1);
  }
  return text;
}

export async function readEvents(repoStore: RepoStoreClient, runId: string): Promise<OrchestrationEvent[]> {
  const content = await repoStore.readFile(runId, "events.jsonl");
  if (!content.trim()) return [];
  const events: OrchestrationEvent[] = [];
  for (const line of content.trim().split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    try {
      events.push(deserializeEvent(stripped));
    } catch {
      continue;
    }
  }
  return events;
}
