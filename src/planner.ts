import { jsonrepair } from "jsonrepair";
import type {
  DelegationGroupConfig,
  DelegationMapConfig,
  DelegationPhaseConfig,
  InventoryManifestV1,
  OrchestratorConfig,
  TaskConfig,
} from "./config/types.js";
import { PLANNER_SYSTEM_PROMPT } from "./system-prompt.js";
import type { RepoStoreClient } from "./api/repo-store.js";
import { setTimeout as delay } from "node:timers/promises";

const PLANNER_PROMPT_TEMPLATE = `You are a task planner for a multi-repository orchestration system.

## User Request

{prompt}

{inventory_block}## Available Repositories

{repo_list}
 
## Instructions

Analyze the user request above and decompose it into concrete, actionable tasks. \
Each task targets exactly one repository. Respect repository boundaries: create \
one task per repository per concern. Tasks may declare dependencies on other tasks \
by referencing their IDs.

**Full product default:** Unless the user request contains explicit scoping that narrows work (MVP, prototype, phase, "only", "just", "later", etc.), the plan must cover a complete application stack: do not return only a UI or only a backend when the user described a system that needs many layers. **Layer deferrals** come only from the inventory's \`explicit_deferrals\` or directly from the user request -- never from an invented "MVP" label.

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
      "repo": "<repository-alias-from-list-above-or-__new__-or-create_repo-task-id>",
      "prompt": "<detailed-instructions-for-the-agent-working-on-this-task>",
      "depends_on": ["<task-id>", ...],
      "timeout_minutes": <integer>,
      "create_repo": false,
      "repo_config": null
    }
  ]
}
\`\`\`

### Delegation map

If you include \`delegation_map\`, the orchestrator runs **ordered waves**: \`phases\` run in array order; within each phase, \`parallel_groups\` run in array order. The next group does not start until every task in the current group has a terminal status (finished, failed, or stopped). Tasks in the same group may run together when \`depends_on\` allows. When several tasks in the same group are ready at once, launch order among them is not guaranteed; use \`depends_on\` if you need a strict sequence.

**Coverage:** list every task \`id\` from \`tasks\` **exactly once** in the map. A task ID left out of the map is not launched while any mapped wave is active; it only becomes eligible after **all** mapped phase/group waves complete, which is usually wrong for the plan.

**Dependencies vs waves:** a task may depend only on tasks in the **same** parallel group or an **earlier** group in map order (an earlier group in the same phase, or any group in an earlier phase). Config validation rejects before scheduling starts if a dependency points to a task in a later phase or a later parallel group in the same phase.

**Parallelism defaults:** maximize concurrent workers. Tasks on **different** repositories that are independent (no shared-artifact need, no required step order) should default to the **same** \`parallel_group\` in the **earliest** wave where their existing \`depends_on\` allow — one wave should often hold all cross-repo work for that layer. Add extra \`parallel_groups\` or \`phases\` only when you need later waves for **same-repo serialization** under consolidated PR (multiple tasks on one canonical repo must sit in **different** groups so pushes use one run branch in order), for **real ordering** correctness requires, or for **shared artifacts** (a task must consume another task output, URL, schema, or contract — use \`depends_on\` and keep map order consistent). Do not add \`depends_on\` or extra groups solely to serialize unrelated cross-repo work.

**Conflicts:** do not put the same task ID in more than one group. For the same canonical repository under consolidated PR mode, the runtime requires each task touching that repo to sit in a **different** \`parallel_group\` so agents push sequentially to one shared run branch; use \`depends_on\` when semantic order matters within or across those waves. For other same-repo conflicts, also separate groups and use \`depends_on\` as needed; keep unrelated different-repo tasks together in one group when \`depends_on\` allows.

## Dynamic Repository Creation

When the user request requires creating new GitHub repositories, emit tasks with the \
following conventions:

1. Set \`"create_repo": true\` and provide \`"repo_config": {"url_template": \
"https://github.com/{owner}/{repo_name}", "ref": "main"}\` in the task JSON.

2. Repo-creation tasks must use \`"repo": "__new__"\` (sentinel value). The prompt \
should instruct the agent to: (1) create the GitHub repo with \`gh repo create\` or \`gh api\` (credentials are preconfigured; do not put tokens in prompts or URLs), \
(2) clone it with \`gh repo clone <owner>/<repo>\` or \`git clone https://github.com/<owner>/<repo>.git\` and initialize it with the requested stack, \
and (3) report the repo URL in outputs as \`{"repo_url": "https://github.com/..."}\`. \
Cursor Agents have access to the \`gh\` CLI for GitHub operations.

3. Implementation tasks for a newly created repo must identify **which** new repo: set \
\`"repo"\` to the **task id** of the corresponding \`create_repo\` task (same string as that task's \`id\`), \
or use \`"repo": "__new__"\` together with \`depends_on\` listing that creation task. \
Do not rely on naming patterns; the creation task \`id\` is the stable handle. The \
orchestrator resolves the actual repo URL from upstream task outputs.

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
- Use \`delegation_map.phases[].parallel_groups[].tasks\` for launch waves; default independent different-repo tasks into the **same** group when \`depends_on\` allows; reserve extra groups or dependencies for same-repo serialization, ordering, or shared outputs.

### Output Write Instructions

Write the JSON output as a file named \`task-plan.json\` to the run branch of the bootstrap repo.

Use the \`gh\` CLI with the GitHub Contents API (credentials are preconfigured; do not export \`GH_TOKEN\` in the shell):
\`\`\`bash
CONTENT=$(cat {plan_tmp_path} | base64 -w 0)
gh api --method PUT /repos/{bootstrap_owner}/{bootstrap_repo}/contents/task-plan.json \\
  --field message="write task-plan.json" \\
  --field content="$CONTENT" \\
  --field branch="run/{run_id}"
\`\`\`
`;

function formatInventoryBlock(m: InventoryManifestV1): string {
  const copy: Record<string, unknown> = { ...m };
  return `## Inventory\n\nThe following inventory manifest is authoritative for which product layers and integrations this plan must cover. User-declared fields win over any discovered data when they conflict. \`source\` is ${m.source}.\n\n\`\`\`json\n${JSON.stringify(copy, null, 2)}\n\`\`\`\n\n`;
}

export function buildPlannerPrompt(
  config: OrchestratorConfig,
  runId: string,
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
  const inventoryBlock = config.inventory ? formatInventoryBlock(config.inventory) : "";
  const body = PLANNER_PROMPT_TEMPLATE.replace("{prompt}", config.prompt)
    .replace("{inventory_block}", inventoryBlock)
    .replace("{repo_list}", repoList)
    .replace("{run_id}", runId)
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
  const createRepoTaskIdsFromPlan = new Set<string>();
  for (const entry of rawTasks) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (Boolean(o.create_repo) && String(o.repo) === "__new__") {
      createRepoTaskIdsFromPlan.add(String(o.id));
    }
  }
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
    let resolvedRepoAlias: string | undefined;
    let implicitCreateDep: string | null = null;
    if (isCreateRepo) {
      if (requestedRepoAlias !== "__new__") {
        throw new Error(`Task '${taskId}' with create_repo must use "repo": "__new__"`);
      }
      resolvedRepoAlias = requestedRepoAlias;
    } else if (requestedRepoAlias === "__new__") {
      resolvedRepoAlias = "__new__";
    } else {
      const resolved = resolveRepoAlias(requestedRepoAlias, config.repositories, repoTokenIndex);
      if (resolved) {
        resolvedRepoAlias = resolved;
      } else if (createRepoTaskIdsFromPlan.has(requestedRepoAlias)) {
        resolvedRepoAlias = "__new__";
        implicitCreateDep = requestedRepoAlias;
      } else {
        throw new Error(
          `Task '${taskId}' references unknown repository '${requestedRepoAlias}'. Valid repository URLs: ${Object.keys(config.repositories)
            .filter((k) => k !== "__bootstrap__")
            .sort()
            .join(", ")}`,
        );
      }
    }
    const dependsOn = Array.isArray(o.depends_on) ? [...(o.depends_on as string[])] : [];
    if (implicitCreateDep && !dependsOn.includes(implicitCreateDep)) {
      dependsOn.push(implicitCreateDep);
    }
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
      throw new Error(
        `Task '${task.id}' uses '__new__' but could not be matched to any of the ${createRepoTaskIds.size} create_repo tasks: ${[...createRepoTaskIds].sort().join(", ")}. Set "repo" to the id of the create_repo task for that repository, or add an explicit 'depends_on' referencing the correct create_repo task.`,
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
