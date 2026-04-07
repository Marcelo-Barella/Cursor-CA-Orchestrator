import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CursorClient, type AgentInfo } from "./api/cursor-client.js";
import { RepoStoreClient } from "./api/repo-store.js";
import type { OrchestratorConfig, TaskConfig } from "./config/types.js";
import { canonicalizeOrchestratorConfig } from "./config/canonicalize.js";
import { parseConfig, toYaml } from "./config/parse.js";
import { validateConfig } from "./config/validate.js";
import { buildPlannerPrompt, parseTaskPlan, waitForPlan } from "./planner.js";
import { buildRepoCreationPrompt, buildWorkerPrompt } from "./prompt-builder.js";
import {
  type AgentState,
  type OrchestrationEvent,
  type OrchestrationState,
  appendEvent,
  assignTaskPhase,
  createInitialState,
  ensureLifecycleAgents,
  seedMainAgent,
  setPhaseStatus,
  syncFromRepo,
  syncToRepo,
} from "./state.js";
import {
  consolidateOneRepo,
  groupKeyForRepo,
  integrationBranchName,
  topoSortTaskGroup,
} from "./lib/github-consolidated-pr.js";
import { parseGithubOwnerRepo, resolveRepoTarget } from "./lib/repo-target.js";

const POLL_INTERVAL = 30;
const BLOCKED_TIMEOUT_SECONDS = 300;
const MAX_RETRY_COUNT = 1;
const MAX_WORKER_OUTPUT_BYTES = 512 * 1024;
const MAX_SUMMARY_BYTES = 4096;
const MAX_OUTPUTS_BYTES = 256 * 1024;
const RAW_TAIL_BYTES = 8192;

function nowIso(): string {
  return new Date().toISOString();
}

export function buildDependencyGraph(tasks: TaskConfig[]): Record<string, Set<string>> {
  return Object.fromEntries(tasks.map((t) => [t.id, new Set(t.depends_on)]));
}

export function getReadyTasks(graph: Record<string, Set<string>>, agents: Record<string, AgentState>): string[] {
  return Object.entries(graph)
    .filter(([taskId, deps]) => {
      const agent = agents[taskId];
      if (!agent || agent.status !== "pending") return false;
      return [...deps].every((d) => agents[d]?.status === "finished");
    })
    .map(([taskId]) => taskId);
}

type DelegationGroup = {
  id: string;
  task_ids: string[];
};

type DelegationPhase = {
  id: string;
  groups: DelegationGroup[];
};

function toTaskIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id) continue;
    out.push(id);
  }
  return out;
}

function extractDelegationPhases(config: OrchestratorConfig, knownTaskIds: Set<string>): DelegationPhase[] | null {
  if (config.delegation_map && Array.isArray(config.delegation_map.phases) && config.delegation_map.phases.length > 0) {
    const phases: DelegationPhase[] = [];
    for (const [index, phase] of config.delegation_map.phases.entries()) {
      const groups: DelegationGroup[] = [];
      for (const [gi, group] of phase.groups.entries()) {
        const task_ids = group.task_ids.filter((taskId) => knownTaskIds.has(taskId));
        if (task_ids.length === 0) continue;
        const groupId = group.id?.trim() ? group.id : `group-${gi + 1}`;
        groups.push({ id: groupId, task_ids });
      }
      if (groups.length === 0) continue;
      const phaseId = phase.id || `phase-${index + 1}`;
      phases.push({ id: phaseId, groups });
    }
    if (phases.length > 0) {
      return phases;
    }
  }
  const rawConfig = config as unknown as {
    delegation_map?: unknown;
    delegationMap?: unknown;
  };
  const rawMap = rawConfig.delegation_map ?? rawConfig.delegationMap;
  if (typeof rawMap !== "object" || rawMap === null) return null;
  const mapObj = rawMap as {
    phases?: unknown;
    waves?: unknown;
  };
  const rawPhases = Array.isArray(mapObj.phases) ? mapObj.phases : Array.isArray(mapObj.waves) ? mapObj.waves : null;
  if (!rawPhases) return null;
  const phases: DelegationPhase[] = [];
  for (let index = 0; index < rawPhases.length; index += 1) {
    const phaseEntry = rawPhases[index];
    if (typeof phaseEntry !== "object" || phaseEntry === null) continue;
    const phaseObj = phaseEntry as {
      id?: unknown;
      phase_id?: unknown;
      name?: unknown;
      tasks?: unknown;
      parallel_groups?: unknown;
      parallelGroups?: unknown;
      groups?: unknown;
    };
    const ids = new Set<string>();
    for (const taskId of toTaskIdList(phaseObj.tasks)) {
      if (knownTaskIds.has(taskId)) ids.add(taskId);
    }
    const rawGroups = Array.isArray(phaseObj.parallel_groups)
      ? phaseObj.parallel_groups
      : Array.isArray(phaseObj.parallelGroups)
        ? phaseObj.parallelGroups
        : Array.isArray(phaseObj.groups)
          ? phaseObj.groups
          : [];
    for (const groupEntry of rawGroups) {
      if (typeof groupEntry !== "object" || groupEntry === null) continue;
      const groupObj = groupEntry as { task_ids?: unknown; taskIds?: unknown; tasks?: unknown };
      for (const taskId of toTaskIdList(groupObj.task_ids ?? groupObj.taskIds ?? groupObj.tasks)) {
        if (knownTaskIds.has(taskId)) ids.add(taskId);
      }
    }
    if (ids.size === 0) continue;
    const rawId = phaseObj.id ?? phaseObj.phase_id ?? phaseObj.name;
    const phaseId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : `phase-${index + 1}`;
    phases.push({ id: phaseId, groups: [{ id: "group-1", task_ids: [...ids] }] });
  }
  if (phases.length === 0) return null;
  return phases;
}

function isTerminalStatus(status: string): boolean {
  return status === "finished" || status === "failed" || status === "stopped";
}

function groupIsTerminal(state: OrchestrationState, group: DelegationGroup): boolean {
  return group.task_ids.every((taskId) => isTerminalStatus(state.agents[taskId]?.status ?? "finished"));
}

function normalizeDelegationCursors(state: OrchestrationState, phases: DelegationPhase[]): { phaseIndex: number; groupIndex: number } {
  let p = state.delegation_phase_index ?? 0;
  let g = state.delegation_group_index ?? 0;
  if (p < 0) p = 0;
  if (g < 0) g = 0;
  while (p < phases.length) {
    const phase = phases[p]!;
    const groups = phase.groups;
    if (g > groups.length) g = groups.length;
    while (g > 0 && !groupIsTerminal(state, groups[g - 1]!)) {
      g -= 1;
    }
    while (g < groups.length && groupIsTerminal(state, groups[g]!)) {
      g += 1;
    }
    if (g >= groups.length) {
      p += 1;
      g = 0;
      continue;
    }
    break;
  }
  return { phaseIndex: p, groupIndex: g };
}

function buildDelegationTaskIndex(phases: DelegationPhase[]): {
  mappedTaskIds: Set<string>;
  taskLocation: Map<string, { phaseIndex: number; groupIndex: number }>;
} {
  const mappedTaskIds = new Set<string>();
  const taskLocation = new Map<string, { phaseIndex: number; groupIndex: number }>();
  for (let pi = 0; pi < phases.length; pi += 1) {
    const phase = phases[pi]!;
    for (let gi = 0; gi < phase.groups.length; gi += 1) {
      const group = phase.groups[gi]!;
      for (const taskId of group.task_ids) {
        mappedTaskIds.add(taskId);
        taskLocation.set(taskId, { phaseIndex: pi, groupIndex: gi });
      }
    }
  }
  return { mappedTaskIds, taskLocation };
}

export function filterEligibleReadyTasks(state: OrchestrationState, config: OrchestratorConfig, readyTasks: string[]): string[] {
  const phases = extractDelegationPhases(config, new Set(Object.keys(state.agents)));
  if (!phases) return readyTasks;
  const { mappedTaskIds, taskLocation } = buildDelegationTaskIndex(phases);
  const { phaseIndex, groupIndex } = normalizeDelegationCursors(state, phases);
  state.delegation_phase_index = phaseIndex;
  state.delegation_group_index = groupIndex;
  if (phaseIndex >= phases.length) {
    return readyTasks.filter((taskId) => !mappedTaskIds.has(taskId));
  }
  return readyTasks.filter((taskId) => {
    const loc = taskLocation.get(taskId);
    if (!loc) return false;
    return loc.phaseIndex === phaseIndex && loc.groupIndex === groupIndex;
  });
}

export function getBlockedTasks(agents: Record<string, AgentState>): AgentState[] {
  return Object.values(agents).filter((a) => a.status === "blocked");
}

export function computeBranchName(branchPrefix: string, runId: string, taskId: string, retryCount: number): string {
  const base = `${branchPrefix}/${runId}/${taskId}`;
  if (retryCount > 0) {
    return `${base}-retry-${retryCount}`;
  }
  return base;
}

function makeEvent(
  eventType: string,
  detail: string,
  taskId: string | null = null,
  opts?: {
    phase_id?: string | null;
    agent_node_id?: string | null;
    agent_kind?: string | null;
    payload?: Record<string, string>;
  },
): OrchestrationEvent {
  return {
    timestamp: nowIso(),
    event_type: eventType,
    task_id: taskId,
    phase_id: opts?.phase_id ?? null,
    agent_node_id: opts?.agent_node_id ?? null,
    agent_kind: opts?.agent_kind ?? null,
    detail,
    payload: opts?.payload ?? {},
  };
}

async function readWorkerOutput(repoStore: RepoStoreClient, runId: string, taskId: string): Promise<Record<string, unknown> | null> {
  const content = await repoStore.readFile(runId, `agent-${taskId}.json`);
  if (!content) return null;
  if (Buffer.byteLength(content, "utf8") > MAX_WORKER_OUTPUT_BYTES) {
    console.warn(`Worker output for ${taskId} exceeds 512KB, truncating`);
  }
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    return truncateOutput(data, taskId);
  } catch {
    const tail = content.length > RAW_TAIL_BYTES ? content.slice(-RAW_TAIL_BYTES) : content;
    return { task_id: taskId, status: "completed", truncated: true, raw_tail: tail };
  }
}

function truncateOutput(data: Record<string, unknown>, taskId: string): Record<string, unknown> {
  truncateSummary(data, taskId);
  truncateOutputs(data, taskId);
  return data;
}

function truncateSummary(data: Record<string, unknown>, taskId: string): void {
  const summary = data.summary;
  if (typeof summary !== "string") return;
  if (Buffer.byteLength(summary, "utf8") <= MAX_SUMMARY_BYTES) return;
  console.warn(`Worker output summary for ${taskId} exceeds 4KB, truncating`);
  data.summary = summary.slice(0, MAX_SUMMARY_BYTES) + "\n[TRUNCATED]";
}

function truncateOutputs(data: Record<string, unknown>, taskId: string): void {
  const outputs = data.outputs;
  if (typeof outputs !== "object" || outputs === null) return;
  const o = outputs as Record<string, unknown>;
  let serializedLen = Buffer.byteLength(JSON.stringify(o), "utf8");
  if (serializedLen <= MAX_OUTPUTS_BYTES) return;
  console.warn(`Worker outputs for ${taskId} exceed 256KB (${serializedLen} bytes), truncating`);
  shrinkOutputs(o);
  data.truncated = true;
}

function shrinkOutputs(outputs: Record<string, unknown>): void {
  while (Buffer.byteLength(JSON.stringify(outputs), "utf8") > MAX_OUTPUTS_BYTES && Object.keys(outputs).length > 0) {
    const largestKey = Object.keys(outputs).reduce((a, b) =>
      Buffer.byteLength(JSON.stringify(outputs[a]), "utf8") >= Buffer.byteLength(JSON.stringify(outputs[b]), "utf8") ? a : b,
    );
    const val = JSON.stringify(outputs[largestKey]);
    const tail = val.length > 32768 ? val.slice(-32768) : val;
    outputs[largestKey] = `[TRUNCATED]\n${tail}`;
    if (Buffer.byteLength(JSON.stringify(outputs), "utf8") <= MAX_OUTPUTS_BYTES) break;
  }
}

function buildSummaryMd(config: OrchestratorConfig, state: OrchestrationState): string {
  const finished = Object.values(state.agents).filter((a) => a.status === "finished").length;
  const total = Object.keys(state.agents).length;
  const lines = [
    `# ${config.name}`,
    `**Status:** ${state.status} | **Progress:** ${finished}/${total} tasks`,
    "",
    "| Task | Repo | Status | PR |",
    "|------|------|--------|----|",
  ];
  const taskMap = Object.fromEntries(config.tasks.map((t) => [t.id, t]));
  const perTaskPr = config.target.consolidate_prs && config.target.auto_create_pr ? "--" : null;
  for (const [taskId, agent] of Object.entries(state.agents)) {
    const task = taskMap[taskId];
    const repo = task ? task.repo : "?";
    const pr = perTaskPr !== null ? perTaskPr : agent.pr_url ?? "--";
    lines.push(`| ${taskId} | ${repo} | ${agent.status} | ${pr} |`);
  }
  if (state.consolidated_pr_urls && Object.keys(state.consolidated_pr_urls).length > 0) {
    lines.push("", "## Consolidated pull requests", "");
    for (const [k, url] of Object.entries(state.consolidated_pr_urls)) {
      lines.push(`- ${k.split("\0").join(" @ ")}: ${url}`);
    }
  }
  if (state.consolidated_pr_errors && Object.keys(state.consolidated_pr_errors).length > 0) {
    lines.push("", "## Consolidated PR errors", "");
    for (const [k, err] of Object.entries(state.consolidated_pr_errors)) {
      lines.push(`- ${k.split("\0").join(" @ ")}: ${err}`);
    }
  }
  return lines.join("\n");
}

async function cascadeFailures(
  state: OrchestrationState,
  failedTaskId: string,
  graph: Record<string, Set<string>>,
  repoStore: RepoStoreClient,
  runId: string,
): Promise<string[]> {
  const cascaded: string[] = [];
  for (const [taskId, deps] of Object.entries(graph)) {
    if (!deps.has(failedTaskId)) continue;
    const agent = state.agents[taskId];
    if (!agent || (agent.status !== "pending" && agent.status !== "blocked")) continue;
    agent.status = "failed";
    agent.summary = `Upstream task ${failedTaskId} failed`;
    cascaded.push(taskId);
    await appendEvent(repoStore, runId, makeEvent("task_failed", `Task ${taskId} failed: upstream ${failedTaskId} failed`, taskId));
  }
  return cascaded;
}

async function pollSingleAgent(
  taskId: string,
  agent: AgentState,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
  state: OrchestrationState,
  config: OrchestratorConfig,
): Promise<void> {
  if ((agent.status !== "running" && agent.status !== "launching") || !agent.agent_id) {
    return;
  }
  let info: AgentInfo;
  try {
    info = await cursorClient.getAgent(agent.agent_id);
  } catch {
    console.error(`Failed to poll agent ${agent.agent_id} for task ${taskId}`);
    return;
  }
  await updateAgentFromPoll(taskId, agent, info, repoStore, runId, state, config);
}

async function updateAgentFromPoll(
  taskId: string,
  agent: AgentState,
  info: AgentInfo,
  repoStore: RepoStoreClient,
  runId: string,
  state: OrchestrationState,
  config: OrchestratorConfig,
): Promise<void> {
  const st = info.status.toUpperCase();
  if (st === "FINISHED") {
    await markAgentFinished(taskId, agent, info, repoStore, runId, state, config);
    return;
  }
  if (st === "ERROR") {
    await markAgentError(taskId, agent, info, repoStore, runId);
    return;
  }
  if (st === "RUNNING" || st === "CREATING") {
    await checkRunningAgent(taskId, agent, repoStore, runId);
  }
}

async function markAgentFinished(
  taskId: string,
  agent: AgentState,
  info: AgentInfo,
  repoStore: RepoStoreClient,
  runId: string,
  state: OrchestrationState,
  config: OrchestratorConfig,
): Promise<void> {
  agent.status = "finished";
  agent.finished_at = nowIso();
  agent.branch_name = info.branch_name?.trim() || computeBranchName(config.target.branch_prefix, runId, taskId, agent.retry_count);
  agent.pr_url = info.pr_url;
  agent.summary = info.summary;
  await readWorkerOutput(repoStore, runId, taskId);
  const phaseId = state.task_phase_map[taskId];
  await appendEvent(
    repoStore,
    runId,
    makeEvent("task_finished", `Task ${taskId} finished`, taskId, {
      phase_id: phaseId ?? null,
      agent_node_id: taskId,
      agent_kind: "task",
      payload: { status: agent.status },
    }),
  );
}

async function markAgentError(taskId: string, agent: AgentState, info: AgentInfo, repoStore: RepoStoreClient, runId: string): Promise<void> {
  agent.status = "failed";
  agent.finished_at = nowIso();
  agent.summary = info.summary ?? "Agent error";
  await appendEvent(repoStore, runId, makeEvent("task_failed", `Task ${taskId} failed: agent error`, taskId));
}

async function checkRunningAgent(taskId: string, agent: AgentState, repoStore: RepoStoreClient, runId: string): Promise<void> {
  if (agent.status === "launching") {
    agent.status = "running";
  }
  const output = await readWorkerOutput(repoStore, runId, taskId);
  if (!output || output.status !== "blocked") {
    return;
  }
  agent.status = "blocked";
  agent.blocked_reason = String(output.blocked_reason ?? "Unknown");
  if (!agent.blocked_since) {
    agent.blocked_since = nowIso();
  }
  await appendEvent(repoStore, runId, makeEvent("task_blocked", `Task ${taskId} blocked: ${agent.blocked_reason}`, taskId));
}

async function pollAgents(
  state: OrchestrationState,
  config: OrchestratorConfig,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
): Promise<void> {
  for (const [taskId, agent] of Object.entries(state.agents)) {
    await pollSingleAgent(taskId, agent, cursorClient, repoStore, runId, state, config);
  }
}

async function handleSingleBlocked(
  agent: AgentState,
  now: Date,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
  graph: Record<string, Set<string>>,
  state: OrchestrationState,
): Promise<void> {
  if (!agent.blocked_since) return;
  const blockedAt = new Date(agent.blocked_since);
  const elapsed = (now.getTime() - blockedAt.getTime()) / 1000;
  if (elapsed <= BLOCKED_TIMEOUT_SECONDS) return;
  if (agent.retry_count < MAX_RETRY_COUNT && agent.agent_id) {
    await retryBlockedAgent(agent, cursorClient, repoStore, runId);
    return;
  }
  await failBlockedAgent(agent, cursorClient, repoStore, runId, graph, state);
}

async function retryBlockedAgent(agent: AgentState, cursorClient: CursorClient, repoStore: RepoStoreClient, runId: string): Promise<void> {
  const prompt = `Your previous attempt was blocked. Reason: ${agent.blocked_reason}. Please try a different approach or report blocked again with a specific reason.`;
  try {
    await cursorClient.sendFollowup(agent.agent_id!, prompt);
  } catch {
    console.error(`Failed to send followup for blocked task ${agent.task_id}`);
  }
  agent.retry_count += 1;
  agent.status = "running";
  agent.blocked_reason = null;
  agent.blocked_since = null;
  try {
    await repoStore.deleteFile(runId, `agent-${agent.task_id}.json`);
  } catch {
    console.warn(`Failed to delete agent-${agent.task_id}.json for retry`);
  }
  await appendEvent(repoStore, runId, makeEvent("task_retried", `Task ${agent.task_id} retried`, agent.task_id));
}

async function failBlockedAgent(
  agent: AgentState,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
  graph: Record<string, Set<string>>,
  state: OrchestrationState,
): Promise<void> {
  agent.status = "failed";
  agent.finished_at = nowIso();
  agent.summary = agent.blocked_reason ?? "Blocked and retries exhausted";
  if (agent.agent_id) {
    try {
      await cursorClient.stopAgent(agent.agent_id);
    } catch {
      console.warn(`Failed to stop blocked agent ${agent.agent_id}`);
    }
  }
  await appendEvent(repoStore, runId, makeEvent("task_failed", `Task ${agent.task_id} failed: blocked`, agent.task_id));
  await cascadeFailures(state, agent.task_id, graph, repoStore, runId);
}

async function handleBlocked(
  state: OrchestrationState,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
  graph: Record<string, Set<string>>,
): Promise<void> {
  const now = new Date();
  for (const agent of getBlockedTasks(state.agents)) {
    await handleSingleBlocked(agent, now, cursorClient, repoStore, runId, graph, state);
  }
}

async function resolveGithubUsername(ghToken: string): Promise<string> {
  const resp = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${ghToken}` },
  });
  if (!resp.ok) {
    throw new Error(`GitHub user: ${resp.status}`);
  }
  const data = (await resp.json()) as { login: string };
  return data.login;
}

function resolveBootstrapRef(): string {
  const r = process.env.CURSOR_ORCH_RUNTIME_REF;
  if (r?.trim()) {
    return r.trim();
  }
  return "main";
}

async function resolveRepoForTask(
  task: TaskConfig,
  config: OrchestratorConfig,
  depOutputs: Record<string, Record<string, unknown>>,
  ghToken: string,
): Promise<[string, string]> {
  if (task.create_repo) {
    const ghUser = await resolveGithubUsername(ghToken);
    const bootstrapUrl = `https://github.com/${ghUser}/${config.bootstrap_repo_name}`;
    return [bootstrapUrl, resolveBootstrapRef()];
  }
  if (task.repo in config.repositories) {
    const rc = config.repositories[task.repo]!;
    const resolved = resolveRepoTarget(rc.url, config.repositories, rc.ref);
    if (resolved) {
      return resolved;
    }
    throw new Error(`Repository '${task.repo}' resolved to invalid repository target '${rc.url}'`);
  }
  for (const [, outputs] of Object.entries(depOutputs)) {
    if (outputs && typeof outputs.repo_url === "string") {
      const fallbackRef = typeof outputs.repo_ref === "string" ? outputs.repo_ref : "main";
      const resolved = resolveRepoTarget(outputs.repo_url as string, config.repositories, fallbackRef);
      if (resolved) {
        return resolved;
      }
    }
  }
  throw new Error(`Cannot resolve repository for task ${task.id}: repo '${task.repo}' not found and no upstream repo_url`);
}

async function gatherDepOutputs(task: TaskConfig, repoStore: RepoStoreClient, runId: string): Promise<Record<string, Record<string, unknown>>> {
  const depOutputs: Record<string, Record<string, unknown>> = {};
  for (const depId of task.depends_on) {
    const output = await readWorkerOutput(repoStore, runId, depId);
    depOutputs[depId] = (output?.outputs as Record<string, unknown>) ?? {};
  }
  return depOutputs;
}

async function tryLaunchAgent(
  cursorClient: CursorClient,
  prompt: string,
  repoUrl: string,
  ref: string,
  model: string,
  branch: string,
  autoPr: boolean,
): Promise<{ info: AgentInfo | null; error: string | null }> {
  try {
    return { info: await cursorClient.launchAgent(prompt, repoUrl, ref, model, branch, autoPr), error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { info: null, error: detail };
  }
}

async function launchSingleTask(
  taskId: string,
  state: OrchestrationState,
  config: OrchestratorConfig,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
): Promise<void> {
  assignTaskPhase(state, taskId, "execution");
  setPhaseStatus(state, "execution", "running", { timestamp: nowIso() });
  const taskMap = Object.fromEntries(config.tasks.map((t) => [t.id, t]));
  const task = taskMap[taskId]!;
  const ghToken = process.env.GH_TOKEN!;
  const depOutputs = await gatherDepOutputs(task, repoStore, runId);
  const [repoUrl, ref] = await resolveRepoForTask(task, config, depOutputs, ghToken);
  const prompt = task.create_repo
    ? buildRepoCreationPrompt(task, runId, ghToken, depOutputs)
    : buildWorkerPrompt(task, runId, ghToken, depOutputs);
  const branch = computeBranchName(config.target.branch_prefix, runId, taskId, state.agents[taskId]!.retry_count);
  const model = task.model ?? config.model;
  const autoPr = config.target.auto_create_pr && !config.target.consolidate_prs;
  const launch = await tryLaunchAgent(cursorClient, prompt, repoUrl, ref, model, branch, autoPr);
  if (!launch.info) {
    const detail = launch.error ?? "unknown launch error";
    const summary = `Failed to launch agent for task ${taskId}: ${detail} (repository=${repoUrl}, ref=${ref})`;
    console.error(summary);
    state.agents[taskId]!.status = "failed";
    state.agents[taskId]!.summary = summary;
    await appendEvent(
      repoStore,
      runId,
      makeEvent("task_failed", `Task ${taskId} failed: launch error (${detail})`, taskId, {
        payload: { repository: repoUrl, ref },
      }),
    );
    return;
  }
  const info = launch.info;
  const agent = state.agents[taskId]!;
  agent.agent_id = info.id;
  agent.status = "launching";
  agent.started_at = nowIso();
  await appendEvent(
    repoStore,
    runId,
    makeEvent("task_launched", `Launched ${taskId} (${info.id})`, taskId, {
      phase_id: "execution",
      agent_node_id: taskId,
      agent_kind: "task",
    }),
  );
}

async function launchReadyTasks(
  state: OrchestrationState,
  config: OrchestratorConfig,
  taskIds: string[],
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
): Promise<void> {
  for (const taskId of taskIds) {
    await launchSingleTask(taskId, state, config, cursorClient, repoStore, runId);
  }
}

async function stopAllRunning(state: OrchestrationState, cursorClient: CursorClient): Promise<void> {
  for (const agent of Object.values(state.agents)) {
    if ((agent.status === "running" || agent.status === "launching") && agent.agent_id) {
      try {
        await cursorClient.stopAgent(agent.agent_id);
        agent.status = "stopped";
        agent.finished_at = nowIso();
      } catch {
        console.warn(`Failed to stop agent ${agent.agent_id}`);
      }
    }
  }
}

function reconcileAgentsFromConfig(state: OrchestrationState, config: OrchestratorConfig): void {
  for (const task of config.tasks) {
    if (!state.agents[task.id]) {
      state.agents[task.id] = {
        task_id: task.id,
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
      };
    }
  }
}

function checkAllFinished(state: OrchestrationState): boolean {
  const agents = Object.values(state.agents);
  if (!agents.length) return false;
  return agents.every((a) => a.status === "finished");
}

function checkTerminalFailure(state: OrchestrationState, _graph: Record<string, Set<string>>): boolean {
  const failedIds = new Set(Object.entries(state.agents).filter(([, a]) => a.status === "failed").map(([id]) => id));
  if (!failedIds.size) return false;
  const pendingViable = Object.values(state.agents).filter((a) =>
    ["pending", "running", "launching", "blocked"].includes(a.status),
  );
  return pendingViable.length === 0;
}

function computeSleepTime(repoStore: RepoStoreClient): number {
  const remaining = repoStore.rateLimitRemaining;
  const limit = repoStore.rateLimitLimit;
  if (remaining === null || limit === null) {
    return POLL_INTERVAL;
  }
  const usedPct = 1 - remaining / limit;
  if (usedPct > 0.8) {
    console.warn(`Rate limit >80% consumed (${remaining} remaining), doubling poll interval`);
    return POLL_INTERVAL * 2;
  }
  return POLL_INTERVAL;
}

async function runPlanningPhase(
  config: OrchestratorConfig,
  runId: string,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
): Promise<boolean> {
  await appendEvent(repoStore, runId, makeEvent("planning_started", "Planning phase started", null, { phase_id: "planning", agent_kind: "phase" }));
  try {
    const ghToken = process.env.GH_TOKEN!;
    const ghUser = await resolveGithubUsername(ghToken);
    const plannerPrompt = buildPlannerPrompt(config, runId, ghToken, ghUser, config.bootstrap_repo_name);
    const bootstrapUrl = `https://github.com/${ghUser}/${config.bootstrap_repo_name}`;
    await cursorClient.launchAgent(
      plannerPrompt,
      bootstrapUrl,
      resolveBootstrapRef(),
      config.model,
      `cursor-orch-planner-${runId.slice(0, 8)}`,
      false,
    );
    const planContent = await waitForPlan(repoStore, runId);
    if (!planContent) {
      throw new Error("Timed out waiting for task plan from planner agent");
    }
    config.repositories["__bootstrap__"] = { url: bootstrapUrl, ref: resolveBootstrapRef() };
    const parsedTasks = parseTaskPlan(planContent, config);
    config.tasks = parsedTasks;
    const canonPlan = canonicalizeOrchestratorConfig(config);
    config.repositories = canonPlan.repositories;
    config.tasks = canonPlan.tasks;
    config.delegation_map = canonPlan.delegation_map;
    await repoStore.writeFile(runId, "config.yaml", toYaml(config));
    await appendEvent(
      repoStore,
      runId,
      makeEvent("planning_completed", `Planning completed: ${parsedTasks.length} tasks`, null, { phase_id: "planning", agent_kind: "phase" }),
    );
    return true;
  } catch (exc) {
    await appendEvent(repoStore, runId, makeEvent("planning_failed", String(exc), null, { phase_id: "planning", agent_kind: "phase" }));
    throw exc;
  }
}

async function persistUnexpectedFailure(state: OrchestrationState, repoStore: RepoStoreClient, runId: string, exc: unknown): Promise<void> {
  const timestamp = nowIso();
  ensureLifecycleAgents(state);
  state.status = "failed";
  state.error = String(exc);
  if (state.main_agent) {
    state.main_agent.status = "failed";
    state.main_agent.finished_at = timestamp;
  }
  for (const phaseId of ["planning", "scheduling", "execution", "finalization"]) {
    const phase = state.phase_agents[phaseId];
    if (!phase || !["running", "launching"].includes(phase.status)) continue;
    setPhaseStatus(state, phaseId, "failed", { timestamp });
  }
  try {
    await appendEvent(
      repoStore,
      runId,
      makeEvent("orchestration_failed", `Orchestration loop failed: ${exc}`, null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
    );
  } catch {
    console.error("Failed to append orchestration failure event");
  }
  try {
    await syncToRepo(repoStore, runId, state);
  } catch {
    console.error("Failed to sync orchestration failure state");
  }
}

export async function runOrchestration(runId: string, cursorClient: CursorClient, repoStore: RepoStoreClient): Promise<void> {
  const configStr = await repoStore.readFile(runId, "config.yaml");
  let config = parseConfig(configStr);
  config = canonicalizeOrchestratorConfig(config);

  let planningRan = false;
  let planningOk = false;
  if (config.prompt && !config.tasks.length) {
    planningRan = true;
    const planContent = await repoStore.readFile(runId, "task-plan.json");
    if (planContent) {
      try {
        const ghToken = process.env.GH_TOKEN!;
        const ghUser = await resolveGithubUsername(ghToken);
        const bootstrapUrl = `https://github.com/${ghUser}/${config.bootstrap_repo_name}`;
        config.repositories["__bootstrap__"] = { url: bootstrapUrl, ref: resolveBootstrapRef() };
        const parsedTasks = parseTaskPlan(planContent, config);
        config.tasks = parsedTasks;
        const canonReuse = canonicalizeOrchestratorConfig(config);
        config.repositories = canonReuse.repositories;
        config.tasks = canonReuse.tasks;
        config.delegation_map = canonReuse.delegation_map;
        await repoStore.writeFile(runId, "config.yaml", toYaml(config));
        await appendEvent(
          repoStore,
          runId,
          makeEvent("planning_completed", `Planning completed: ${parsedTasks.length} tasks (reused existing plan)`, null, {
            phase_id: "planning",
            agent_kind: "phase",
          }),
        );
        planningOk = true;
      } catch {
        /* try full planning */
      }
    }
    if (!planningOk) {
      planningOk = await runPlanningPhase(config, runId, cursorClient, repoStore);
    }
  }

  validateConfig(config);

  let state: OrchestrationState;
  try {
    state = await syncFromRepo(repoStore, runId);
  } catch {
    state = createInitialState(config, runId);
  }

  reconcileAgentsFromConfig(state, config);

  if (state.status === "pending") {
    state.status = "running";
    state.started_at = nowIso();
    seedMainAgent(state, { agent_id: state.orchestrator_agent_id, status: "running", started_at: state.started_at });
    await syncToRepo(repoStore, runId, state);
    await appendEvent(
      repoStore,
      runId,
      makeEvent("orchestration_started", "Orchestration started", null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
    );
  }
  if (planningRan) {
    setPhaseStatus(state, "planning", planningOk ? "finished" : "failed", { timestamp: nowIso() });
    await syncToRepo(repoStore, runId, state);
  }

  const graph = buildDependencyGraph(config.tasks);

  try {
    await orchestrationLoop(state, config, graph, cursorClient, repoStore, runId);
  } catch (exc) {
    console.error("Orchestration loop failed", exc);
    await persistUnexpectedFailure(state, repoStore, runId, exc);
    throw exc;
  }
  if (state.status === "failed") {
    throw new Error(state.error ? `Orchestration failed: ${state.error}` : "Orchestration failed");
  }
}

async function orchestrationLoop(
  state: OrchestrationState,
  config: OrchestratorConfig,
  graph: Record<string, Set<string>>,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
): Promise<void> {
  while (true) {
    if (await checkStopRequested(state, cursorClient, repoStore, runId, config)) {
      break;
    }
    await pollAgents(state, config, cursorClient, repoStore, runId);
    await handleBlocked(state, cursorClient, repoStore, runId, graph);
    const readyTasks = getReadyTasks(graph, state.agents);
    const eligibleReadyTasks = filterEligibleReadyTasks(state, config, readyTasks);
    await launchReadyTasks(state, config, eligibleReadyTasks, cursorClient, repoStore, runId);
    await writeProgress(state, config, repoStore, runId);
    if (await checkCompletion(state, config, graph, repoStore, runId)) {
      break;
    }
    if (await checkFailure(state, graph, repoStore, runId)) {
      break;
    }
    await delay(computeSleepTime(repoStore) * 1000);
  }
}

async function checkStopRequested(
  state: OrchestrationState,
  cursorClient: CursorClient,
  repoStore: RepoStoreClient,
  runId: string,
  config: OrchestratorConfig,
): Promise<boolean> {
  const stopContent = await repoStore.readFile(runId, "stop-requested.json");
  if (!stopContent) return false;
  console.info("Stop requested, halting orchestration");
  await stopAllRunning(state, cursorClient);
  state.status = "stopped";
  await repoStore.writeFile(runId, "summary.md", buildSummaryMd(config, state));
  await syncToRepo(repoStore, runId, state);
  await appendEvent(
    repoStore,
    runId,
    makeEvent("orchestration_stopped", "Orchestration stopped by user", null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
  );
  return true;
}

async function writeProgress(state: OrchestrationState, config: OrchestratorConfig, repoStore: RepoStoreClient, runId: string): Promise<void> {
  const summaryMd = buildSummaryMd(config, state);
  await repoStore.writeFile(runId, "summary.md", summaryMd);
  await syncToRepo(repoStore, runId, state);
}

async function maybeConsolidatePullRequests(
  state: OrchestrationState,
  config: OrchestratorConfig,
  graph: Record<string, Set<string>>,
  runId: string,
  repoStore: RepoStoreClient,
): Promise<void> {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  if (state.consolidated_pr_urls && Object.keys(state.consolidated_pr_urls).length > 0) return;

  const groups = new Map<string, { repoUrl: string; ref: string; taskIds: string[] }>();

  for (const task of config.tasks) {
    const agent = state.agents[task.id];
    if (!agent || agent.status !== "finished") continue;
    const depOutputs = await gatherDepOutputs(task, repoStore, runId);
    let resolved: [string, string] | null = null;
    if (task.create_repo) {
      const workerOut = await readWorkerOutput(repoStore, runId, task.id);
      const outputs = (workerOut?.outputs as Record<string, unknown>) ?? {};
      const url = typeof outputs.repo_url === "string" ? outputs.repo_url : null;
      if (url && parseGithubOwnerRepo(url)) {
        const ref = typeof outputs.repo_ref === "string" ? outputs.repo_ref : "main";
        resolved = [url, ref];
      }
    } else {
      try {
        resolved = await resolveRepoForTask(task, config, depOutputs, ghToken);
      } catch {
        continue;
      }
    }
    if (!resolved) continue;
    const [repoUrl, ref] = resolved;
    const key = groupKeyForRepo(repoUrl, ref);
    if (!groups.has(key)) {
      groups.set(key, { repoUrl, ref, taskIds: [] });
    }
    groups.get(key)!.taskIds.push(task.id);
  }

  const urls: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const [gKey, g] of groups) {
    const ownerRepo = parseGithubOwnerRepo(g.repoUrl);
    if (!ownerRepo) {
      errors[gKey] = `not a GitHub repo URL: ${g.repoUrl}`;
      continue;
    }
    let sorted: string[];
    try {
      sorted = topoSortTaskGroup(g.taskIds, graph);
    } catch (e) {
      errors[gKey] = e instanceof Error ? e.message : String(e);
      continue;
    }
    const branches: string[] = [];
    for (const tid of sorted) {
      const bn = state.agents[tid]?.branch_name;
      if (bn) branches.push(bn);
    }
    if (branches.length === 0) {
      errors[gKey] = "no task branches to merge";
      continue;
    }
    const integrationBranch = integrationBranchName(config.target.branch_prefix, runId, g.ref);
    const title = `cursor-orch: ${config.name} (${runId})`;
    const body = `Consolidated tasks: ${sorted.join(", ")}\n\nRun: ${runId}`;
    const r = await consolidateOneRepo(
      ghToken,
      {
        groupKey: gKey,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        baseRef: g.ref,
        taskBranches: branches,
        title,
        body,
      },
      integrationBranch,
    );
    if (r.error) {
      errors[gKey] = r.error;
    } else if (r.prUrl) {
      urls[gKey] = r.prUrl;
    }
    await appendEvent(
      repoStore,
      runId,
      makeEvent(
        r.error ? "consolidated_pr_failed" : "consolidated_pr_created",
        r.error ?? `Consolidated PR ${r.prUrl ?? ""}`,
        null,
        { agent_node_id: "main-orchestrator", agent_kind: "main", payload: { group_key: gKey.replace(/\0/g, "|") } },
      ),
    );
  }

  state.consolidated_pr_urls = Object.keys(urls).length ? urls : null;
  state.consolidated_pr_errors = Object.keys(errors).length ? errors : null;
}

async function checkCompletion(
  state: OrchestrationState,
  config: OrchestratorConfig,
  graph: Record<string, Set<string>>,
  repoStore: RepoStoreClient,
  runId: string,
): Promise<boolean> {
  if (!checkAllFinished(state)) return false;
  if (config.target.auto_create_pr && config.target.consolidate_prs) {
    await maybeConsolidatePullRequests(state, config, graph, runId, repoStore);
  }
  state.status = "completed";
  await syncToRepo(repoStore, runId, state);
  await appendEvent(
    repoStore,
    runId,
    makeEvent("orchestration_completed", "All tasks completed", null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
  );
  console.info("Orchestration completed successfully");
  return true;
}

async function checkFailure(state: OrchestrationState, graph: Record<string, Set<string>>, repoStore: RepoStoreClient, runId: string): Promise<boolean> {
  const failedIds = new Set(Object.entries(state.agents).filter(([, a]) => a.status === "failed").map(([id]) => id));
  if (!failedIds.size) return false;
  for (const fid of failedIds) {
    await cascadeFailures(state, fid, graph, repoStore, runId);
  }
  if (!checkTerminalFailure(state, graph)) return false;
  state.status = "failed";
  state.error = `Failed tasks: ${[...failedIds].sort().join(", ")}`;
  await syncToRepo(repoStore, runId, state);
  await appendEvent(
    repoStore,
    runId,
    makeEvent("orchestration_failed", `Orchestration failed: ${state.error}`, null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
  );
  return true;
}

export function loadSecretsFromRepo(runId: string): { GH_TOKEN: string; CURSOR_API_KEY: string } {
  const ref = `run/${runId}`;
  try {
    execSync(`git fetch origin ${ref}`, { encoding: "utf8" });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`git fetch origin ${ref} failed: ${detail}`);
  }
  let raw: string;
  try {
    raw = execSync("git show FETCH_HEAD:secrets.json", { encoding: "utf8" });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`git show FETCH_HEAD:secrets.json failed: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`secrets.json is not valid JSON: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("secrets.json must be a JSON object with GH_TOKEN and CURSOR_API_KEY");
  }
  const o = parsed as Record<string, unknown>;
  const gh = o.GH_TOKEN;
  const ck = o.CURSOR_API_KEY;
  if (typeof gh !== "string" || gh.length === 0) {
    throw new Error("secrets.json missing or empty GH_TOKEN");
  }
  if (typeof ck !== "string" || ck.length === 0) {
    throw new Error("secrets.json missing or empty CURSOR_API_KEY");
  }
  return { GH_TOKEN: gh, CURSOR_API_KEY: ck };
}

export async function runOrchestrationMain(): Promise<void> {
  const runId = process.env.RUN_ID;
  const bootstrapOwner = process.env.BOOTSTRAP_OWNER;
  const bootstrapRepo = process.env.BOOTSTRAP_REPO;
  if (!runId || !bootstrapOwner || !bootstrapRepo) {
    console.error("Missing RUN_ID, BOOTSTRAP_OWNER, or BOOTSTRAP_REPO");
    process.exit(1);
  }
  let secrets: { GH_TOKEN: string; CURSOR_API_KEY: string };
  try {
    secrets = loadSecretsFromRepo(runId);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.env.GH_TOKEN = secrets.GH_TOKEN;
  process.env.CURSOR_API_KEY = secrets.CURSOR_API_KEY;
  const cursorClient = new CursorClient(secrets.CURSOR_API_KEY);
  const repoStore = new RepoStoreClient(secrets.GH_TOKEN, bootstrapOwner, bootstrapRepo);
  await runOrchestration(runId, cursorClient, repoStore);
}
