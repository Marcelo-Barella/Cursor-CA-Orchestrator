from __future__ import annotations

import json
from typing import TYPE_CHECKING

from cursor_orch.system_prompt import WORKER_SYSTEM_PROMPT

if TYPE_CHECKING:
    from cursor_orch.config import TaskConfig

MAX_DEP_OUTPUT_BYTES = 50 * 1024


def build_worker_prompt(
    task: TaskConfig,
    gist_id: str,
    gh_token: str,
    dependency_outputs: dict[str, dict],
) -> str:
    sections = [
        WORKER_SYSTEM_PROMPT,
        _section_task(task),
        _section_dependencies(task, dependency_outputs),
        _section_output_protocol(task, gist_id, gh_token),
        _section_rules(),
    ]
    return "\n\n".join(s for s in sections if s)


def build_repo_creation_prompt(
    task: TaskConfig,
    gist_id: str,
    gh_token: str,
    dependency_outputs: dict[str, dict],
) -> str:
    sections = [
        WORKER_SYSTEM_PROMPT,
        _section_task(task),
        _section_repo_creation(task),
        _section_dependencies(task, dependency_outputs),
        _section_output_protocol(task, gist_id, gh_token),
        _section_rules(),
    ]
    return "\n\n".join(s for s in sections if s)


def _section_repo_creation(task: TaskConfig) -> str:
    lines = [
        "REPO CREATION TASK:",
        "You must create a new GitHub repository as part of this task.",
    ]
    if task.repo_config:
        lines.append(f"Repository configuration: {json.dumps(task.repo_config)}")
    lines.extend([
        "",
        'IMPORTANT: After creating the repo, include "repo_url" in your output\'s "outputs" dict,',
        "set to the full HTTPS URL of the newly created repository (e.g. https://github.com/owner/repo-name).",
        "Downstream tasks depend on this value to locate the repository.",
    ])
    return "\n".join(lines)


def _section_task(task: TaskConfig) -> str:
    return (
        f'You are working on task "{task.id}" as part of an orchestrated multi-repo workflow.\n\n'
        f"YOUR TASK:\n{task.prompt.strip()}"
    )


def _section_dependencies(task: TaskConfig, dependency_outputs: dict[str, dict]) -> str:
    if not task.depends_on:
        return ""
    lines = [
        "CONTEXT FROM UPSTREAM TASKS:",
        "The following outputs were produced by tasks that completed before yours.",
        "Use this information as needed to complete your task.",
    ]
    for dep_id in task.depends_on:
        dep_data = dependency_outputs.get(dep_id, {})
        serialized = json.dumps(dep_data, indent=2)
        if len(serialized.encode("utf-8")) > MAX_DEP_OUTPUT_BYTES:
            dep_data = {
                "_truncated": True,
                "summary": str(dep_data.get("summary", ""))[:4096],
                "note": f"Full output available in agent-{dep_id}.json on the Gist.",
            }
            serialized = json.dumps(dep_data, indent=2)
        lines.append(f'\n--- Output from task "{dep_id}" ---')
        lines.append(serialized)
        lines.append(f'--- End output from "{dep_id}" ---')
    return "\n".join(lines)


def _section_output_protocol(task: TaskConfig, gist_id: str, gh_token: str) -> str:
    return f'''WHEN YOU ARE DONE:
Run the following Python script in the shell to report your results.
Replace the placeholder values with your actual output.

```python
import json, urllib.request, ssl

gist_id = "{gist_id}"
task_id = "{task.id}"
token = "{gh_token}"

output = {{
    "task_id": task_id,
    "status": "completed",
    "summary": "DESCRIBE WHAT YOU DID HERE",
    "blocked_reason": None,
    "outputs": {{
        "key": "PUT ARTIFACTS OTHER TASKS MAY NEED HERE"
    }}
}}

payload = json.dumps({{
    "files": {{
        f"agent-{{task_id}}.json": {{
            "content": json.dumps(output, indent=2)
        }}
    }}
}}).encode()

req = urllib.request.Request(
    f"https://api.github.com/gists/{{gist_id}}",
    data=payload,
    method="PATCH",
    headers={{
        "Authorization": f"token {{token}}",
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json"
    }}
)

ctx = ssl.create_default_context()
with urllib.request.urlopen(req, context=ctx) as resp:
    print(f"Output written to Gist (HTTP {{resp.status}})")
```

Edit the `output` dict before running:
- Set "summary" to a concise description of what you did.
- Set "outputs" to a dict of artifacts downstream tasks may need (interfaces, schemas, file paths). If none needed, use an empty dict.
- If you are blocked, set "status" to "blocked" and "blocked_reason" to a specific explanation.'''


def _section_rules() -> str:
    return """RULES:
- Focus only on your assigned task. Do not modify unrelated code.
- If you are blocked, report it using the output script with status "blocked" and a specific blocked_reason.
- Do not attempt to communicate with other agents. Only write to your designated Gist file.
- Create a clean, focused PR with a descriptive title and body.
- Do not read or write any Gist files other than your designated output file."""
