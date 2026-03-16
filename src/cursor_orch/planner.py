from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING

import json_repair

from cursor_orch.config import OrchestratorConfig, TaskConfig
from cursor_orch.system_prompt import PLANNER_SYSTEM_PROMPT

if TYPE_CHECKING:
    from cursor_orch.api.repo_store import RepoStoreClient

logger = logging.getLogger(__name__)

PLANNER_PROMPT_TEMPLATE = """\
You are a task planner for a multi-repository orchestration system.

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
a file named `task-plan.json`.

### Output Format

```json
{{
  "tasks": [
    {{
      "id": "<unique-kebab-case-id>",
      "repo": "<repository-alias-from-list-above-or-__new__>",
      "prompt": "<detailed-instructions-for-the-agent-working-on-this-task>",
      "depends_on": ["<task-id>", ...],
      "timeout_minutes": <integer>,
      "create_repo": false,
      "repo_config": null
    }}
  ]
}}
```

## Dynamic Repository Creation

When the user request requires creating new GitHub repositories, emit tasks with the \
following conventions:

1. Set `"create_repo": true` and provide `"repo_config": {{"url_template": \
"https://github.com/{{owner}}/{{repo_name}}", "ref": "main"}}` in the task JSON.

2. Repo-creation tasks must use `"repo": "__new__"` (sentinel value). The prompt \
should instruct the agent to: (1) create the GitHub repo via the GitHub REST API \
(POST https://api.github.com/user/repos with `Authorization: token <GH_TOKEN>`), \
(2) clone it using token-based HTTPS auth and initialize it with the requested stack, \
and (3) report the repo URL in outputs as `{{"repo_url": "https://github.com/..."}}`. \
Cursor Agents have access to the `gh` CLI for GitHub operations.

3. Implementation tasks that depend on a newly created repo should declare \
`depends_on` referencing the creation task and use `"repo": "__new__"`. The \
orchestrator will resolve the actual repo URL from upstream task outputs.

### Rules

- `id` must be unique across all tasks and use kebab-case (e.g. `add-auth-backend`).
- `repo` must exactly match one of the repository aliases listed above.
- `prompt` must contain enough detail for an autonomous agent to complete the task \
without additional context.
- `depends_on` is a list of task IDs that must complete before this task starts. \
Use an empty list if there are no dependencies.
- `timeout_minutes` is the estimated maximum time for the task (default 30).
- Do NOT create circular dependencies.
- Maximum 20 tasks.

### Output Write Instructions

Write the JSON output as a file named `task-plan.json` to the run branch of the bootstrap repo.

Use the `gh` CLI with the GitHub Contents API:
```bash
CONTENT=$(cat /tmp/task-plan.json | base64 -w 0)
GH_TOKEN="{gh_token}" gh api --method PUT /repos/{bootstrap_owner}/{bootstrap_repo}/contents/task-plan.json \
  --field message="write task-plan.json" \
  --field content="$CONTENT" \
  --field branch="run/{run_id}"
```
"""


def build_planner_prompt(
    config: OrchestratorConfig,
    run_id: str,
    gh_token: str,
    bootstrap_owner: str,
    bootstrap_repo: str,
) -> str:
    repo_lines: list[str] = []
    for alias, repo in config.repositories.items():
        repo_lines.append(f"- **{alias}**: `{repo.url}` (ref: `{repo.ref}`)")
    repo_list = "\n".join(repo_lines)

    return PLANNER_SYSTEM_PROMPT + "\n\n" + PLANNER_PROMPT_TEMPLATE.format(
        prompt=config.prompt,
        repo_list=repo_list,
        run_id=run_id,
        gh_token=gh_token,
        bootstrap_owner=bootstrap_owner,
        bootstrap_repo=bootstrap_repo,
    )


def _extract_json(raw: str) -> str:
    stripped = re.sub(r"```(?:json)?\s*\n?", "", raw).strip()
    try:
        json.loads(stripped)
        return stripped
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        return raw[start : end + 1]
    return raw


def parse_task_plan(plan_json: str, config: OrchestratorConfig) -> list[TaskConfig]:
    try:
        data = json.loads(plan_json)
    except json.JSONDecodeError:
        cleaned = _extract_json(plan_json)
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            logger.warning("Strict JSON parsing failed, attempting repair")
            data = json_repair.loads(cleaned)
            if not isinstance(data, dict):
                raise ValueError(
                    f"JSON repair produced {type(data).__name__}, expected dict"
                )

    if not isinstance(data, dict) or "tasks" not in data:
        raise ValueError("Task plan must be a JSON object with a 'tasks' key")

    raw_tasks = data["tasks"]
    if not isinstance(raw_tasks, list):
        raise ValueError("'tasks' must be a list")

    task_ids: set[str] = set()
    tasks: list[TaskConfig] = []

    for entry in raw_tasks:
        if not isinstance(entry, dict):
            raise ValueError(f"Each task must be a JSON object, got {type(entry).__name__}")

        for required in ("id", "repo", "prompt"):
            if required not in entry:
                raise ValueError(f"Task missing required field '{required}': {entry}")

        task_id = entry["id"]
        if task_id in task_ids:
            raise ValueError(f"Duplicate task ID: {task_id}")
        task_ids.add(task_id)

        repo_alias = entry["repo"]
        is_create_repo = entry.get("create_repo", False)
        if repo_alias != "__new__" and not is_create_repo and repo_alias not in config.repositories:
            raise ValueError(
                f"Task '{task_id}' references unknown repository '{repo_alias}'. "
                f"Valid aliases: {sorted(config.repositories.keys())}"
            )

        depends_on = entry.get("depends_on", [])
        if not isinstance(depends_on, list):
            raise ValueError(f"Task '{task_id}': 'depends_on' must be a list")

        timeout = entry.get("timeout_minutes", 30)
        if not isinstance(timeout, int) or timeout <= 0:
            raise ValueError(f"Task '{task_id}': 'timeout_minutes' must be a positive integer")

        tasks.append(
            TaskConfig(
                id=task_id,
                repo=repo_alias,
                prompt=entry["prompt"],
                depends_on=depends_on,
                timeout_minutes=timeout,
                create_repo=entry.get("create_repo", False),
                repo_config=entry.get("repo_config"),
            )
        )

    for task in tasks:
        for dep in task.depends_on:
            if dep not in task_ids:
                raise ValueError(
                    f"Task '{task.id}' depends on unknown task '{dep}'. "
                    f"Valid IDs: {sorted(task_ids)}"
                )
    task_by_id = {task.id: task for task in tasks}
    create_repo_task_ids = {task.id for task in tasks if task.create_repo}
    for task in tasks:
        if task.repo == "__new__" and not task.create_repo:
            has_create_dep = any(dep in create_repo_task_ids for dep in task.depends_on)
            if has_create_dep:
                continue
            upstream_create_deps = _collect_upstream_create_repo_ids(task, task_by_id, create_repo_task_ids)
            if len(upstream_create_deps) == 1:
                task.depends_on.append(next(iter(upstream_create_deps)))
                continue
            if len(create_repo_task_ids) == 1:
                task.depends_on.append(next(iter(create_repo_task_ids)))
                continue
            raise ValueError(
                f"Task '{task.id}' uses '__new__' but does not depend on a create_repo task. "
                "Add a dependency on the task that creates the target repository."
            )

    return tasks


def _collect_upstream_create_repo_ids(
    task: TaskConfig,
    task_by_id: dict[str, TaskConfig],
    create_repo_task_ids: set[str],
) -> set[str]:
    upstream_create_ids: set[str] = set()
    stack: list[str] = list(task.depends_on)
    visited: set[str] = set()
    while stack:
        dep_id = stack.pop()
        if dep_id in visited:
            continue
        visited.add(dep_id)
        if dep_id in create_repo_task_ids:
            upstream_create_ids.add(dep_id)
            continue
        dep_task = task_by_id.get(dep_id)
        if dep_task is None:
            continue
        stack.extend(dep_task.depends_on)
    return upstream_create_ids


def wait_for_plan(
    repo_store: RepoStoreClient,
    run_id: str,
    timeout: int = 600,
    poll_interval: int = 15,
) -> str | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        content = repo_store.read_file(run_id, "task-plan.json")
        if content:
            logger.info("Task plan found for run %s", run_id)
            return content
        remaining = deadline - time.monotonic()
        logger.debug(
            "task-plan.json not yet available, retrying in %ds (%.0fs remaining)",
            poll_interval,
            remaining,
        )
        time.sleep(min(poll_interval, max(0, remaining)))
    logger.warning("Timed out waiting for task plan after %ds", timeout)
    return None
