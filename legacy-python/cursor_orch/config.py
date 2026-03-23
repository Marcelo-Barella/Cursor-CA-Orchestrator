from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import yaml

BRANCH_NAME_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$")
SourceType = Literal["flag", "env", "project", "session", "default", "unset"]
PRECEDENCE_ORDER: tuple[SourceType, ...] = ("flag", "env", "project", "session", "default")
FIELD_SOURCE_OF_TRUTH: dict[str, str] = {
    "config_path": "flag (--config), env (CURSOR_ORCH_CONFIG), default file (.cursor-orch.yaml)",
    "bootstrap_repo_name": "resolved runtime config input",
    "name": "resolved runtime config input",
    "model": "resolved runtime config input",
    "prompt": "resolved runtime config input",
    "target.auto_create_pr": "resolved runtime config input",
    "target.branch_prefix": "resolved runtime config input",
    "repositories": "project/session config payload",
    "tasks": "project/session config payload",
    "secrets.CURSOR_API_KEY": "environment variable (CURSOR_API_KEY)",
    "secrets.GH_TOKEN": "environment variable (GH_TOKEN)",
    "CURSOR_API_KEY": "environment variable (CURSOR_API_KEY)",
    "GH_TOKEN": "environment variable (GH_TOKEN)",
    "session": "session fallback file (~/.cursor-orch/session.yaml)",
}
FIELD_PRECEDENCE: dict[str, str] = {
    "config_path": "flag > env > default-file",
    "bootstrap_repo_name": "flag > env > project > session > default",
    "name": "env > project > session > default",
    "model": "env > project > session > default",
    "prompt": "env > project > session > default",
    "target.auto_create_pr": "env > project > session > default",
    "target.branch_prefix": "env > project > session > default",
    "repositories": "project > session > default",
    "tasks": "project > session > default",
    "secrets.CURSOR_API_KEY": "env > unset",
    "secrets.GH_TOKEN": "env > unset",
    "CURSOR_API_KEY": "env > unset",
    "GH_TOKEN": "env > unset",
    "session": "session-file > unset",
}


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
    create_repo: bool = False
    repo_config: dict | None = None


@dataclass
class TargetConfig:
    auto_create_pr: bool
    branch_prefix: str


@dataclass
class OrchestratorConfig:
    name: str
    model: str
    prompt: str = ""
    repositories: dict[str, RepoConfig] = field(default_factory=dict)
    tasks: list[TaskConfig] = field(default_factory=list)
    target: TargetConfig = field(default_factory=lambda: TargetConfig(auto_create_pr=True, branch_prefix="cursor-orch"))
    bootstrap_repo_name: str = "cursor-orch-bootstrap"


@dataclass(frozen=True)
class ResolvedValue:
    value: Any
    source: SourceType
    source_ref: str


@dataclass(frozen=True)
class DiagnosticFinding:
    code: str
    severity: Literal["error", "warn", "info"]
    category: Literal["usage", "environment", "config", "validation", "conflict", "session", "system"]
    message: str
    field: str
    source: SourceType
    source_ref: str
    expected: str
    actual: str
    why_it_failed: str
    fix: str
    is_blocking: bool
    suggested_commands: list[str] = field(default_factory=list)
    docs_ref: str | None = None
    details: dict[str, Any] | None = None


@dataclass(frozen=True)
class ConfigResolution:
    config: OrchestratorConfig
    provenance: dict[str, ResolvedValue]
    findings: list[DiagnosticFinding]

    def to_json(self, redact: str) -> dict[str, Any]:
        errors = [f for f in self.findings if f.severity == "error"]
        warnings = [f for f in self.findings if f.severity == "warn"]
        status = "error" if errors else ("warn" if warnings else "ok")
        source_of_truth = {
            key: source_of_truth_for_field(key)
            for key in self.provenance
        }
        precedence = {
            key: precedence_for_field(key)
            for key in self.provenance
        }
        return {
            "status": status,
            "global_precedence": list(PRECEDENCE_ORDER),
            "effective_config": {
                "name": self.config.name,
                "model": self.config.model,
                "prompt": self._render_secret_value("prompt", self.config.prompt, redact),
                "bootstrap_repo_name": self.config.bootstrap_repo_name,
                "target": {
                    "auto_create_pr": self.config.target.auto_create_pr,
                    "branch_prefix": self.config.target.branch_prefix,
                },
                "repositories_count": len(self.config.repositories),
                "tasks_count": len(self.config.tasks),
            },
            "provenance": {
                key: {
                    "value": self._render_provenance_value(key, value.value, redact),
                    "source": value.source,
                    "source_ref": value.source_ref,
                    "source_of_truth": source_of_truth_for_field(key),
                }
                for key, value in self.provenance.items()
            },
            "source_of_truth": source_of_truth,
            "precedence": precedence,
            "findings": [self._serialize_finding(item) for item in self.findings],
            "summary": {
                "error": len(errors),
                "warn": len(warnings),
                "info": len([f for f in self.findings if f.severity == "info"]),
            },
        }

    def _serialize_finding(self, finding: DiagnosticFinding) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": finding.code,
            "severity": finding.severity,
            "category": finding.category,
            "message": finding.message,
            "field": finding.field,
            "source": finding.source,
            "source_ref": finding.source_ref,
            "source_of_truth": source_of_truth_for_field(finding.field),
            "expected": finding.expected,
            "actual": finding.actual,
            "why_it_failed": finding.why_it_failed,
            "fix": finding.fix,
            "is_blocking": finding.is_blocking,
        }
        if finding.suggested_commands:
            payload["suggested_commands"] = finding.suggested_commands
        if finding.docs_ref:
            payload["docs_ref"] = finding.docs_ref
        if finding.details:
            payload["details"] = finding.details
        return payload

    def _render_provenance_value(self, field_name: str, value: Any, redact: str) -> Any:
        if field_name in {"secrets.CURSOR_API_KEY", "secrets.GH_TOKEN"}:
            return self._render_secret_value(field_name, value, redact)
        if field_name == "prompt":
            return self._render_secret_value(field_name, value, redact)
        return value

    def _render_secret_value(self, field_name: str, value: Any, redact: str) -> Any:
        if not isinstance(value, str):
            return value
        if redact == "none":
            return value
        if field_name.startswith("secrets."):
            if not value:
                return "missing"
            return "set"
        if redact == "full":
            return "<redacted>"
        if not value:
            return ""
        if len(value) <= 8:
            return "*" * len(value)
        return f"{value[:4]}...{value[-4:]}"


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
        prompt=raw.get("prompt", ""),
        repositories=repositories,
        tasks=tasks,
        target=target,
        bootstrap_repo_name=raw.get("bootstrap_repo_name", "cursor-orch-bootstrap"),
    )


def to_yaml(config: OrchestratorConfig) -> str:
    data: dict = {
        "name": config.name,
        "model": config.model,
    }
    if config.prompt:
        data["prompt"] = config.prompt
    if config.repositories:
        data["repositories"] = {
            k: {"url": v.url, "ref": v.ref} for k, v in config.repositories.items()
        }
    if config.tasks:
        tasks_list = []
        for t in config.tasks:
            td: dict = {"id": t.id, "repo": t.repo, "prompt": t.prompt}
            if t.model is not None:
                td["model"] = t.model
            if t.depends_on:
                td["depends_on"] = t.depends_on
            if t.timeout_minutes != 30:
                td["timeout_minutes"] = t.timeout_minutes
            if t.create_repo:
                td["create_repo"] = t.create_repo
            if t.repo_config is not None:
                td["repo_config"] = t.repo_config
            tasks_list.append(td)
        data["tasks"] = tasks_list
    data["target"] = {
        "auto_create_pr": config.target.auto_create_pr,
        "branch_prefix": config.target.branch_prefix,
    }
    if config.bootstrap_repo_name != "cursor-orch-bootstrap":
        data["bootstrap_repo_name"] = config.bootstrap_repo_name
    return yaml.dump(data, default_flow_style=False, sort_keys=False)


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
            create_repo=t.get("create_repo", False),
            repo_config=t.get("repo_config"),
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
        if not task.create_repo and task.repo not in repositories:
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
    if not config.prompt and not config.tasks:
        raise ValueError("Config must specify either 'prompt' or 'tasks'")
    _validate_branch_name(config.target.branch_prefix, "branch_prefix")
    if config.prompt and not config.tasks:
        return
    _validate_task_count(config.tasks)
    task_ids = _validate_unique_ids(config.tasks)
    _validate_repo_refs(config.tasks, config.repositories)
    _validate_dep_refs(config.tasks, task_ids)
    cycle = _detect_cycle(config.tasks)
    if cycle is not None:
        raise ValueError(f"Circular dependency detected: {cycle}")
    _validate_branch_names(config)


def resolve_config_precedence(config_path_flag: str | None, bootstrap_repo_flag: str | None) -> ConfigResolution:
    findings: list[DiagnosticFinding] = []
    provenance: dict[str, ResolvedValue] = {}

    config_path_value = _resolve_config_path(config_path_flag, findings)
    provenance["config_path"] = config_path_value

    project_config, project_raw = _load_source_config(config_path_value, findings)
    session_config, session_raw = _load_session_config(findings)

    bootstrap_repo = _resolve_string_value(
        field_name="bootstrap_repo_name",
        default_value="cursor-orch-bootstrap",
        flag_value=bootstrap_repo_flag,
        flag_ref="--bootstrap-repo",
        env_name="CURSOR_ORCH_BOOTSTRAP_REPO",
        project_raw=project_raw,
        project_key_path=["bootstrap_repo_name"],
        project_ref=f"{config_path_value.source_ref}:bootstrap_repo_name",
        session_raw=session_raw,
        session_key_path=["bootstrap_repo_name"],
        session_ref="~/.cursor-orch/session.yaml:bootstrap_repo_name",
        findings=findings,
    )
    provenance["bootstrap_repo_name"] = bootstrap_repo

    model = _resolve_string_value(
        field_name="model",
        default_value="default",
        flag_value=None,
        flag_ref="",
        env_name="CURSOR_ORCH_MODEL",
        project_raw=project_raw,
        project_key_path=["model"],
        project_ref=f"{config_path_value.source_ref}:model",
        session_raw=session_raw,
        session_key_path=["model"],
        session_ref="~/.cursor-orch/session.yaml:model",
        findings=findings,
    )
    provenance["model"] = model

    name = _resolve_string_value(
        field_name="name",
        default_value="unnamed",
        flag_value=None,
        flag_ref="",
        env_name="CURSOR_ORCH_NAME",
        project_raw=project_raw,
        project_key_path=["name"],
        project_ref=f"{config_path_value.source_ref}:name",
        session_raw=session_raw,
        session_key_path=["name"],
        session_ref="~/.cursor-orch/session.yaml:name",
        findings=findings,
    )
    provenance["name"] = name

    prompt = _resolve_string_value(
        field_name="prompt",
        default_value="",
        flag_value=None,
        flag_ref="",
        env_name="CURSOR_ORCH_PROMPT",
        project_raw=project_raw,
        project_key_path=["prompt"],
        project_ref=f"{config_path_value.source_ref}:prompt",
        session_raw=session_raw,
        session_key_path=["prompt"],
        session_ref="~/.cursor-orch/session.yaml:prompt",
        findings=findings,
    )
    provenance["prompt"] = prompt

    auto_pr = _resolve_bool_value(
        field_name="target.auto_create_pr",
        default_value=True,
        env_name="CURSOR_ORCH_AUTO_PR",
        project_raw=project_raw,
        project_key_path=["target", "auto_create_pr"],
        project_ref=f"{config_path_value.source_ref}:target.auto_create_pr",
        session_raw=session_raw,
        session_key_path=["target", "auto_create_pr"],
        session_ref="~/.cursor-orch/session.yaml:target.auto_create_pr",
        findings=findings,
    )
    provenance["target.auto_create_pr"] = auto_pr

    branch_prefix = _resolve_string_value(
        field_name="target.branch_prefix",
        default_value="cursor-orch",
        flag_value=None,
        flag_ref="",
        env_name="CURSOR_ORCH_BRANCH_PREFIX",
        project_raw=project_raw,
        project_key_path=["target", "branch_prefix"],
        project_ref=f"{config_path_value.source_ref}:target.branch_prefix",
        session_raw=session_raw,
        session_key_path=["target", "branch_prefix"],
        session_ref="~/.cursor-orch/session.yaml:target.branch_prefix",
        findings=findings,
    )
    provenance["target.branch_prefix"] = branch_prefix

    repositories, repositories_source = _resolve_repositories(project_config, project_raw, session_config, session_raw, config_path_value.source_ref)
    provenance["repositories"] = repositories_source
    tasks, tasks_source = _resolve_tasks(project_config, project_raw, session_config, session_raw, config_path_value.source_ref)
    provenance["tasks"] = tasks_source

    cursor_api_key = _resolve_required_secret("CURSOR_API_KEY", findings)
    gh_token = _resolve_required_secret("GH_TOKEN", findings)
    provenance["secrets.CURSOR_API_KEY"] = cursor_api_key
    provenance["secrets.GH_TOKEN"] = gh_token

    config = OrchestratorConfig(
        name=str(name.value),
        model=str(model.value),
        prompt=str(prompt.value),
        repositories=repositories,
        tasks=tasks,
        target=TargetConfig(auto_create_pr=bool(auto_pr.value), branch_prefix=str(branch_prefix.value)),
        bootstrap_repo_name=str(bootstrap_repo.value),
    )

    try:
        validate_config(config)
    except ValueError as exc:
        findings.append(
            DiagnosticFinding(
                code="CFG_SCHEMA_INVALID",
                severity="error",
                category="validation",
                message=str(exc),
                field="config",
                source="project",
                source_ref=config_path_value.source_ref,
                expected="configuration that passes schema and semantic validation",
                actual="invalid",
                why_it_failed="Resolved configuration violates one or more required constraints.",
                fix="Correct the invalid value in config or environment, then rerun `cursor-orch config doctor --strict`.",
                is_blocking=True,
                suggested_commands=[
                    "cursor-orch config doctor --strict",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )

    return ConfigResolution(config=config, provenance=provenance, findings=findings)


def _resolve_config_path(config_path_flag: str | None, findings: list[DiagnosticFinding]) -> ResolvedValue:
    cwd_default = Path(".cursor-orch.yaml")
    if config_path_flag is not None and config_path_flag.strip():
        return ResolvedValue(value=config_path_flag.strip(), source="flag", source_ref="--config")
    env_config = os.environ.get("CURSOR_ORCH_CONFIG")
    if env_config is not None and env_config.strip():
        return ResolvedValue(value=env_config.strip(), source="env", source_ref="CURSOR_ORCH_CONFIG")
    if cwd_default.exists():
        return ResolvedValue(value=str(cwd_default), source="default", source_ref=".cursor-orch.yaml")
    findings.append(
        DiagnosticFinding(
            code="CFG_REQUIRED_MISSING",
            severity="error",
            category="usage",
            message="No configuration source found.",
            field="config_path",
            source="unset",
            source_ref="config_path",
            expected="one of: --config, CURSOR_ORCH_CONFIG, or .cursor-orch.yaml present",
            actual="unset",
            why_it_failed="Run command requires a project configuration source.",
            fix="Provide a config path explicitly or create `.cursor-orch.yaml`.",
            is_blocking=True,
            suggested_commands=[
                "cursor-orch run --config ./config.yaml",
                "export CURSOR_ORCH_CONFIG=./config.yaml",
            ],
            docs_ref="README#onboarding-clone-to-first-run",
        )
    )
    return ResolvedValue(value=None, source="unset", source_ref="unset")


def _load_source_config(
    config_path_value: ResolvedValue,
    findings: list[DiagnosticFinding],
) -> tuple[OrchestratorConfig | None, dict[str, Any] | None]:
    config_path = config_path_value.value
    if not isinstance(config_path, str):
        return None, None
    path = Path(config_path)
    if not path.exists():
        findings.append(
            DiagnosticFinding(
                code="CFG_FILE_NOT_FOUND",
                severity="error",
                category="config",
                message=f"Config file not found: {config_path}.",
                field="config_path",
                source=config_path_value.source,
                source_ref=config_path_value.source_ref,
                expected="existing readable YAML file",
                actual="missing path",
                why_it_failed="Selected config path does not exist.",
                fix="Update `--config` or CURSOR_ORCH_CONFIG to a valid file path.",
                is_blocking=True,
                suggested_commands=[
                    "cursor-orch config doctor --config ./config.yaml --strict",
                    "cursor-orch run --config ./config.yaml",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return None, None
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        findings.append(
            DiagnosticFinding(
                code="CFG_FILE_UNREADABLE",
                severity="error",
                category="system",
                message=f"Cannot read config file: {config_path}.",
                field="config_path",
                source=config_path_value.source,
                source_ref=config_path_value.source_ref,
                expected="readable file",
                actual="unreadable",
                why_it_failed="File permissions or filesystem state prevented reading the file.",
                fix="Fix file permissions and rerun `cursor-orch config doctor --strict`.",
                is_blocking=True,
                suggested_commands=[
                    "ls -l ./config.yaml",
                    "cursor-orch config doctor --config ./config.yaml --strict",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return None, None
    try:
        raw = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        findings.append(
            DiagnosticFinding(
                code="CFG_YAML_INVALID",
                severity="error",
                category="validation",
                message=f"Invalid YAML in config file: {exc}.",
                field="config",
                source="project",
                source_ref=config_path,
                expected="valid YAML mapping",
                actual="parse failure",
                why_it_failed="YAML parsing failed before schema validation.",
                fix="Fix YAML syntax and rerun `cursor-orch config doctor --strict`.",
                is_blocking=True,
                suggested_commands=[
                    "cursor-orch config doctor --config ./config.yaml --strict",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return None, None
    if not isinstance(raw, dict):
        findings.append(
            DiagnosticFinding(
                code="CFG_SCHEMA_INVALID",
                severity="error",
                category="validation",
                message="Config root must be a YAML mapping.",
                field="config",
                source="project",
                source_ref=config_path,
                expected="mapping",
                actual=type(raw).__name__,
                why_it_failed="Config parser requires top-level mapping keys.",
                fix="Rewrite config root as key-value mapping and rerun doctor.",
                is_blocking=True,
                suggested_commands=[
                    "cursor-orch config doctor --config ./config.yaml --strict",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return None, None
    try:
        parsed = parse_config(content)
    except ValueError as exc:
        findings.append(
            DiagnosticFinding(
                code="CFG_SCHEMA_INVALID",
                severity="error",
                category="validation",
                message=str(exc),
                field="config",
                source="project",
                source_ref=config_path,
                expected="valid config keys and value types",
                actual="invalid shape",
                why_it_failed="Config format could not be normalized to internal model.",
                fix="Correct the configuration file and rerun doctor.",
                is_blocking=True,
                suggested_commands=[
                    "cursor-orch config doctor --config ./config.yaml --strict",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return None, None
    return parsed, raw


def _load_session_config(findings: list[DiagnosticFinding]) -> tuple[OrchestratorConfig | None, dict[str, Any] | None]:
    session_path = Path.home() / ".cursor-orch" / "session.yaml"
    if not session_path.exists():
        return None, None
    try:
        content = session_path.read_text(encoding="utf-8")
    except OSError:
        findings.append(
            DiagnosticFinding(
                code="CFG_SESSION_UNREADABLE",
                severity="warn",
                category="session",
                message="Session file is unreadable and will be ignored.",
                field="session",
                source="session",
                source_ref=str(session_path),
                expected="readable session file",
                actual="unreadable",
                why_it_failed="Session fallback could not be loaded from disk.",
                fix="Fix session permissions or remove the broken file.",
                is_blocking=False,
                suggested_commands=[
                    f"rm {session_path}",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return None, None
    try:
        raw = yaml.safe_load(content)
        if raw is None:
            return None, None
        if not isinstance(raw, dict):
            raise ValueError("session root must be mapping")
        parsed = parse_config(content)
        return parsed, raw
    except Exception:
        findings.append(
            DiagnosticFinding(
                code="CFG_SESSION_INVALID",
                severity="warn",
                category="session",
                message="Session file is invalid and will be ignored.",
                field="session",
                source="session",
                source_ref=str(session_path),
                expected="valid session yaml",
                actual="invalid",
                why_it_failed="Session fallback cannot be merged because values are invalid.",
                fix="Remove or repair the session file before relying on session fallback.",
                is_blocking=False,
                suggested_commands=[
                    f"rm {session_path}",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return None, None


def _resolve_repositories(
    project_config: OrchestratorConfig | None,
    project_raw: dict[str, Any] | None,
    session_config: OrchestratorConfig | None,
    session_raw: dict[str, Any] | None,
    project_source_ref: str,
) -> tuple[dict[str, RepoConfig], ResolvedValue]:
    if project_config is not None and isinstance(project_raw, dict) and "repositories" in project_raw:
        return project_config.repositories, ResolvedValue(
            value=len(project_config.repositories),
            source="project",
            source_ref=f"{project_source_ref}:repositories",
        )
    if session_config is not None and isinstance(session_raw, dict) and "repositories" in session_raw:
        return session_config.repositories, ResolvedValue(
            value=len(session_config.repositories),
            source="session",
            source_ref="~/.cursor-orch/session.yaml:repositories",
        )
    return {}, ResolvedValue(value=0, source="default", source_ref="default:repositories")


def _resolve_tasks(
    project_config: OrchestratorConfig | None,
    project_raw: dict[str, Any] | None,
    session_config: OrchestratorConfig | None,
    session_raw: dict[str, Any] | None,
    project_source_ref: str,
) -> tuple[list[TaskConfig], ResolvedValue]:
    if project_config is not None and isinstance(project_raw, dict) and "tasks" in project_raw:
        return project_config.tasks, ResolvedValue(
            value=len(project_config.tasks),
            source="project",
            source_ref=f"{project_source_ref}:tasks",
        )
    if session_config is not None and isinstance(session_raw, dict) and "tasks" in session_raw:
        return session_config.tasks, ResolvedValue(
            value=len(session_config.tasks),
            source="session",
            source_ref="~/.cursor-orch/session.yaml:tasks",
        )
    return [], ResolvedValue(value=0, source="default", source_ref="default:tasks")


def _resolve_string_value(
    field_name: str,
    default_value: str,
    flag_value: str | None,
    flag_ref: str,
    env_name: str,
    project_raw: dict[str, Any] | None,
    project_key_path: list[str],
    project_ref: str,
    session_raw: dict[str, Any] | None,
    session_key_path: list[str],
    session_ref: str,
    findings: list[DiagnosticFinding],
) -> ResolvedValue:
    candidates: list[ResolvedValue] = []
    if flag_value is not None and flag_value.strip():
        candidates.append(ResolvedValue(value=flag_value.strip(), source="flag", source_ref=flag_ref))

    env_value = os.environ.get(env_name)
    if env_value is not None:
        if env_value.strip():
            candidates.append(ResolvedValue(value=env_value.strip(), source="env", source_ref=env_name))
        else:
            findings.append(
                DiagnosticFinding(
                    code="CFG_ENV_EMPTY_IGNORED",
                    severity="warn",
                    category="environment",
                    message=f"Environment variable {env_name} is set but empty and will be ignored.",
                    field=field_name,
                    source="env",
                    source_ref=env_name,
                    expected="non-empty string",
                    actual="empty",
                    why_it_failed="Empty env values are treated as unset during precedence resolution.",
                    fix=f"Unset `{env_name}` or provide a non-empty value before running command again.",
                    is_blocking=False,
                    suggested_commands=[
                        f"unset {env_name}",
                        f"export {env_name}=<value>",
                        "cursor-orch config doctor --strict",
                    ],
                    docs_ref="README#onboarding-clone-to-first-run",
                )
            )

    project_value, project_exists = _get_nested(project_raw, project_key_path)
    if project_exists:
        if isinstance(project_value, str) and project_value.strip():
            candidates.append(ResolvedValue(value=project_value.strip(), source="project", source_ref=project_ref))
        else:
            findings.append(
                DiagnosticFinding(
                    code="CFG_VALUE_INVALID",
                    severity="error",
                    category="config",
                    message=f"Invalid empty value for {field_name}.",
                    field=field_name,
                    source="project",
                    source_ref=project_ref,
                    expected="non-empty string",
                    actual="empty or non-string",
                    why_it_failed="Project config values for this field must be a non-empty string.",
                    fix=f"Set a non-empty value for `{field_name}` in project config.",
                    is_blocking=True,
                    suggested_commands=[
                        "cursor-orch config doctor --strict",
                    ],
                    docs_ref="README#onboarding-clone-to-first-run",
                )
            )

    session_value, session_exists = _get_nested(session_raw, session_key_path)
    if session_exists:
        if isinstance(session_value, str) and session_value.strip():
            candidates.append(ResolvedValue(value=session_value.strip(), source="session", source_ref=session_ref))
        else:
            findings.append(
                DiagnosticFinding(
                    code="CFG_SESSION_INVALID",
                    severity="warn",
                    category="session",
                    message=f"Session value for {field_name} is invalid and ignored.",
                    field=field_name,
                    source="session",
                    source_ref=session_ref,
                    expected="non-empty string",
                    actual="empty or non-string",
                    why_it_failed="Session fallback was present but invalid.",
                    fix=f"Fix or remove session value for `{field_name}`.",
                    is_blocking=False,
                    suggested_commands=[
                        "cursor-orch config doctor --strict",
                    ],
                    docs_ref="README#onboarding-clone-to-first-run",
                )
            )

    candidates.append(ResolvedValue(value=default_value, source="default", source_ref=f"default:{field_name}"))
    return _select_with_conflict(field_name, candidates, findings)


def _resolve_bool_value(
    field_name: str,
    default_value: bool,
    env_name: str,
    project_raw: dict[str, Any] | None,
    project_key_path: list[str],
    project_ref: str,
    session_raw: dict[str, Any] | None,
    session_key_path: list[str],
    session_ref: str,
    findings: list[DiagnosticFinding],
) -> ResolvedValue:
    candidates: list[ResolvedValue] = []

    env_raw = os.environ.get(env_name)
    if env_raw is not None:
        if env_raw.strip():
            parsed = _parse_bool(env_raw.strip())
            if parsed is None:
                findings.append(
                    DiagnosticFinding(
                        code="CFG_VALUE_INVALID",
                        severity="error",
                        category="environment",
                        message=f"Invalid boolean in {env_name}.",
                        field=field_name,
                        source="env",
                        source_ref=env_name,
                        expected="true|false|1|0|yes|no|on|off",
                        actual=env_raw,
                        why_it_failed="Boolean environment value could not be parsed.",
                        fix=f"Set `{env_name}` to a valid boolean string.",
                        is_blocking=True,
                        suggested_commands=[
                            f"export {env_name}=true",
                            "cursor-orch config doctor --strict",
                        ],
                        docs_ref="README#onboarding-clone-to-first-run",
                    )
                )
            else:
                candidates.append(ResolvedValue(value=parsed, source="env", source_ref=env_name))
        else:
            findings.append(
                DiagnosticFinding(
                    code="CFG_ENV_EMPTY_IGNORED",
                    severity="warn",
                    category="environment",
                    message=f"Environment variable {env_name} is set but empty and will be ignored.",
                    field=field_name,
                    source="env",
                    source_ref=env_name,
                    expected="true|false|1|0|yes|no|on|off",
                    actual="empty",
                    why_it_failed="Empty env values are treated as unset during precedence resolution.",
                    fix=f"Unset `{env_name}` or set it to a valid boolean value.",
                    is_blocking=False,
                    suggested_commands=[
                        f"unset {env_name}",
                        f"export {env_name}=true",
                        "cursor-orch config doctor --strict",
                    ],
                    docs_ref="README#onboarding-clone-to-first-run",
                )
            )

    project_value, project_exists = _get_nested(project_raw, project_key_path)
    if project_exists:
        if isinstance(project_value, bool):
            candidates.append(ResolvedValue(value=project_value, source="project", source_ref=project_ref))
        else:
            findings.append(
                DiagnosticFinding(
                    code="CFG_VALUE_INVALID",
                    severity="error",
                    category="config",
                    message=f"Invalid boolean value for {field_name} in project config.",
                    field=field_name,
                    source="project",
                    source_ref=project_ref,
                    expected="boolean true or false",
                    actual=type(project_value).__name__,
                    why_it_failed="Project configuration uses incorrect type.",
                    fix=f"Set `{field_name}` to true or false in config file.",
                    is_blocking=True,
                    suggested_commands=[
                        "cursor-orch config doctor --strict",
                    ],
                    docs_ref="README#onboarding-clone-to-first-run",
                )
            )

    session_value, session_exists = _get_nested(session_raw, session_key_path)
    if session_exists:
        if isinstance(session_value, bool):
            candidates.append(ResolvedValue(value=session_value, source="session", source_ref=session_ref))
        else:
            findings.append(
                DiagnosticFinding(
                    code="CFG_SESSION_INVALID",
                    severity="warn",
                    category="session",
                    message=f"Session boolean value for {field_name} is invalid and ignored.",
                    field=field_name,
                    source="session",
                    source_ref=session_ref,
                    expected="boolean true or false",
                    actual=type(session_value).__name__,
                    why_it_failed="Session fallback value has invalid type.",
                    fix=f"Fix or remove session value for `{field_name}`.",
                    is_blocking=False,
                    suggested_commands=[
                        "cursor-orch config doctor --strict",
                    ],
                    docs_ref="README#onboarding-clone-to-first-run",
                )
            )

    candidates.append(ResolvedValue(value=default_value, source="default", source_ref=f"default:{field_name}"))
    return _select_with_conflict(field_name, candidates, findings)


def _resolve_required_secret(name: str, findings: list[DiagnosticFinding]) -> ResolvedValue:
    if name not in os.environ:
        findings.append(
            DiagnosticFinding(
                code="CFG_ENV_MISSING",
                severity="error",
                category="environment",
                message=f"Required environment variable {name} is missing.",
                field=name,
                source="unset",
                source_ref=name,
                expected="non-empty token",
                actual="unset",
                why_it_failed=f"{name} is required for runtime API operations.",
                fix=f"Set `{name}` in shell or `.env`, then rerun `cursor-orch config doctor --strict`.",
                is_blocking=True,
                suggested_commands=[
                    "cp .env.example .env",
                    f"export {name}=<value>",
                    "cursor-orch config doctor --strict",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return ResolvedValue(value="", source="unset", source_ref=name)

    value = os.environ.get(name, "")
    if not value.strip():
        findings.append(
            DiagnosticFinding(
                code="CFG_ENV_EMPTY",
                severity="error",
                category="environment",
                message=f"Required environment variable {name} is empty.",
                field=name,
                source="unset",
                source_ref=name,
                expected="non-empty token",
                actual="empty",
                why_it_failed=f"Empty credential values are treated as unset; {name} must contain a token.",
                fix=f"Set `{name}` to a non-empty token and rerun `cursor-orch config doctor --strict`.",
                is_blocking=True,
                suggested_commands=[
                    f"export {name}=<value>",
                    "cursor-orch config doctor --strict",
                ],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
        return ResolvedValue(value="", source="unset", source_ref=name)

    return ResolvedValue(value=value, source="env", source_ref=name)


def _select_with_conflict(
    field_name: str,
    candidates: list[ResolvedValue],
    findings: list[DiagnosticFinding],
) -> ResolvedValue:
    winner = candidates[0]
    losers = [candidate for candidate in candidates[1:] if candidate.value != winner.value]
    if losers:
        findings.append(
            DiagnosticFinding(
                code="CFG_CONFLICT_RESOLVED",
                severity="info",
                category="conflict",
                message=f"Multiple sources provided {field_name}; highest precedence source won.",
                field=field_name,
                source=winner.source,
                source_ref=winner.source_ref,
                expected=f"{winner.value}",
                actual=", ".join(f"{item.source}:{item.value}" for item in losers),
                why_it_failed="Lower-precedence values were overridden by precedence rules.",
                fix=f"Use higher-precedence source explicitly or remove stale lower-precedence values for {field_name}.",
                is_blocking=False,
                suggested_commands=[],
                docs_ref="README#onboarding-clone-to-first-run",
            )
        )
    return winner


def _get_nested(raw: dict[str, Any] | None, key_path: list[str]) -> tuple[Any, bool]:
    if raw is None:
        return None, False
    current: Any = raw
    for segment in key_path:
        if not isinstance(current, dict) or segment not in current:
            return None, False
        current = current[segment]
    return current, True


def _parse_bool(value: str) -> bool | None:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def source_of_truth_for_field(field_name: str) -> str:
    return FIELD_SOURCE_OF_TRUTH.get(field_name, "resolved value selected by precedence")


def precedence_for_field(field_name: str) -> str:
    return FIELD_PRECEDENCE.get(field_name, "flag > env > project > session > default")
