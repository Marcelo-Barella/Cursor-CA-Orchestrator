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
    repositories = _parse_repositories(raw.get("repositories", {}))
    tasks = _parse_tasks(raw.get("tasks", []))
    target = _parse_target(raw.get("target", {}))
    return OrchestratorConfig(
        name=raw.get("name", "unnamed"),
        model=raw.get("model", "default"),
        repositories=repositories,
        tasks=tasks,
        target=target,
        bootstrap_repo_name=raw.get("bootstrap_repo_name", "cursor-orch-bootstrap"),
    )


def _parse_repositories(raw: dict) -> dict[str, RepoConfig]:
    return {k: RepoConfig(url=v["url"], ref=v.get("ref", "main")) for k, v in raw.items()}


def _parse_tasks(raw: list) -> list[TaskConfig]:
    return [
        TaskConfig(
            id=t["id"],
            repo=t["repo"],
            prompt=t["prompt"],
            model=t.get("model"),
            depends_on=t.get("depends_on", []),
            timeout_minutes=t.get("timeout_minutes", 30),
        )
        for t in raw
    ]


def _parse_target(raw: dict) -> TargetConfig:
    return TargetConfig(
        auto_create_pr=raw.get("auto_create_pr", True),
        branch_prefix=raw.get("branch_prefix", "cursor-orch"),
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
    roots = [t.id for t in tasks if t.id not in visited]
    for root in roots:
        result = _dfs_from(root, adj, visited, in_stack)
        if result is not None:
            return result
    return None


def _dfs_from(
    root: str,
    adj: dict[str, list[str]],
    visited: set[str],
    in_stack: set[str],
) -> str | None:
    stack: list[tuple[str, int]] = [(root, 0)]
    while stack:
        result = _dfs_step(stack, adj, visited, in_stack)
        if result is not None:
            return result
    return None


def _dfs_step(
    stack: list[tuple[str, int]],
    adj: dict[str, list[str]],
    visited: set[str],
    in_stack: set[str],
) -> str | None:
    node, idx = stack[-1]
    if idx == 0:
        visited.add(node)
        in_stack.add(node)
    deps = adj.get(node, [])
    if idx < len(deps):
        stack[-1] = (node, idx + 1)
        dep = deps[idx]
        if dep in in_stack:
            return f"{node} -> {dep}"
        if dep not in visited:
            stack.append((dep, 0))
        return None
    in_stack.discard(node)
    stack.pop()
    return None


def _validate_task_count(tasks: list[TaskConfig]) -> None:
    if len(tasks) > 20:
        raise ValueError(f"Maximum 20 tasks allowed, got {len(tasks)}")


def _validate_unique_ids(tasks: list[TaskConfig]) -> set[str]:
    task_ids: set[str] = set()
    for task in tasks:
        if task.id in task_ids:
            raise ValueError(f"Duplicate task ID: {task.id}")
        task_ids.add(task.id)
    return task_ids


def _validate_repo_refs(tasks: list[TaskConfig], repositories: dict[str, RepoConfig]) -> None:
    for task in tasks:
        if task.repo not in repositories:
            raise ValueError(f"Task '{task.id}' references unknown repository '{task.repo}'")


def _validate_dep_refs(tasks: list[TaskConfig], task_ids: set[str]) -> None:
    for task in tasks:
        _validate_single_task_deps(task, task_ids)


def _validate_single_task_deps(task: TaskConfig, task_ids: set[str]) -> None:
    for dep in task.depends_on:
        if dep not in task_ids:
            raise ValueError(f"Task '{task.id}' depends on unknown task '{dep}'")


def _validate_branch_names(config: OrchestratorConfig) -> None:
    _validate_branch_name(config.target.branch_prefix, "branch_prefix")
    for task in config.tasks:
        _validate_branch_name(task.id, f"task_id '{task.id}'")
        combined = f"{config.target.branch_prefix}/{task.id}"
        _validate_branch_name(combined, f"branch name '{combined}'")


def validate_config(config: OrchestratorConfig) -> None:
    _validate_task_count(config.tasks)
    task_ids = _validate_unique_ids(config.tasks)
    _validate_repo_refs(config.tasks, config.repositories)
    _validate_dep_refs(config.tasks, task_ids)
    cycle = _detect_cycle(config.tasks)
    if cycle is not None:
        raise ValueError(f"Circular dependency detected: {cycle}")
    _validate_branch_names(config)
