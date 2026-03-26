import type { OrchestratorConfig, TaskConfig } from "./types.js";

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

export function validateRepoRefs(tasks: TaskConfig[], repositories: Record<string, { url: string; ref: string }>): void {
  const repoTokenIndex = buildRepoTokenIndex(repositories);
  for (const task of tasks) {
    if (task.create_repo) continue;
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
  validateBranchName(config.target.branch_prefix, "branch_prefix");
  for (const task of config.tasks) {
    validateBranchName(task.id, `task_id '${task.id}'`);
    const combined = `${config.target.branch_prefix}/${task.id}`;
    validateBranchName(combined, `branch name '${combined}'`);
  }
}

export function validateConfig(config: OrchestratorConfig): void {
  if (!config.prompt && config.tasks.length === 0) {
    throw new Error("Config must specify either 'prompt' or 'tasks'");
  }
  validateBranchName(config.target.branch_prefix, "branch_prefix");
  if (config.prompt && config.tasks.length === 0) {
    return;
  }
  validateTaskCount(config.tasks);
  const taskIds = validateUniqueIds(config.tasks);
  validateRepoRefs(config.tasks, config.repositories);
  validateDepRefs(config.tasks, taskIds);
  const cycle = detectCycle(config.tasks);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle}`);
  }
  validateBranchNames(config);
}
