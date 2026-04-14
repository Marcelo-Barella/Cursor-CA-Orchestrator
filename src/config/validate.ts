import type { BranchLayout, DelegationMapConfig, OrchestratorConfig, TaskConfig } from "./types.js";
import { resolveRepoTarget } from "../lib/repo-target.js";

const BRANCH_LAYOUT_VALUES = new Set<BranchLayout>(["consolidated", "per_task"]);

function validateBranchLayout(layout: string): asserts layout is BranchLayout {
  if (!BRANCH_LAYOUT_VALUES.has(layout as BranchLayout)) {
    throw new Error(`target.branch_layout must be 'consolidated' or 'per_task', got '${layout}'`);
  }
}

const BRANCH_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$/;

function validateBranchName(name: string, label: string): void {
  if (!BRANCH_NAME_RE.test(name)) {
    throw new Error(`${label} '${name}' does not match pattern: ^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$`);
  }
}

function detectCycle(tasks: TaskConfig[]): string | null {
  const adj: Record<string, string[]> = {};
  for (const t of tasks) {
    adj[t.id] = [...t.depends_on];
  }
  const visited = new Set<string>();
  const inStack = new Set<string>();
  for (const t of tasks) {
    if (!visited.has(t.id)) {
      const r = dfsFrom(t.id, adj, visited, inStack);
      if (r) return r;
    }
  }
  return null;
}

function dfsFrom(root: string, adj: Record<string, string[]>, visited: Set<string>, inStack: Set<string>): string | null {
  const stack: [string, number][] = [[root, 0]];
  while (stack.length) {
    const result = dfsStep(stack, adj, visited, inStack);
    if (result) return result;
  }
  return null;
}

function dfsStep(stack: [string, number][], adj: Record<string, string[]>, visited: Set<string>, inStack: Set<string>): string | null {
  const [node, idx] = stack[stack.length - 1]!;
  if (idx === 0) {
    visited.add(node);
    inStack.add(node);
  }
  const deps = adj[node] ?? [];
  if (idx < deps.length) {
    stack[stack.length - 1] = [node, idx + 1];
    const dep = deps[idx]!;
    if (inStack.has(dep)) {
      return `${node} -> ${dep}`;
    }
    if (!visited.has(dep)) {
      stack.push([dep, 0]);
    }
    return null;
  }
  inStack.delete(node);
  stack.pop();
  return null;
}

function validateTaskCount(tasks: TaskConfig[]): void {
  if (tasks.length > 20) {
    throw new Error(`Maximum 20 tasks allowed, got ${tasks.length}`);
  }
}

function validateUniqueIds(tasks: TaskConfig[]): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task ID: ${task.id}`);
    }
    ids.add(task.id);
  }
  return ids;
}

function normalizeRepoToken(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

function extractRepoName(value: string): string | null {
  const normalized = normalizeRepoToken(value);
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;
  return parts[parts.length - 1] ?? null;
}

function addRepoTokenIndex(tokenIndex: Map<string, Set<string>>, token: string | null, alias: string): void {
  if (!token) return;
  if (!tokenIndex.has(token)) {
    tokenIndex.set(token, new Set<string>());
  }
  tokenIndex.get(token)!.add(alias);
}

function buildRepoTokenIndex(repositories: Record<string, { url: string; ref: string }>): Map<string, Set<string>> {
  const tokenIndex = new Map<string, Set<string>>();
  for (const [alias, repo] of Object.entries(repositories)) {
    addRepoTokenIndex(tokenIndex, normalizeRepoToken(alias), alias);
    addRepoTokenIndex(tokenIndex, extractRepoName(alias), alias);
    addRepoTokenIndex(tokenIndex, normalizeRepoToken(repo.url), alias);
    addRepoTokenIndex(tokenIndex, extractRepoName(repo.url), alias);
  }
  return tokenIndex;
}

function validateRepositoryResolvableUrls(repositories: Record<string, { url: string; ref: string }>): void {
  for (const [alias, rc] of Object.entries(repositories)) {
    const resolved = resolveRepoTarget(rc.url, repositories, rc.ref);
    if (!resolved) {
      throw new Error(
        `repositories entry '${alias}' has url '${rc.url}' that cannot be resolved to a GitHub repository (use https://github.com/owner/repo or owner/repo)`,
      );
    }
  }
}

export function validateRepoRefs(tasks: TaskConfig[], repositories: Record<string, { url: string; ref: string }>): void {
  const repoTokenIndex = buildRepoTokenIndex(repositories);
  for (const task of tasks) {
    if (task.create_repo || task.repo === "__new__") continue;
    if (task.repo in repositories) continue;
    const matches = repoTokenIndex.get(normalizeRepoToken(task.repo));
    if (!matches || matches.size !== 1) {
      throw new Error(`Task '${task.id}' references unknown repository '${task.repo}'`);
    }
  }
}

function validateDepRefs(tasks: TaskConfig[], taskIds: Set<string>): void {
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        throw new Error(`Task '${task.id}' depends on unknown task '${dep}'`);
      }
    }
  }
}

function validateBranchNames(config: OrchestratorConfig): void {
  for (const task of config.tasks) {
    validateBranchName(task.id, `task_id '${task.id}'`);
    if (config.target.branch_layout === "per_task") {
      const combined = `${config.target.branch_prefix}/${task.id}`;
      validateBranchName(combined, `branch name '${combined}'`);
    }
  }
}

export function canonicalRepoAliasForTask(task: TaskConfig, repositories: Record<string, { url: string; ref: string }>): string | null {
  if (task.create_repo) {
    return null;
  }
  if (task.repo in repositories) {
    return task.repo;
  }
  const repoTokenIndex = buildRepoTokenIndex(repositories);
  const matches = repoTokenIndex.get(normalizeRepoToken(task.repo));
  if (!matches || matches.size !== 1) {
    return null;
  }
  return [...matches][0]!;
}

function validateRunLineForConsolidated(config: OrchestratorConfig): void {
  if (config.target.branch_layout !== "consolidated" || !config.target.consolidate_prs) {
    return;
  }
  const byAlias = new Map<string, TaskConfig[]>();
  for (const task of config.tasks) {
    const alias = canonicalRepoAliasForTask(task, config.repositories);
    if (!alias) {
      continue;
    }
    if (!byAlias.has(alias)) {
      byAlias.set(alias, []);
    }
    byAlias.get(alias)!.push(task);
  }
  for (const [alias, groupTasks] of byAlias) {
    if (groupTasks.length <= 1) {
      continue;
    }
    if (!config.delegation_map) {
      throw new Error(
        `Run-line workflow requires delegation_map when multiple tasks target repository '${alias}' (consolidated + consolidate_prs); serialize them in separate parallel_groups`,
      );
    }
    const assigned = new Map<string, { phaseIndex: number; groupIndex: number }>();
    for (const [phaseIndex, phase] of config.delegation_map.phases.entries()) {
      for (const [groupIndex, g] of phase.groups.entries()) {
        for (const taskId of g.task_ids) {
          assigned.set(taskId, { phaseIndex, groupIndex });
        }
      }
    }
    const placements: { taskId: string; phaseIndex: number; groupIndex: number }[] = [];
    for (const t of groupTasks) {
      const p = assigned.get(t.id);
      if (!p) {
        throw new Error(`delegation_map must assign task '${t.id}' for run-line repo '${alias}'`);
      }
      placements.push({ taskId: t.id, phaseIndex: p.phaseIndex, groupIndex: p.groupIndex });
    }
    placements.sort((a, b) => (a.phaseIndex !== b.phaseIndex ? a.phaseIndex - b.phaseIndex : a.groupIndex - b.groupIndex));
    for (let i = 1; i < placements.length; i += 1) {
      const prev = placements[i - 1]!;
      const cur = placements[i]!;
      if (prev.phaseIndex === cur.phaseIndex && prev.groupIndex === cur.groupIndex) {
        throw new Error(
          `Run-line workflow: tasks '${prev.taskId}' and '${cur.taskId}' both target repo '${alias}' in the same parallel group; move one to a later group`,
        );
      }
    }
  }
}

function validateDelegationMap(
  delegationMap: DelegationMapConfig,
  tasks: TaskConfig[],
  taskIds: Set<string>,
): void {
  if (!Array.isArray(delegationMap.phases) || delegationMap.phases.length === 0) {
    throw new Error("delegation_map must define a non-empty 'phases' array");
  }
  const phaseIds = new Set<string>();
  const assignedTasks = new Map<string, { phaseId: string; groupId: string; phaseIndex: number; groupIndex: number }>();
  for (const [phaseIndex, phase] of delegationMap.phases.entries()) {
    if (!phase.id || typeof phase.id !== "string") {
      throw new Error(`delegation_map phase at index ${phaseIndex} must define a non-empty 'id'`);
    }
    if (phaseIds.has(phase.id)) {
      throw new Error(`delegation_map has duplicate phase id '${phase.id}'`);
    }
    phaseIds.add(phase.id);
    if (!Array.isArray(phase.groups) || phase.groups.length === 0) {
      throw new Error(`delegation_map phase '${phase.id}' must define a non-empty 'groups' array`);
    }
    const groupIds = new Set<string>();
    for (const [groupIndex, group] of phase.groups.entries()) {
      if (!group.id || typeof group.id !== "string") {
        throw new Error(`delegation_map phase '${phase.id}' group at index ${groupIndex} must define a non-empty 'id'`);
      }
      if (groupIds.has(group.id)) {
        throw new Error(`delegation_map phase '${phase.id}' has duplicate group id '${group.id}'`);
      }
      groupIds.add(group.id);
      if (!Array.isArray(group.task_ids) || group.task_ids.length === 0) {
        throw new Error(`delegation_map phase '${phase.id}' group '${group.id}' must define a non-empty 'task_ids' array`);
      }
      const inGroup = new Set<string>();
      for (const taskId of group.task_ids) {
        if (!taskIds.has(taskId)) {
          throw new Error(`delegation_map phase '${phase.id}' group '${group.id}' references unknown task '${taskId}'`);
        }
        if (inGroup.has(taskId)) {
          throw new Error(`delegation_map phase '${phase.id}' group '${group.id}' repeats task '${taskId}'`);
        }
        inGroup.add(taskId);
        if (assignedTasks.has(taskId)) {
          const previous = assignedTasks.get(taskId)!;
          throw new Error(
            `delegation_map task '${taskId}' appears multiple times: '${previous.phaseId}/${previous.groupId}' and '${phase.id}/${group.id}'`,
          );
        }
        assignedTasks.set(taskId, { phaseId: phase.id, groupId: group.id, phaseIndex, groupIndex });
      }
    }
  }

  if (assignedTasks.size !== taskIds.size) {
    const missingTaskIds: string[] = [];
    for (const taskId of taskIds) {
      if (!assignedTasks.has(taskId)) missingTaskIds.push(taskId);
    }
    throw new Error(`delegation_map must assign every task exactly once; missing: ${missingTaskIds.join(", ")}`);
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const [taskId, assignment] of assignedTasks.entries()) {
    const task = taskById.get(taskId);
    if (!task) {
      continue;
    }
    for (const depId of task.depends_on) {
      const depAssignment = assignedTasks.get(depId);
      if (!depAssignment) {
        continue;
      }
      if (depAssignment.phaseIndex > assignment.phaseIndex) {
        throw new Error(
          `delegation_map impossible ordering: task '${taskId}' in phase '${assignment.phaseId}' depends on '${depId}' in later phase '${depAssignment.phaseId}'`,
        );
      }
      if (depAssignment.phaseIndex === assignment.phaseIndex && depAssignment.groupIndex > assignment.groupIndex) {
        throw new Error(
          `delegation_map impossible ordering: task '${taskId}' in '${assignment.phaseId}/${assignment.groupId}' depends on '${depId}' in later parallel group '${depAssignment.groupId}'`,
        );
      }
    }
  }
}

export function validateConfig(config: OrchestratorConfig): void {
  if (!config.prompt && config.tasks.length === 0) {
    throw new Error("Config must specify either 'prompt' or 'tasks'");
  }
  validateBranchName(config.target.branch_prefix, "branch_prefix");
  validateBranchLayout(config.target.branch_layout);
  if (Object.keys(config.repositories).length > 0) {
    validateRepositoryResolvableUrls(config.repositories);
  }
  if (config.prompt && config.tasks.length === 0) {
    return;
  }
  validateTaskCount(config.tasks);
  const taskIds = validateUniqueIds(config.tasks);
  validateRepoRefs(config.tasks, config.repositories);
  validateDepRefs(config.tasks, taskIds);
  if (config.delegation_map) {
    validateDelegationMap(config.delegation_map, config.tasks, taskIds);
  }
  const cycle = detectCycle(config.tasks);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle}`);
  }
  validateBranchNames(config);
  validateRunLineForConsolidated(config);
}
