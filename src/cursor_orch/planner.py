from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING

from cursor_orch.config import OrchestratorConfig, TaskConfig
from cursor_orch.system_prompt import PLANNER_SYSTEM_PROMPT

if TYPE_CHECKING:
    from cursor_orch.api.gist_client import GistClient

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

Produce a JSON task plan with the following structure and write it to the gist as \
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
should instruct the agent to: (1) create the GitHub repo via the `gh` CLI or GitHub \
API, (2) initialize it with the requested stack, and (3) report the repo URL in \
outputs as `{{"repo_url": "https://github.com/..."}}`.

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

### Gist Write Instructions

Write the JSON output as a file named `task-plan.json` to the gist with ID `{gist_id}`.

Use the GitHub token for authentication: `{gh_token}`
"""


def build_planner_prompt(
    config: OrchestratorConfig, gist_id: str, gh_token: str
) -> str:
    repo_lines: list[str] = []
    for alias, repo in config.repositories.items():
        repo_lines.append(f"- **{alias}**: `{repo.url}` (ref: `{repo.ref}`)")
    repo_list = "\n".join(repo_lines)

    return PLANNER_SYSTEM_PROMPT + "\n\n" + PLANNER_PROMPT_TEMPLATE.format(
        prompt=config.prompt,
        repo_list=repo_list,
        gist_id=gist_id,
        gh_token=gh_token,
    )


def parse_task_plan(plan_json: str, config: OrchestratorConfig) -> list[TaskConfig]:
    try:
        data = json.loads(plan_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in task plan: {exc}") from exc

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
        if not is_create_repo and repo_alias not in config.repositories:
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

    return tasks


def wait_for_plan(
    gist_client: GistClient,
    gist_id: str,
    timeout: int = 600,
    poll_interval: int = 15,
) -> str | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        content = gist_client.read_file(gist_id, "task-plan.json")
        if content:
            logger.info("Task plan found in gist %s", gist_id)
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
