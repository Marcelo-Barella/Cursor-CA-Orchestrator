from __future__ import annotations

import re
from dataclasses import dataclass, field

import yaml

BRANCH_NAME_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$")


@dataclass
class RepoConfig:
    url: str
    ref: str


@dataclass
class TaskConfig:
    id: str
    repo: str
    prompt: str
    model: str | None = None
    depends_on: list[str] = field(default_factory=list)
    timeout_minutes: int = 30


@dataclass
class TargetConfig:
    auto_create_pr: bool
    branch_prefix: str


@dataclass
class OrchestratorConfig:
    name: str
    model: str
    repositories: dict[str, RepoConfig]
    tasks: list[TaskConfig]
    target: TargetConfig
    bootstrap_repo_name: str = "cursor-orch-bootstrap"


def parse_config(yaml_str: str) -> OrchestratorConfig:
    raw = yaml.safe_load(yaml_str)
    if not isinstance(raw, dict):
        raise ValueError("Config must be a YAML mapping")

    repositories = {
        k: RepoConfig(url=v["url"], ref=v.get("ref", "main"))
        for k, v in raw.get("repositories", {}).items()
    }

    tasks = [
        TaskConfig(
            id=t["id"],
            repo=t["repo"],
            prompt=t["prompt"],
            model=t.get("model"),
            depends_on=t.get("depends_on", []),
            timeout_minutes=t.get("timeout_minutes", 30),
        )
        for t in raw.get("tasks", [])
    ]

    target_raw = raw.get("target", {})
    target = TargetConfig(
        auto_create_pr=target_raw.get("auto_create_pr", True),
        branch_prefix=target_raw.get("branch_prefix", "cursor-orch"),
    )

    return OrchestratorConfig(
        name=raw.get("name", "unnamed"),
        model=raw.get("model", "default"),
        repositories=repositories,
        tasks=tasks,
        target=target,
        bootstrap_repo_name=raw.get("bootstrap_repo_name", "cursor-orch-bootstrap"),
    )


def _validate_branch_name(name: str, label: str) -> None:
    if not BRANCH_NAME_RE.match(name):
        raise ValueError(
            f"{label} '{name}' does not match pattern: "
            "^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$"
        )


def _detect_cycle(tasks: list[TaskConfig]) -> str | None:
    adj: dict[str, list[str]] = {t.id: list(t.depends_on) for t in tasks}
    visited: set[str] = set()
    in_stack: set[str] = set()

    def dfs(node: str) -> str | None:
        visited.add(node)
        in_stack.add(node)
        for dep in adj.get(node, []):
            if dep in in_stack:
                return f"{node} -> {dep}"
            if dep not in visited:
                result = dfs(dep)
                if result is not None:
                    return result
        in_stack.discard(node)
        return None

    for task in tasks:
        if task.id not in visited:
            cycle = dfs(task.id)
            if cycle is not None:
                return cycle
    return None


def validate_config(config: OrchestratorConfig) -> None:
    if len(config.tasks) > 20:
        raise ValueError(f"Maximum 20 tasks allowed, got {len(config.tasks)}")

    task_ids: set[str] = set()
    for task in config.tasks:
        if task.id in task_ids:
            raise ValueError(f"Duplicate task ID: {task.id}")
        task_ids.add(task.id)

    for task in config.tasks:
        if task.repo not in config.repositories:
            raise ValueError(
                f"Task '{task.id}' references unknown repository '{task.repo}'"
            )

    for task in config.tasks:
        for dep in task.depends_on:
            if dep not in task_ids:
                raise ValueError(
                    f"Task '{task.id}' depends on unknown task '{dep}'"
                )

    cycle = _detect_cycle(config.tasks)
    if cycle is not None:
        raise ValueError(f"Circular dependency detected: {cycle}")

    _validate_branch_name(config.target.branch_prefix, "branch_prefix")

    for task in config.tasks:
        _validate_branch_name(task.id, f"task_id '{task.id}'")
        combined = f"{config.target.branch_prefix}/{task.id}"
        _validate_branch_name(combined, f"branch name '{combined}'")
