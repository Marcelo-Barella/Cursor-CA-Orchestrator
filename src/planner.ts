import { jsonrepair } from "jsonrepair";
import type { DelegationGroupConfig, DelegationMapConfig, DelegationPhaseConfig, OrchestratorConfig, TaskConfig } from "./config/types.js";
import { PLANNER_SYSTEM_PROMPT } from "./system-prompt.js";
import type { RepoStoreClient } from "./api/repo-store.js";
import { setTimeout as delay } from "node:timers/promises";

const PLANNER_PROMPT_TEMPLATE = `You are a task planner for a multi-repository orchestration system.

## User Request

{prompt}

## Available Repositories

{repo_list}
 
## Instructions

Analyze the user request above and decompose it into concrete, actionable tasks. \
Each task targets exactly one repository. Respect repository boundaries: create \
one task per repository per concern. Tasks may declare dependencies on other tasks \
by referencing their IDs.

Produce a JSON task plan with the following structure and write it to the run branch as \
a file named \`task-plan.json\`.

### Output Format

\`\`\`json
{
  "delegation_map": {
    "version": 1,
    "phases": [
      {
        "id": "<phase-id>",
        "parallel_groups": [
          {
            "id": "<group-id>",
            "tasks": ["<task-id>", "..."]
          }
        ]
      }
    ]
  },
  "tasks": [
    {
      "id": "<unique-kebab-case-id>",
      "repo": "<repository-alias-from-list-above-or-__new__>",
      "prompt": "<detailed-instructions-for-the-agent-working-on-this-task>",
      "depends_on": ["<task-id>", ...],
      "timeout_minutes": <integer>,
      "create_repo": false,
      "repo_config": null
    }
  ]
}
\`\`\`

The \`delegation_map\` must include all tasks exactly once unless there is a clear reason to omit a task from phased launch control.

## Dynamic Repository Creation

When the user request requires creating new GitHub repositories, emit tasks with the \
following conventions:

1. Set \`"create_repo": true\` and provide \`"repo_config": {"url_template": \
"https://github.com/{owner}/{repo_name}", "ref": "main"}\` in the task JSON.

2. Repo-creation tasks must use \`"repo": "__new__"\` (sentinel value). The prompt \
should instruct the agent to: (1) create the GitHub repo via the GitHub REST API \
(POST https://api.github.com/user/repos with \`Authorization: token <GH_TOKEN>\`), \
(2) clone it using token-based HTTPS auth and initialize it with the requested stack, \
and (3) report the repo URL in outputs as \`{"repo_url": "https://github.com/..."}\`. \
Cursor Agents have access to the \`gh\` CLI for GitHub operations.

3. Implementation tasks that depend on a newly created repo should declare \
\`depends_on\` referencing the creation task and use \`"repo": "__new__"\`. The \
orchestrator will resolve the actual repo URL from upstream task outputs.

### Rules

- \`id\` must be unique across all tasks and use kebab-case (e.g. \`add-auth-backend\`).
- \`repo\` must exactly match one of the GitHub repository URLs listed above (same string as shown).
- \`prompt\` must contain enough detail for an autonomous agent to complete the task \
without additional context.
- \`depends_on\` is a list of task IDs that must complete before this task starts. \
Use an empty list if there are no dependencies.
- \`timeout_minutes\` is the estimated maximum time for the task (default 30).
- Do NOT create circular dependencies.
- Maximum 20 tasks.
- For tasks targeting the same repository, do not claim unsafe parallel independence. \
If two tasks can conflict, serialize them with \`depends_on\` and place them in separate phases or groups.
- Use \`delegation_map.phases[].parallel_groups[].tasks\` to express safe launch waves. \
Only place tasks in the same parallel group when they are truly safe to run together.

### Output Write Instructions

Write the JSON output as a file named \`task-plan.json\` to the run branch of the bootstrap repo.

Use the \`gh\` CLI with the GitHub Contents API:
\`\`\`bash
CONTENT=$(cat {plan_tmp_path} | base64 -w 0)
GH_TOKEN="{gh_token}" gh api --method PUT /repos/{bootstrap_owner}/{bootstrap_repo}/contents/task-plan.json \\
  --field message="write task-plan.json" \\
  --field content="$CONTENT" \\
  --field branch="run/{run_id}"
\`\`\`
`;

export function buildPlannerPrompt(
  config: OrchestratorConfig,
  runId: string,
  ghToken: string,
  bootstrapOwner: string,
  bootstrapRepo: string,
): string {
  const planTmpPath = `/tmp/cursor-orch-${runId}-task-plan.json`;
  const repoLines: string[] = [];
  for (const [key, repo] of Object.entries(config.repositories)) {
    if (key === "__bootstrap__") continue;
    repoLines.push(`- \`${repo.url}\` (ref: \`${repo.ref}\`)`);
  }
  const repoList = repoLines.join("\n");
  const body = PLANNER_PROMPT_TEMPLATE.replace("{prompt}", config.prompt)
    .replace("{repo_list}", repoList)
    .replace("{run_id}", runId)
    .replace("{gh_token}", ghToken)
    .replace("{plan_tmp_path}", planTmpPath)
    .replace("{bootstrap_owner}", bootstrapOwner)
    .replace("{bootstrap_repo}", bootstrapRepo);
  return `${PLANNER_SYSTEM_PROMPT}\n\n${body}`;
}

function extractJson(raw: string): string {
  const stripped = raw.replace(/```(?:json)?\s*\n?/g, "").trim();
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    /* continue */
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return raw.slice(start, end + 1);
  }
  return raw;
}

const CREATE_PREFIXES = ["create-", "setup-", "init-", "new-", "bootstrap-"];
const CREATE_SUFFIXES = ["-scaffold", "-repo", "-setup", "-init", "-bootstrap", "-create", "-new"];

function stripCreatePrefix(name: string): string {
  for (const p of CREATE_PREFIXES) {
    if (name.startsWith(p)) {
      return name.slice(p.length);
    }
  }
  return name;
}

function stripCreateSuffix(name: string): string {
  for (const s of CREATE_SUFFIXES) {
    if (name.endsWith(s)) {
      return name.slice(0, -s.length);
    }
  }
  return name;
}

function matchCreateRepoByName(taskId: string, createRepoTaskIds: Set<string>): string | null {
  const taskBase = stripCreatePrefix(taskId);
  const candidates: string[] = [];
  for (const cid of createRepoTaskIds) {
    const createBase = stripCreateSuffix(stripCreatePrefix(cid));
    if (createBase === taskBase) {
      candidates.push(cid);
      continue;
    }
    if (taskBase.startsWith(`${createBase}-`) || createBase.startsWith(`${taskBase}-`)) {
      candidates.push(cid);
    }
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  return null;
}

function collectUpstreamCreateRepoIds(
  task: TaskConfig,
  taskById: Record<string, TaskConfig>,
  createRepoTaskIds: Set<string>,
): Set<string> {
  const upstream = new Set<string>();
  const stack = [...task.depends_on];
  const visited = new Set<string>();
  while (stack.length) {
    const depId = stack.pop()!;
    if (visited.has(depId)) continue;
    visited.add(depId);
    if (createRepoTaskIds.has(depId)) {
      upstream.add(depId);
      continue;
    }
    const depTask = taskById[depId];
    if (!depTask) continue;
    stack.push(...depTask.depends_on);
  }
  return upstream;
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

function resolveRepoAlias(
  requestedRepo: string,
  repositories: Record<string, { url: string; ref: string }>,
  tokenIndex: Map<string, Set<string>>,
): string | null {
  if (requestedRepo in repositories) {
    return requestedRepo;
  }
  const matches = tokenIndex.get(normalizeRepoToken(requestedRepo));
  if (!matches || matches.size !== 1) {
    return null;
  }
  return [...matches][0] ?? null;
}

function parseDelegationMap(rawMap: unknown, taskIds: Set<string>): DelegationMapConfig | null {
  if (rawMap === undefined || rawMap === null) {
    return null;
  }
  if (typeof rawMap !== "object") {
    throw new Error("'delegation_map' must be an object");
  }
  const mapObj = rawMap as Record<string, unknown>;
  if (!("phases" in mapObj) || mapObj.phases === undefined || mapObj.phases === null) {
    return null;
  }
  if (!Array.isArray(mapObj.phases)) {
    throw new Error("'delegation_map.phases' must be a list");
  }
  const assignedTaskIds = new Set<string>();
  const phases: DelegationPhaseConfig[] = [];
  let phaseIndex = 0;
  for (const phase of mapObj.phases) {
    phaseIndex += 1;
    if (typeof phase !== "object" || phase === null) {
      throw new Error("Each delegation phase must be an object");
    }
    const phaseObj = phase as Record<string, unknown>;
    if (!("id" in phaseObj) || typeof phaseObj.id !== "string" || !phaseObj.id.trim()) {
      throw new Error("Each delegation phase must have a non-empty string 'id'");
    }
    const rawGroups = phaseObj.parallel_groups ?? phaseObj.parallelGroups ?? phaseObj.groups;
    if (!Array.isArray(rawGroups)) {
      throw new Error(`Delegation phase '${phaseObj.id}' must include 'parallel_groups' as a list`);
    }
    const groups: DelegationGroupConfig[] = [];
    let groupIndex = 0;
    for (const group of rawGroups) {
      groupIndex += 1;
      if (typeof group !== "object" || group === null) {
        throw new Error(`Each parallel group in phase '${phaseObj.id}' must be an object`);
      }
      const groupObj = group as Record<string, unknown>;
      if (!("id" in groupObj) || typeof groupObj.id !== "string" || !groupObj.id.trim()) {
        throw new Error(`Each parallel group in phase '${phaseObj.id}' must have a non-empty string 'id'`);
      }
      const rawTasks = groupObj.tasks ?? groupObj.task_ids ?? groupObj.taskIds;
      if (!Array.isArray(rawTasks)) {
        throw new Error(`Parallel group '${groupObj.id}' in phase '${phaseObj.id}' must include 'tasks' as a list`);
      }
      const taskIdsInGroup: string[] = [];
      for (const taskId of rawTasks) {
        if (typeof taskId !== "string" || !taskId.trim()) {
          throw new Error(`Parallel group '${groupObj.id}' in phase '${phaseObj.id}' contains an invalid task id`);
        }
        if (!taskIds.has(taskId)) {
          throw new Error(`Delegation map references unknown task '${taskId}'. Valid IDs: ${[...taskIds].sort().join(", ")}`);
        }
        if (assignedTaskIds.has(taskId)) {
          throw new Error(`Delegation map assigns task '${taskId}' more than once`);
        }
        assignedTaskIds.add(taskId);
        taskIdsInGroup.push(taskId);
      }
      groups.push({ id: String(groupObj.id).trim() || `group-${groupIndex}`, task_ids: taskIdsInGroup });
    }
    phases.push({ id: String(phaseObj.id).trim() || `phase-${phaseIndex}`, groups });
  }
  return { phases };
}

export function parseTaskPlan(planJson: string, config: OrchestratorConfig): TaskConfig[] {
  let data: unknown;
  try {
    data = JSON.parse(planJson);
  } catch {
    const cleaned = extractJson(planJson);
    try {
      data = JSON.parse(cleaned);
    } catch {
      const repaired = jsonrepair(cleaned);
      data = JSON.parse(repaired);
    }
  }
  if (typeof data !== "object" || data === null || !("tasks" in data)) {
    throw new Error("Task plan must be a JSON object with a 'tasks' key");
  }
  const planObject = data as { tasks: unknown; delegation_map?: unknown; delegationMap?: unknown };
  const rawTasks = planObject.tasks;
  if (!Array.isArray(rawTasks)) {
    throw new Error("'tasks' must be a list");
  }
  const taskIds = new Set<string>();
  const tasks: TaskConfig[] = [];
  const repoTokenIndex = buildRepoTokenIndex(config.repositories);
  for (const entry of rawTasks) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Each task must be a JSON object, got ${typeof entry}`);
    }
    const o = entry as Record<string, unknown>;
    for (const required of ["id", "repo", "prompt"]) {
      if (!(required in o)) {
        throw new Error(`Task missing required field '${required}': ${JSON.stringify(entry)}`);
      }
    }
    const taskId = String(o.id);
    if (taskIds.has(taskId)) {
      throw new Error(`Duplicate task ID: ${taskId}`);
    }
    taskIds.add(taskId);
    const requestedRepoAlias = String(o.repo);
    const isCreateRepo = Boolean(o.create_repo);
    const resolvedRepoAlias =
      requestedRepoAlias === "__new__" || isCreateRepo
        ? requestedRepoAlias
        : resolveRepoAlias(requestedRepoAlias, config.repositories, repoTokenIndex);
    if (requestedRepoAlias !== "__new__" && !isCreateRepo && !resolvedRepoAlias) {
      throw new Error(
        `Task '${taskId}' references unknown repository '${requestedRepoAlias}'. Valid repository URLs: ${Object.keys(config.repositories)
          .filter((k) => k !== "__bootstrap__")
          .sort()
          .join(", ")}`,
      );
    }
    const dependsOn = Array.isArray(o.depends_on) ? (o.depends_on as string[]) : [];
    const timeout = typeof o.timeout_minutes === "number" ? o.timeout_minutes : 30;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error(`Task '${taskId}': 'timeout_minutes' must be a positive integer`);
    }
    tasks.push({
      id: taskId,
      repo: resolvedRepoAlias ?? requestedRepoAlias,
      prompt: String(o.prompt),
      model: o.model !== undefined ? String(o.model) : null,
      depends_on: dependsOn,
      timeout_minutes: timeout,
      create_repo: Boolean(o.create_repo),
      repo_config: (o.repo_config as Record<string, unknown>) ?? null,
    });
  }
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        throw new Error(`Task '${task.id}' depends on unknown task '${dep}'. Valid IDs: ${[...taskIds].sort().join(", ")}`);
      }
    }
  }
  const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const createRepoTaskIds = new Set(tasks.filter((t) => t.create_repo).map((t) => t.id));
  for (const task of tasks) {
    if (task.repo === "__new__" && !task.create_repo) {
      const hasCreateDep = task.depends_on.some((dep) => createRepoTaskIds.has(dep));
      if (hasCreateDep) continue;
      const upstreamCreateDeps = collectUpstreamCreateRepoIds(task, taskById, createRepoTaskIds);
      if (upstreamCreateDeps.size === 1) {
        task.depends_on.push([...upstreamCreateDeps][0]!);
        continue;
      }
      if (createRepoTaskIds.size === 1) {
        task.depends_on.push([...createRepoTaskIds][0]!);
        continue;
      }
      if (createRepoTaskIds.size === 0) {
        throw new Error(
          `Task '${task.id}' uses '__new__' but no create_repo task exists in the plan. The planner must include a task with 'create_repo: true' for new repositories.`,
        );
      }
      const matched = matchCreateRepoByName(task.id, createRepoTaskIds);
      if (matched) {
        task.depends_on.push(matched);
        continue;
      }
      throw new Error(
        `Task '${task.id}' uses '__new__' but could not be matched to any of the ${createRepoTaskIds.size} create_repo tasks: ${[...createRepoTaskIds].sort().join(", ")}. Add an explicit 'depends_on' referencing the correct create_repo task.`,
      );
    }
  }
  config.delegation_map = parseDelegationMap(planObject.delegation_map ?? planObject.delegationMap, taskIds);
  return tasks;
}

export async function waitForPlan(repoStore: RepoStoreClient, runId: string, timeoutSec = 600, pollIntervalSec = 15): Promise<string | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const content = await repoStore.readFile(runId, "task-plan.json");
    if (content) {
      return content;
    }
    const remaining = deadline - Date.now();
    await delay(Math.min(pollIntervalSec * 1000, Math.max(0, remaining)));
  }
  return null;
}
