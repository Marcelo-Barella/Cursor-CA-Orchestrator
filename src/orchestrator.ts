import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { RepoStoreClient } from "./api/repo-store.js";
import type { OrchestratorConfig, TaskConfig } from "./config/types.js";
import { canonicalizeOrchestratorConfig } from "./config/canonicalize.js";
import { parseConfig, toYaml } from "./config/parse.js";
import { canonicalRepoAliasForTask, validateConfig } from "./config/validate.js";
import { buildPlannerPrompt, parseTaskPlan, waitForPlan } from "./planner.js";
import { WORKER_OUTPUT_ARTIFACT_PATH, buildRepoCreationPrompt, buildWorkerPrompt } from "./prompt-builder.js";
import { extractConstraintsFromPrompt, validateTaskPromptsAgainstConstraints } from "./lib/constraint-validator.js";
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
  ensureRunBranchFromBase,
  groupKeyForRepo,
  integrationBranchName,
  openPullRequestForRunBranch,
  runBranchName,
  topoSortTaskGroup,
} from "./lib/github-consolidated-pr.js";
import { parseGithubOwnerRepo, resolveRepoTarget } from "./lib/repo-target.js";
import {
  type AgentClient,
  type SDKAssistantMessage,
  type SDKStatusMessage,
  type SdkAgent,
  type SdkRun,
  createDefaultAgentClient,
  parseAssistantJsonFromMessages,
  parseAssistantJsonFromText,
  streamToCallbacks,
  tryDownloadJsonArtifact,
} from "./sdk/agent-client.js";
import { createTranscriptWriter, type TranscriptWriter } from "./sdk/transcript.js";

const STOP_POLL_INTERVAL_MS = 5_000;
const MAX_WAKEUP_INTERVAL_MS = 10_000;
const BLOCKED_TIMEOUT_SECONDS = 300;
const MAX_RETRY_COUNT = 1;
const MAX_WORKER_OUTPUT_BYTES = 512 * 1024;
const MAX_SUMMARY_BYTES = 4096;
const MAX_OUTPUTS_BYTES = 256 * 1024;

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

function taskIdsFromConfig(config: OrchestratorConfig): Set<string> {
  return new Set(config.tasks.map((t) => t.id));
}

export function extractDelegationPhases(config: OrchestratorConfig, knownTaskIds: Set<string>): DelegationPhase[] | null {
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
    return null;
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
  const phases = extractDelegationPhases(config, taskIdsFromConfig(config));
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

function resolvePlanRefForTask(task: TaskConfig, config: OrchestratorConfig): string | null {
  const alias = canonicalRepoAliasForTask(task, config.repositories);
  if (!alias) {
    return null;
  }
  const rc = config.repositories[alias];
  return rc ? rc.ref : null;
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
  const serializedLen = Buffer.byteLength(JSON.stringify(o), "utf8");
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

function normalizeWorkerPayload(raw: unknown, taskId: string): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.task_id !== "string") {
    obj.task_id = taskId;
  }
  if (typeof obj.status !== "string") {
    obj.status = "completed";
  }
  if (typeof obj.summary !== "string" && obj.summary !== null) {
    obj.summary = null;
  }
  if (!("outputs" in obj) || typeof obj.outputs !== "object" || obj.outputs === null) {
    obj.outputs = {};
  }
  if (Buffer.byteLength(JSON.stringify(obj), "utf8") > MAX_WORKER_OUTPUT_BYTES) {
    console.warn(`Worker output for ${taskId} exceeds 512KB, truncating`);
  }
  return truncateOutput(obj, taskId);
}

async function readWorkerOutputFromRepo(repoStore: RepoStoreClient, runId: string, taskId: string): Promise<Record<string, unknown> | null> {
  const content = await repoStore.readFile(runId, `agent-${taskId}.json`);
  if (!content) return null;
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    return truncateOutput(data, taskId);
  } catch {
    return null;
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

function nonEmptyMcpServers(
  servers: OrchestratorConfig["mcp_servers"],
): OrchestratorConfig["mcp_servers"] | undefined {
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }
  return servers;
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
    const output = await readWorkerOutputFromRepo(repoStore, runId, depId);
    depOutputs[depId] = (output?.outputs as Record<string, unknown>) ?? {};
  }
  return depOutputs;
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

function checkTerminalFailure(state: OrchestrationState): boolean {
  const failedIds = new Set(Object.entries(state.agents).filter(([, a]) => a.status === "failed").map(([id]) => id));
  if (!failedIds.size) return false;
  const pendingViable = Object.values(state.agents).filter((a) =>
    ["pending", "running", "launching", "blocked"].includes(a.status),
  );
  return pendingViable.length === 0;
}

type WorkerHandle = {
  taskId: string;
  sdkAgent: SdkAgent;
  run: SdkRun;
  assistantMessages: SDKAssistantMessage[];
  transcript: TranscriptWriter;
  done: Promise<void>;
};

type LoopContext = {
  state: OrchestrationState;
  config: OrchestratorConfig;
  graph: Record<string, Set<string>>;
  agentClient: AgentClient;
  repoStore: RepoStoreClient;
  runId: string;
  apiKey: string;
  ghToken: string;
  activeWorkers: Map<string, WorkerHandle>;
  dirty: { value: boolean };
  wakeup: { resolve: () => void; promise: Promise<void> };
  stopRequested: { value: boolean };
};

function markStateDirty(ctx: LoopContext): void {
  ctx.dirty.value = true;
  triggerWakeup(ctx);
}

function triggerWakeup(ctx: LoopContext): void {
  const resolve = ctx.wakeup.resolve;
  ctx.wakeup = createWakeup();
  resolve();
}

function createWakeup(): { resolve: () => void; promise: Promise<void> } {
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { resolve: resolveFn, promise };
}

async function safeDisposeAgent(agent: SdkAgent): Promise<void> {
  try {
    await agent[Symbol.asyncDispose]();
  } catch {
    /* advisory close */
  }
}

async function launchWorkerAgent(
  ctx: LoopContext,
  taskId: string,
  task: TaskConfig,
  depOutputs: Record<string, Record<string, unknown>>,
): Promise<void> {
  const agent = ctx.state.agents[taskId]!;
  const [repoUrl, ref] = await resolveRepoForTask(task, ctx.config, depOutputs, ctx.ghToken);
  const planRef = resolvePlanRefForTask(task, ctx.config);
  const runLine =
    !task.create_repo && ctx.config.target.branch_layout === "consolidated" && ctx.config.target.consolidate_prs && planRef;
  let launchRef = ref;
  let workerBranch = computeBranchName(ctx.config.target.branch_prefix, ctx.runId, taskId, agent.retry_count);
  let runBranchForPrompt: string | undefined;
  if (runLine && planRef) {
    const ownerRepo = parseGithubOwnerRepo(repoUrl);
    const rb = runBranchName(ctx.config.target.branch_prefix, ctx.runId, planRef);
    if (ownerRepo) {
      const ensured = await ensureRunBranchFromBase(ctx.ghToken, ownerRepo.owner, ownerRepo.repo, planRef, rb);
      if (ensured.error) {
        const summary = `Failed to prepare run branch for task ${taskId}: ${ensured.error}`;
        console.error(summary);
        agent.status = "failed";
        agent.summary = summary;
        await appendEvent(
          ctx.repoStore,
          ctx.runId,
          makeEvent("task_failed", `Task ${taskId} failed: ${ensured.error}`, taskId, {
            payload: { repository: repoUrl, ref: planRef },
          }),
        );
        markStateDirty(ctx);
        return;
      }
    }
    const gk = groupKeyForRepo(repoUrl, planRef);
    launchRef = ctx.state.repo_run_head?.[gk] ?? planRef;
    workerBranch = rb;
    runBranchForPrompt = rb;
  }
  const prompt = task.create_repo
    ? buildRepoCreationPrompt(task, ctx.runId, depOutputs)
    : buildWorkerPrompt(task, ctx.runId, depOutputs, {
        runBranch: runBranchForPrompt,
        launchRef,
        perTaskBranch: computeBranchName(ctx.config.target.branch_prefix, ctx.runId, taskId, agent.retry_count),
      });
  const model = task.model ?? ctx.config.model;
  const autoPr = ctx.config.target.auto_create_pr && !ctx.config.target.consolidate_prs;
  let sdkAgent: SdkAgent;
  try {
    sdkAgent = ctx.agentClient.createCloudAgent({
      apiKey: ctx.apiKey,
      model,
      repoUrl,
      startingRef: launchRef,
      branchName: workerBranch,
      autoCreatePR: autoPr,
      skipReviewerRequest: true,
      mcpServers: nonEmptyMcpServers(ctx.config.mcp_servers),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const summary = `Failed to create SDK agent for task ${taskId}: ${detail} (repository=${repoUrl}, ref=${launchRef})`;
    console.error(summary);
    agent.status = "failed";
    agent.summary = summary;
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_failed", `Task ${taskId} failed: launch error (${detail})`, taskId, {
        payload: { repository: repoUrl, ref: launchRef },
      }),
    );
    markStateDirty(ctx);
    return;
  }
  let run: SdkRun;
  try {
    run = await sdkAgent.send(prompt);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const summary = `Failed to dispatch prompt for task ${taskId}: ${detail}`;
    console.error(summary);
    agent.status = "failed";
    agent.summary = summary;
    await safeDisposeAgent(sdkAgent);
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_failed", `Task ${taskId} failed: send error (${detail})`, taskId, {
        payload: { repository: repoUrl, ref: launchRef },
      }),
    );
    markStateDirty(ctx);
    return;
  }
  agent.agent_id = sdkAgent.agentId;
  agent.status = "launching";
  agent.started_at = nowIso();
  agent.branch_name = workerBranch;
  await appendEvent(
    ctx.repoStore,
    ctx.runId,
    makeEvent("task_launched", `Launched ${taskId} (${sdkAgent.agentId})`, taskId, {
      phase_id: "execution",
      agent_node_id: taskId,
      agent_kind: "task",
      payload: { run_id: run.id, repository: repoUrl, ref: launchRef, branch: workerBranch },
    }),
  );
  const transcript = createTranscriptWriter({ repoStore: ctx.repoStore, runId: ctx.runId, taskId });
  const handle: WorkerHandle = {
    taskId,
    sdkAgent,
    run,
    assistantMessages: [],
    transcript,
    done: Promise.resolve(),
  };
  handle.done = runWorkerStream(ctx, handle, { repoUrl, ref: launchRef, runLine: Boolean(runLine) && Boolean(planRef), planRef });
  ctx.activeWorkers.set(taskId, handle);
  markStateDirty(ctx);
}

async function runWorkerStream(
  ctx: LoopContext,
  handle: WorkerHandle,
  info: { repoUrl: string; ref: string; runLine: boolean; planRef: string | null },
): Promise<void> {
  const taskId = handle.taskId;
  const agent = ctx.state.agents[taskId]!;
  let lastStatus: SDKStatusMessage["status"] | null = null;
  let streamError: unknown = null;
  try {
    await streamToCallbacks(handle.run, {
      onEvent: (event) => {
        handle.transcript.enqueue(event);
      },
      onAssistant: (event) => {
        handle.assistantMessages.push(event);
      },
      onStatus: async (event) => {
        lastStatus = event.status;
        if (event.status === "RUNNING" && agent.status === "launching") {
          agent.status = "running";
          markStateDirty(ctx);
        }
        try {
          await appendEvent(
            ctx.repoStore,
            ctx.runId,
            makeEvent("worker_status", `Task ${taskId} status=${event.status}`, taskId, {
              agent_node_id: taskId,
              agent_kind: "task",
              payload: { status: event.status, ...(event.message ? { message: event.message } : {}) },
            }),
          );
        } catch {
          /* ignore event append failures */
        }
      },
      onToolCall: async (event) => {
        if (event.status === "running") return;
        try {
          await appendEvent(
            ctx.repoStore,
            ctx.runId,
            makeEvent(
              "worker_tool_call",
              `Task ${taskId} tool ${event.name} ${event.status}`,
              taskId,
              {
                agent_node_id: taskId,
                agent_kind: "task",
                payload: { tool: event.name, status: event.status },
              },
            ),
          );
        } catch {
          /* ignore */
        }
      },
      onError: (err) => {
        streamError = err;
      },
    });
  } catch (err) {
    streamError = err;
  }
  try {
    await handle.transcript.flush();
  } catch {
    /* flush failures are non-fatal */
  }

  let result: { status: "finished" | "error" | "cancelled" | "unknown"; durationMs?: number; git?: { branch?: string; prUrl?: string }; model?: string; resultText?: string } = { status: "unknown" };
  try {
    const awaited = await handle.run.wait();
    result = {
      status: awaited.status,
      durationMs: awaited.durationMs,
      git: awaited.git,
      model: awaited.model,
      resultText: awaited.result,
    };
  } catch (err) {
    if (streamError === null) streamError = err;
  }

  const sdkAgent = handle.sdkAgent;
  let payloadRaw: unknown = null;
  let payloadSource: "artifact" | "assistant" | "conversation" | "none" = "none";
  try {
    const artifact = await tryDownloadJsonArtifact(sdkAgent, WORKER_OUTPUT_ARTIFACT_PATH);
    if (artifact.value !== null) {
      payloadRaw = artifact.value;
      payloadSource = "artifact";
    }
  } catch {
    /* handled as null below */
  }
  if (payloadRaw === null) {
    const fallback = parseAssistantJsonFromMessages(handle.assistantMessages);
    if (fallback !== null) {
      payloadRaw = fallback;
      payloadSource = "assistant";
    }
  }
  if (payloadRaw === null && typeof ctx.agentClient.fetchAgentConversationText === "function") {
    try {
      const conversationText = await ctx.agentClient.fetchAgentConversationText(sdkAgent.agentId);
      if (conversationText) {
        const parsed = parseAssistantJsonFromText(conversationText);
        if (parsed !== null) {
          payloadRaw = parsed;
          payloadSource = "conversation";
        }
      }
    } catch {
      /* conversation fallback is best-effort */
    }
  }
  const payload = normalizeWorkerPayload(payloadRaw, taskId);

  if (payload) {
    try {
      await ctx.repoStore.writeFile(ctx.runId, `agent-${taskId}.json`, JSON.stringify(payload, null, 2));
    } catch (err) {
      console.warn(`Failed to write agent-${taskId}.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const payloadStatus = typeof payload?.status === "string" ? (payload.status as string) : null;
  const payloadSummary = typeof payload?.summary === "string" ? (payload.summary as string) : null;
  const payloadBlockedReason = typeof payload?.blocked_reason === "string" ? (payload.blocked_reason as string) : null;

  if (info.runLine && info.planRef) {
    const ownerRepo = parseGithubOwnerRepo(info.repoUrl);
    if (ownerRepo) {
      const gk = groupKeyForRepo(info.repoUrl, info.planRef);
      ctx.state.repo_run_head = ctx.state.repo_run_head ?? {};
      ctx.state.repo_run_head[gk] = runBranchName(ctx.config.target.branch_prefix, ctx.runId, info.planRef);
      agent.branch_name = ctx.state.repo_run_head[gk]!;
    }
  } else if (result.git?.branch) {
    agent.branch_name = result.git.branch;
  }
  if (result.git?.prUrl) {
    agent.pr_url = result.git.prUrl;
  }

  const finalizedAt = nowIso();

  if (payloadStatus === "blocked") {
    agent.status = "blocked";
    agent.blocked_reason = payloadBlockedReason ?? "Worker reported blocked without reason";
    if (!agent.blocked_since) agent.blocked_since = finalizedAt;
    agent.summary = payloadSummary ?? agent.blocked_reason;
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_blocked", `Task ${taskId} blocked: ${agent.blocked_reason}`, taskId),
    );
  } else if (result.status === "cancelled") {
    agent.status = "stopped";
    agent.finished_at = finalizedAt;
    agent.summary = payloadSummary ?? "Task cancelled";
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_stopped", `Task ${taskId} stopped`, taskId),
    );
  } else if (payloadStatus === "completed") {
    agent.status = "finished";
    agent.finished_at = finalizedAt;
    agent.summary = payloadSummary ?? "Task completed";
    const phaseId = ctx.state.task_phase_map[taskId];
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_finished", `Task ${taskId} finished`, taskId, {
        phase_id: phaseId ?? null,
        agent_node_id: taskId,
        agent_kind: "task",
        payload: { status: agent.status, payload_source: payloadSource },
      }),
    );
  } else if (result.status === "error" || payloadStatus === "failed" || streamError) {
    agent.status = "failed";
    agent.finished_at = finalizedAt;
    const errText = streamError instanceof Error ? streamError.message : streamError !== null ? String(streamError) : null;
    agent.summary = payloadSummary ?? errText ?? "Worker agent errored";
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_failed", `Task ${taskId} failed${errText ? `: ${errText}` : ""}`, taskId, {
        payload: errText ? { error: errText, payload_source: payloadSource, last_status: String(lastStatus ?? "") } : { payload_source: payloadSource, last_status: String(lastStatus ?? "") },
      }),
    );
    await cascadeFailures(ctx.state, taskId, ctx.graph, ctx.repoStore, ctx.runId);
  } else if (result.status === "finished") {
    agent.status = "finished";
    agent.finished_at = finalizedAt;
    agent.summary = payloadSummary ?? "Task completed";
    const phaseId = ctx.state.task_phase_map[taskId];
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_finished", `Task ${taskId} finished`, taskId, {
        phase_id: phaseId ?? null,
        agent_node_id: taskId,
        agent_kind: "task",
        payload: { status: agent.status, payload_source: payloadSource },
      }),
    );
  } else {
    agent.status = "failed";
    agent.finished_at = finalizedAt;
    agent.summary = payloadSummary ?? `Worker run status=${result.status}`;
    await appendEvent(
      ctx.repoStore,
      ctx.runId,
      makeEvent("task_failed", `Task ${taskId} failed (run status=${result.status})`, taskId, {
        payload: { payload_source: payloadSource, last_status: String(lastStatus ?? "") },
      }),
    );
    await cascadeFailures(ctx.state, taskId, ctx.graph, ctx.repoStore, ctx.runId);
  }

  ctx.activeWorkers.delete(taskId);
  await safeDisposeAgent(sdkAgent);
  markStateDirty(ctx);
}

async function retryBlockedAgent(ctx: LoopContext, agent: AgentState): Promise<void> {
  const handle = ctx.activeWorkers.get(agent.task_id);
  if (!handle) {
    agent.retry_count += 1;
    agent.status = "pending";
    agent.blocked_reason = null;
    agent.blocked_since = null;
    await appendEvent(ctx.repoStore, ctx.runId, makeEvent("task_retried", `Task ${agent.task_id} retried (re-launched)`, agent.task_id));
    markStateDirty(ctx);
    return;
  }
  const prompt = `Your previous attempt was blocked. Reason: ${agent.blocked_reason}. Please try a different approach or report blocked again with a specific reason. Remember to write the final JSON to cursor-orch-output.json and include it as a fenced \`\`\`json block in your last assistant message.`;
  let run: SdkRun;
  try {
    run = await handle.sdkAgent.send(prompt);
  } catch (error) {
    console.error(`Failed to send follow-up for blocked task ${agent.task_id}: ${error instanceof Error ? error.message : String(error)}`);
    agent.status = "failed";
    agent.finished_at = nowIso();
    agent.summary = agent.blocked_reason ?? "Blocked; follow-up dispatch failed";
    ctx.activeWorkers.delete(agent.task_id);
    await safeDisposeAgent(handle.sdkAgent);
    await cascadeFailures(ctx.state, agent.task_id, ctx.graph, ctx.repoStore, ctx.runId);
    markStateDirty(ctx);
    return;
  }
  agent.retry_count += 1;
  agent.status = "running";
  agent.blocked_reason = null;
  agent.blocked_since = null;
  try {
    await ctx.repoStore.deleteFile(ctx.runId, `agent-${agent.task_id}.json`);
  } catch {
    /* advisory */
  }
  const nextHandle: WorkerHandle = {
    taskId: agent.task_id,
    sdkAgent: handle.sdkAgent,
    run,
    assistantMessages: [],
    transcript: createTranscriptWriter({ repoStore: ctx.repoStore, runId: ctx.runId, taskId: agent.task_id }),
    done: Promise.resolve(),
  };
  const info = {
    repoUrl: "",
    ref: "",
    runLine: false,
    planRef: null as string | null,
  };
  const task = ctx.config.tasks.find((t) => t.id === agent.task_id);
  if (task) {
    try {
      const depOutputs = await gatherDepOutputs(task, ctx.repoStore, ctx.runId);
      const [repoUrl, ref] = await resolveRepoForTask(task, ctx.config, depOutputs, ctx.ghToken);
      info.repoUrl = repoUrl;
      info.ref = ref;
      info.planRef = resolvePlanRefForTask(task, ctx.config);
      info.runLine = Boolean(info.planRef) && !task.create_repo && ctx.config.target.branch_layout === "consolidated" && ctx.config.target.consolidate_prs;
    } catch {
      /* fall through with empty info; branch_name will not update via run-line logic */
    }
  }
  nextHandle.done = runWorkerStream(ctx, nextHandle, info);
  ctx.activeWorkers.set(agent.task_id, nextHandle);
  await appendEvent(ctx.repoStore, ctx.runId, makeEvent("task_retried", `Task ${agent.task_id} retried`, agent.task_id));
  markStateDirty(ctx);
}

async function handleBlockedTasks(ctx: LoopContext): Promise<void> {
  const now = new Date();
  for (const agent of getBlockedTasks(ctx.state.agents)) {
    if (!agent.blocked_since) continue;
    const blockedAt = new Date(agent.blocked_since);
    const elapsed = (now.getTime() - blockedAt.getTime()) / 1000;
    if (elapsed <= BLOCKED_TIMEOUT_SECONDS) continue;
    if (agent.retry_count < MAX_RETRY_COUNT && agent.agent_id) {
      await retryBlockedAgent(ctx, agent);
      continue;
    }
    agent.status = "failed";
    agent.finished_at = nowIso();
    agent.summary = agent.blocked_reason ?? "Blocked and retries exhausted";
    const handle = ctx.activeWorkers.get(agent.task_id);
    if (handle) {
      await safeDisposeAgent(handle.sdkAgent);
      ctx.activeWorkers.delete(agent.task_id);
    }
    await appendEvent(ctx.repoStore, ctx.runId, makeEvent("task_failed", `Task ${agent.task_id} failed: blocked`, agent.task_id));
    await cascadeFailures(ctx.state, agent.task_id, ctx.graph, ctx.repoStore, ctx.runId);
    markStateDirty(ctx);
  }
}

async function launchReadyTasks(ctx: LoopContext): Promise<void> {
  const readyTasks = getReadyTasks(ctx.graph, ctx.state.agents);
  const eligible = filterEligibleReadyTasks(ctx.state, ctx.config, readyTasks);
  if (eligible.length === 0) return;
  const taskMap = Object.fromEntries(ctx.config.tasks.map((t) => [t.id, t]));
  for (const taskId of eligible) {
    const task = taskMap[taskId];
    if (!task) continue;
    assignTaskPhase(ctx.state, taskId, "execution");
    setPhaseStatus(ctx.state, "execution", "running", { timestamp: nowIso() });
    const depOutputs = await gatherDepOutputs(task, ctx.repoStore, ctx.runId);
    await launchWorkerAgent(ctx, taskId, task, depOutputs);
  }
}

async function checkStopRequested(ctx: LoopContext): Promise<boolean> {
  const stopContent = await ctx.repoStore.readFile(ctx.runId, "stop-requested.json");
  if (!stopContent) return false;
  ctx.stopRequested.value = true;
  console.info("Stop requested, halting orchestration");
  for (const [taskId, handle] of ctx.activeWorkers.entries()) {
    const agent = ctx.state.agents[taskId];
    if (agent && (agent.status === "running" || agent.status === "launching")) {
      agent.status = "stopped";
      agent.finished_at = nowIso();
    }
    await safeDisposeAgent(handle.sdkAgent);
  }
  ctx.activeWorkers.clear();
  ctx.state.status = "stopped";
  await ctx.repoStore.writeFile(ctx.runId, "summary.md", buildSummaryMd(ctx.config, ctx.state));
  await syncToRepo(ctx.repoStore, ctx.runId, ctx.state);
  await appendEvent(
    ctx.repoStore,
    ctx.runId,
    makeEvent("orchestration_stopped", "Orchestration stopped by user", null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
  );
  return true;
}

async function writeProgress(ctx: LoopContext): Promise<void> {
  if (!ctx.dirty.value) return;
  ctx.dirty.value = false;
  await ctx.repoStore.writeFile(ctx.runId, "summary.md", buildSummaryMd(ctx.config, ctx.state));
  await syncToRepo(ctx.repoStore, ctx.runId, ctx.state);
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
      const workerOut = await readWorkerOutputFromRepo(repoStore, runId, task.id);
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
    const title = `cursor-orch: ${config.name} (${runId})`;
    const body = `Consolidated tasks: ${sorted.join(", ")}\n\nRun: ${runId}`;
    const expectedRun = runBranchName(config.target.branch_prefix, runId, g.ref);
    const uniqueHeads = [...new Set(branches)];
    const useRunLine =
      config.target.branch_layout === "consolidated" && uniqueHeads.length === 1 && uniqueHeads[0] === expectedRun;
    const r = useRunLine
      ? await openPullRequestForRunBranch(ghToken, {
          groupKey: gKey,
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          baseRef: g.ref,
          runBranch: expectedRun,
          title,
          body,
        })
      : await consolidateOneRepo(
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
          integrationBranchName(config.target.branch_prefix, runId, g.ref),
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

async function checkCompletion(ctx: LoopContext): Promise<boolean> {
  if (ctx.activeWorkers.size > 0) return false;
  if (!checkAllFinished(ctx.state)) return false;
  if (ctx.config.target.auto_create_pr && ctx.config.target.consolidate_prs) {
    await maybeConsolidatePullRequests(ctx.state, ctx.config, ctx.graph, ctx.runId, ctx.repoStore);
  }
  ctx.state.status = "completed";
  await syncToRepo(ctx.repoStore, ctx.runId, ctx.state);
  await ctx.repoStore.writeFile(ctx.runId, "summary.md", buildSummaryMd(ctx.config, ctx.state));
  await appendEvent(
    ctx.repoStore,
    ctx.runId,
    makeEvent("orchestration_completed", "All tasks completed", null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
  );
  console.info("Orchestration completed successfully");
  return true;
}

async function checkFailure(ctx: LoopContext): Promise<boolean> {
  const failedIds = new Set(Object.entries(ctx.state.agents).filter(([, a]) => a.status === "failed").map(([id]) => id));
  if (!failedIds.size) return false;
  for (const fid of failedIds) {
    await cascadeFailures(ctx.state, fid, ctx.graph, ctx.repoStore, ctx.runId);
  }
  if (!checkTerminalFailure(ctx.state)) return false;
  if (ctx.activeWorkers.size > 0) return false;
  ctx.state.status = "failed";
  ctx.state.error = `Failed tasks: ${[...failedIds].sort().join(", ")}`;
  await syncToRepo(ctx.repoStore, ctx.runId, ctx.state);
  await ctx.repoStore.writeFile(ctx.runId, "summary.md", buildSummaryMd(ctx.config, ctx.state));
  await appendEvent(
    ctx.repoStore,
    ctx.runId,
    makeEvent("orchestration_failed", `Orchestration failed: ${ctx.state.error}`, null, { agent_node_id: "main-orchestrator", agent_kind: "main" }),
  );
  return true;
}

async function runPlanningPhase(
  config: OrchestratorConfig,
  runId: string,
  agentClient: AgentClient,
  repoStore: RepoStoreClient,
  apiKey: string,
): Promise<boolean> {
  await appendEvent(repoStore, runId, makeEvent("planning_started", "Planning phase started", null, { phase_id: "planning", agent_kind: "phase" }));
  try {
    const ghToken = process.env.GH_TOKEN!;
    const ghUser = await resolveGithubUsername(ghToken);
    const plannerPrompt = buildPlannerPrompt(config, runId, ghUser, config.bootstrap_repo_name);
    const bootstrapUrl = `https://github.com/${ghUser}/${config.bootstrap_repo_name}`;
    const plannerAgent = agentClient.createCloudAgent({
      apiKey,
      model: config.model,
      repoUrl: bootstrapUrl,
      startingRef: resolveBootstrapRef(),
      branchName: `cursor-orch-planner-${runId.slice(0, 8)}`,
      autoCreatePR: false,
      skipReviewerRequest: true,
      mcpServers: nonEmptyMcpServers(config.mcp_servers),
    });
    try {
      await plannerAgent.send(plannerPrompt);
    } catch (error) {
      await safeDisposeAgent(plannerAgent);
      throw error;
    }
    let planContent = await waitForPlan(repoStore, runId);
    if (!planContent) {
      try {
        const runs = await (await import("@cursor/february")).Agent.listRuns(plannerAgent.agentId, { runtime: "cloud", apiKey });
        for (const r of runs.items) {
          if (typeof r.result === "string" && r.result.trim()) {
            planContent = r.result;
            break;
          }
        }
      } catch {
        /* no fallback available */
      }
    }
    await safeDisposeAgent(plannerAgent);
    if (!planContent) {
      throw new Error("Timed out waiting for task plan from planner agent");
    }
    config.repositories["__bootstrap__"] = { url: bootstrapUrl, ref: resolveBootstrapRef() };
    const parsedTasks = parseTaskPlan(planContent, config);
    const constraints = extractConstraintsFromPrompt(config.prompt);
    if (constraints.length > 0) {
      const result = validateTaskPromptsAgainstConstraints(parsedTasks, constraints);
      if (!result.valid) {
        const detail = result.violations
          .map((v) => `Task '${v.taskId}' missing constraint: "${v.missingConstraint}"`)
          .join("; ");
        throw new Error(`Plan constraint validation failed: ${detail}. Re-plan with full constraint coverage.`);
      }
    }
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

async function reattachWorkers(ctx: LoopContext): Promise<void> {
  const { Agent } = await import("@cursor/february");
  for (const [taskId, agent] of Object.entries(ctx.state.agents)) {
    if (!agent.agent_id) continue;
    if (agent.status !== "launching" && agent.status !== "running" && agent.status !== "blocked") continue;
    if (ctx.activeWorkers.has(taskId)) continue;
    try {
      const resumeOptions: Parameters<typeof ctx.agentClient.resumeCloudAgent>[1] = {
        apiKey: ctx.apiKey,
        model: { id: ctx.config.model },
      };
      const mcpServers = nonEmptyMcpServers(ctx.config.mcp_servers);
      if (mcpServers) {
        resumeOptions.mcpServers = mcpServers;
      }
      const sdkAgent = ctx.agentClient.resumeCloudAgent(agent.agent_id, resumeOptions);
      const runs = await Agent.listRuns(agent.agent_id, { runtime: "cloud", apiKey: ctx.apiKey });
      const latest = runs.items[0];
      if (!latest) {
        await safeDisposeAgent(sdkAgent);
        agent.status = "failed";
        agent.summary = "Resume: no runs found for agent";
        continue;
      }
      const handle: WorkerHandle = {
        taskId,
        sdkAgent,
        run: latest,
        assistantMessages: [],
        transcript: createTranscriptWriter({ repoStore: ctx.repoStore, runId: ctx.runId, taskId }),
        done: Promise.resolve(),
      };
      const task = ctx.config.tasks.find((t) => t.id === taskId);
      const info = { repoUrl: "", ref: "", runLine: false, planRef: null as string | null };
      if (task) {
        try {
          const depOutputs = await gatherDepOutputs(task, ctx.repoStore, ctx.runId);
          const [repoUrl, ref] = await resolveRepoForTask(task, ctx.config, depOutputs, ctx.ghToken);
          info.repoUrl = repoUrl;
          info.ref = ref;
          info.planRef = resolvePlanRefForTask(task, ctx.config);
          info.runLine = Boolean(info.planRef) && !task.create_repo && ctx.config.target.branch_layout === "consolidated" && ctx.config.target.consolidate_prs;
        } catch {
          /* ignore */
        }
      }
      handle.done = runWorkerStream(ctx, handle, info);
      ctx.activeWorkers.set(taskId, handle);
    } catch (err) {
      agent.status = "failed";
      agent.summary = `Resume failed: ${err instanceof Error ? err.message : String(err)}`;
      markStateDirty(ctx);
    }
  }
}

async function orchestrationLoop(ctx: LoopContext): Promise<void> {
  ctx.wakeup = createWakeup();
  try {
    const existing = await ctx.repoStore.readFile(ctx.runId, "stop-requested.json");
    if (existing) {
      ctx.stopRequested.value = true;
    }
  } catch {
    /* ignore; the poller will retry */
  }
  const pollController = new AbortController();
  const stopPoller = (async () => {
    while (!ctx.stopRequested.value) {
      try {
        await delay(STOP_POLL_INTERVAL_MS, undefined, { signal: pollController.signal });
      } catch {
        return;
      }
      if (ctx.stopRequested.value) return;
      try {
        const content = await ctx.repoStore.readFile(ctx.runId, "stop-requested.json");
        if (content) {
          ctx.stopRequested.value = true;
          triggerWakeup(ctx);
          return;
        }
      } catch {
        /* retry next tick */
      }
    }
  })();

  try {
    while (true) {
      if (ctx.stopRequested.value) {
        await checkStopRequested(ctx);
        return;
      }
      await handleBlockedTasks(ctx);
      await launchReadyTasks(ctx);
      await writeProgress(ctx);
      if (await checkCompletion(ctx)) return;
      if (await checkFailure(ctx)) return;
      const wakeController = new AbortController();
      const timer = delay(MAX_WAKEUP_INTERVAL_MS, undefined, { signal: wakeController.signal }).catch(() => {});
      await Promise.race([ctx.wakeup.promise, timer]);
      wakeController.abort();
    }
  } finally {
    ctx.stopRequested.value = true;
    triggerWakeup(ctx);
    pollController.abort();
    await stopPoller.catch(() => {});
    for (const handle of ctx.activeWorkers.values()) {
      await safeDisposeAgent(handle.sdkAgent);
    }
  }
}

export async function runOrchestration(runId: string, agentClient: AgentClient, repoStore: RepoStoreClient): Promise<void> {
  const configStr = await repoStore.readFile(runId, "config.yaml");
  let config = parseConfig(configStr);
  config = canonicalizeOrchestratorConfig(config);

  const apiKey = process.env.CURSOR_API_KEY ?? "";
  const ghToken = process.env.GH_TOKEN ?? "";

  let planningRan = false;
  let planningOk = false;
  if (config.prompt && !config.tasks.length) {
    planningRan = true;
    const planContent = await repoStore.readFile(runId, "task-plan.json");
    if (planContent) {
      try {
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
      planningOk = await runPlanningPhase(config, runId, agentClient, repoStore, apiKey);
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
  const ctx: LoopContext = {
    state,
    config,
    graph,
    agentClient,
    repoStore,
    runId,
    apiKey,
    ghToken,
    activeWorkers: new Map(),
    dirty: { value: true },
    wakeup: createWakeup(),
    stopRequested: { value: false },
  };

  try {
    await reattachWorkers(ctx);
    await orchestrationLoop(ctx);
  } catch (exc) {
    console.error("Orchestration loop failed", exc);
    await persistUnexpectedFailure(state, repoStore, runId, exc);
    throw exc;
  }
  if (state.status === "failed") {
    throw new Error(state.error ? `Orchestration failed: ${state.error}` : "Orchestration failed");
  }
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
  const agentClient = createDefaultAgentClient(secrets.CURSOR_API_KEY);
  const repoStore = new RepoStoreClient(secrets.GH_TOKEN, bootstrapOwner, bootstrapRepo);
  await runOrchestration(runId, agentClient, repoStore);
}
