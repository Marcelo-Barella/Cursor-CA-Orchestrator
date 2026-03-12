from __future__ import annotations

import logging
import os
import json
import sys
import time
from pathlib import Path

import click
from rich.console import Console

from cursor_orch.api.cursor_client import CursorClient
from cursor_orch.api.gist_client import GistClient
from cursor_orch.bootstrap import ensure_bootstrap_repo, update_cursor_rule
from cursor_orch.config import (
    ConfigResolution,
    DiagnosticFinding,
    OrchestratorConfig,
    parse_config,
    precedence_for_field,
    resolve_config_precedence,
    source_of_truth_for_field,
    to_yaml,
)
from cursor_orch.dashboard import render_live, render_snapshot
from cursor_orch.packager import create_manifest, package_runtime, validate_payload_size
from cursor_orch.repl import run_repl
from cursor_orch.state import (
    create_initial_state,
    deserialize,
    read_events,
    seed_main_agent,
    serialize,
)

logger = logging.getLogger(__name__)
console = Console()


def _print_next_actions(*actions: str) -> None:
    if not actions:
        return
    console.print("Immediate next actions:")
    for action in actions:
        console.print(f"- {action}")


def _render_feedback(
    *,
    code: str,
    severity: str,
    title: str,
    what_happened: str,
    next_step: str,
    alternative: str,
    example: str,
) -> None:
    console.print(
        "\n".join(
            [
                f"[{severity}] {code} {title}",
                f"What happened: {what_happened}",
                f"Next step: {next_step}",
                f"Non-interactive alternative: {alternative}",
                f"Example: {example}",
            ]
        ),
        markup=False,
    )


def _fail(
    *,
    code: str,
    severity: str,
    title: str,
    what_happened: str,
    next_step: str,
    alternative: str,
    example: str,
    exit_code: int,
) -> None:
    _render_feedback(
        code=code,
        severity=severity,
        title=title,
        what_happened=what_happened,
        next_step=next_step,
        alternative=alternative,
        example=example,
    )
    sys.exit(exit_code)


def _require_env_values(
    *,
    names: tuple[str, ...],
    code: str,
    severity: str,
    title: str,
    what_happened: str,
    next_step: str,
    alternative: str,
    example: str,
    exit_code: int,
) -> dict[str, str]:
    values: dict[str, str] = {}
    missing_or_empty: list[str] = []
    for name in names:
        raw = os.environ.get(name)
        if raw is None or not raw.strip():
            missing_or_empty.append(name)
            continue
        values[name] = raw.strip()
    if missing_or_empty:
        _fail(
            code=code,
            severity=severity,
            title=title,
            what_happened=f"{what_happened} Missing or empty: {', '.join(missing_or_empty)}.",
            next_step=next_step,
            alternative=alternative,
            example=example,
            exit_code=exit_code,
        )
    return values


def _load_env_file() -> None:
    env_path = Path(".env")
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


def _get_env(name: str, *, command: str, command_example: str) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        actual = "missing" if value is None else "empty"
        source_of_truth = source_of_truth_for_field(name)
        precedence = precedence_for_field(name)
        _fail(
            code="ENV-001",
            severity="FATAL",
            title=f"Invalid required environment variable: {name}",
            what_happened=(
                f"{command} requires {name}, but it is {actual}. "
                f"Source of truth: {source_of_truth}. Precedence: {precedence}."
            ),
            next_step=f"Set {name} to a non-empty token and run config doctor to confirm recovery.",
            alternative="Set the variable inline for this command invocation.",
            example=f"export {name}=<value>\n{command_example}\ncursor-orch config doctor --strict",
            exit_code=1,
        )
    return value.strip()


def _print_findings(findings: list[DiagnosticFinding]) -> None:
    for finding in findings:
        level = finding.severity.upper()
        style = "red" if finding.severity == "error" else ("yellow" if finding.severity == "warn" else "cyan")
        console.print(f"[{style}]{level} {finding.code}[/{style}] {finding.message}")
        console.print(f"Field: {finding.field}")
        console.print(f"Source of truth: {source_of_truth_for_field(finding.field)}")
        console.print(f"Precedence: {precedence_for_field(finding.field)}")
        console.print(f"Source: {finding.source} ({finding.source_ref})")
        console.print(f"Why: {finding.why_it_failed}")
        console.print(f"Recovery: {finding.fix}")
        if finding.suggested_commands:
            console.print("Commands:")
            for command in finding.suggested_commands:
                console.print(f"  - {command}")
        console.print()


def _display_value(field_name: str, value: object) -> str:
    if field_name == "prompt":
        if not isinstance(value, str) or value == "":
            return "<empty>"
        if len(value) <= 40:
            return value
        return f"{value[:37]}..."
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "<unset>"
    return str(value)


def _print_resolution_summary(resolution: ConfigResolution) -> None:
    keys = [
        "config_path",
        "name",
        "model",
        "prompt",
        "bootstrap_repo_name",
        "target.auto_create_pr",
        "target.branch_prefix",
        "repositories",
        "tasks",
        "secrets.CURSOR_API_KEY",
        "secrets.GH_TOKEN",
    ]
    console.print("Resolution Summary:")
    for key in keys:
        resolved = resolution.provenance.get(key)
        if resolved is None:
            continue
        rendered = _display_value(key, resolved.value)
        if key.startswith("secrets."):
            rendered = "set" if isinstance(resolved.value, str) and resolved.value else "missing"
        source_of_truth = source_of_truth_for_field(key)
        precedence = precedence_for_field(key)
        console.print(
            f"  - {key}: {rendered} "
            f"[effective={resolved.source} -> {resolved.source_ref}; source-of-truth={source_of_truth}; precedence={precedence}]"
        )


def _resolve_config(config_path: str | None, bootstrap_repo: str | None) -> ConfigResolution:
    resolution = resolve_config_precedence(config_path, bootstrap_repo)
    blocking = [finding for finding in resolution.findings if finding.is_blocking]
    if blocking:
        _print_findings(blocking)
        _fail(
            code="RUN-003",
            severity="FATAL",
            title="Configuration resolution failed",
            what_happened="Required values are missing or invalid after applying precedence.",
            next_step="Apply the suggested fixes and rerun config doctor.",
            alternative="Pin intended values with flags or environment variables in automation.",
            example="cursor-orch config doctor --strict",
            exit_code=1,
        )
    return resolution


def _print_non_blocking_findings(findings: list[DiagnosticFinding]) -> None:
    non_blocking = [finding for finding in findings if not finding.is_blocking]
    if not non_blocking:
        return
    console.print()
    console.print("Diagnostics:")
    _print_findings(non_blocking)


def _resolve_bootstrap_name(cli_name: str | None, config: OrchestratorConfig | None) -> str:
    if cli_name:
        return cli_name
    if config and config.bootstrap_repo_name:
        return config.bootstrap_repo_name
    return "cursor-orch-bootstrap"


def _run_prompt_only(
    config: OrchestratorConfig,
    config_yaml: str,
    cursor_api_key: str,
    gh_token: str,
    bootstrap_repo: str | None = None,
) -> None:
    repo_name = _resolve_bootstrap_name(bootstrap_repo, config)
    repo_info = ensure_bootstrap_repo(gh_token, repo_name)
    console.print(f"Bootstrap repo verified: {repo_info['owner']}/{repo_info['name']}")

    cursor_client = CursorClient(api_key=cursor_api_key)
    repo_url = f"https://github.com/{repo_info['owner']}/{repo_info['name']}"

    console.print(f"Launching prompt-only agent against {repo_info['owner']}/{repo_info['name']}...")
    agent = cursor_client.launch_agent(
        prompt=config.prompt,
        repository=repo_url,
        ref="main",
        model=config.model,
        branch_name=f"{config.target.branch_prefix}/prompt-run",
        auto_pr=config.target.auto_create_pr,
    )
    console.print(f"Agent {agent.id} launched ({agent.status}).")

    _poll_agent(cursor_client, agent.id)


def _run_orchestration(
    config: OrchestratorConfig,
    config_yaml: str,
    cursor_api_key: str,
    gh_token: str,
    bootstrap_repo: str | None = None,
) -> None:
    repo_name = _resolve_bootstrap_name(bootstrap_repo, config)
    repo_info = ensure_bootstrap_repo(gh_token, repo_name)
    console.print(f"Bootstrap repo verified: {repo_info['owner']}/{repo_info['name']}")

    runtime_files = package_runtime()
    validate_payload_size(runtime_files)
    manifest_str = create_manifest(runtime_files)

    initial_state = create_initial_state(config, "placeholder")

    gist_client = GistClient(token=gh_token)
    gist_files: dict[str, str] = {
        "config.yaml": config_yaml,
        "state.json": serialize(initial_state),
        "summary.md": f"# {config.name}\n\nOrchestration pending...\n",
    }

    gist_info = gist_client.create_gist(
        description=f"cursor-orch: {config.name}",
        files=gist_files,
    )
    gist_id = gist_info.id
    console.print(f"Created orchestration Gist (secret): {gist_info.url}")
    console.print(f"Gist ID: {gist_id}")
    _print_next_actions(
        f"Watch run status: cursor-orch status --gist {gist_id} --watch",
        f"Inspect orchestrator logs: cursor-orch logs --gist {gist_id}",
        f"Request stop when needed: cursor-orch stop --gist {gist_id}",
    )

    upload_files = dict(runtime_files)
    upload_files["runtime_manifest.json"] = manifest_str
    gist_client.update_gist(gist_id, upload_files)
    console.print(f"Uploaded runtime payload: {len(runtime_files)} files + manifest")

    initial_state.orchestration_id = gist_id
    initial_state.gist_id = gist_id
    gist_client.write_file(gist_id, "state.json", serialize(initial_state))

    update_cursor_rule(gh_token, repo_info["owner"], repo_info["name"], gist_id, cursor_api_key)
    console.print("Updated Cursor rule in bootstrap repo")

    cursor_client = CursorClient(api_key=cursor_api_key)
    repo_url = f"https://github.com/{repo_info['owner']}/{repo_info['name']}"

    console.print(f"Launching orchestrator agent against {repo_info['owner']}/{repo_info['name']}...")
    agent = cursor_client.launch_agent(
        prompt="Follow the Cursor rule instructions exactly.",
        repository=repo_url,
        ref="main",
        model=config.model,
        branch_name=f"cursor-orch-run-{gist_id[:8]}",
        auto_pr=False,
    )
    console.print(f"Orchestrator {agent.id} {agent.status}.")

    initial_state.orchestrator_agent_id = agent.id
    seed_main_agent(
        initial_state,
        agent_id=agent.id,
        status="launching",
        started_at=initial_state.started_at,
    )
    gist_client.write_file(gist_id, "state.json", serialize(initial_state))

    render_live(gist_client, gist_id, config)


def _run_interactive() -> None:
    config = run_repl()
    if config is None:
        console.print("Exiting.")
        return
    console.print(f"Validating config: {config.name} ({len(config.tasks)} tasks, {len(config.repositories)} repos)...")
    config_yaml = to_yaml(config)
    env = _require_env_values(
        names=("CURSOR_API_KEY", "GH_TOKEN"),
        code="RUN-004",
        severity="FATAL",
        title="Missing required environment variable",
        what_happened="run requires CURSOR_API_KEY and GH_TOKEN.",
        next_step="Copy .env.example to .env, set required values, and rerun.",
        alternative="Set variables inline for this invocation.",
        example="CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml",
        exit_code=1,
    )
    _run_orchestration(config, config_yaml, env["CURSOR_API_KEY"], env["GH_TOKEN"])


@click.group(invoke_without_command=True)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose logging")
@click.pass_context
def main(ctx: click.Context, verbose: bool) -> None:
    _load_env_file()
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    if ctx.invoked_subcommand is None:
        _run_interactive()


@main.command()
@click.option("--config", "config_path", type=click.Path(exists=False), default=None, help="Path to config YAML")
@click.option("--bootstrap-repo", default=None, help="Bootstrap repo name")
def run(config_path: str | None, bootstrap_repo: str | None) -> None:
    """
    Start an orchestration from config with immediate follow-up commands.
    Required options: none when precedence resolves config, use --config for explicit runs.
    Quick start: cursor-orch run --config ./orchestrator.yaml
    Automation: CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config /workspace/orchestrator.yaml --bootstrap-repo cursor-orch-bootstrap
    """
    resolution = _resolve_config(config_path, bootstrap_repo)
    config = resolution.config
    _print_resolution_summary(resolution)
    _print_non_blocking_findings(resolution.findings)
    console.print(f"Validating config: {config.name} ({len(config.tasks)} tasks, {len(config.repositories)} repos)...")
    config_yaml = to_yaml(config)
    env = _require_env_values(
        names=("CURSOR_API_KEY", "GH_TOKEN"),
        code="RUN-004",
        severity="FATAL",
        title="Missing required environment variable",
        what_happened="run requires CURSOR_API_KEY and GH_TOKEN.",
        next_step="Copy .env.example to .env, set required values, and rerun.",
        alternative="Set variables inline for this invocation.",
        example="CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml",
        exit_code=1,
    )
    try:
        _run_orchestration(config, config_yaml, env["CURSOR_API_KEY"], env["GH_TOKEN"], bootstrap_repo)
    except SystemExit:
        raise
    except Exception as exc:
        logger.debug("run failed", exc_info=exc)
        _fail(
            code="RUN-005",
            severity="ERROR",
            title="Failed to initialize orchestration runtime",
            what_happened="A remote setup step did not complete successfully.",
            next_step="Verify GH_TOKEN and CURSOR_API_KEY values, then retry.",
            alternative="Rerun with the same --config after credential checks in automation.",
            example="CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml",
            exit_code=1,
        )


@main.command()
@click.option("--gist", "gist_id", required=True, help="Gist ID of the orchestration run")
@click.option("--watch", is_flag=True, help="Enable live polling dashboard")
def status(gist_id: str, watch: bool) -> None:
    """
    Show orchestration state from a run Gist.
    Required options: --gist.
    Quick start: cursor-orch status --gist <gist_id>
    Automation: GH_TOKEN=... cursor-orch status --gist <gist_id> --watch
    """
    env = _require_env_values(
        names=("GH_TOKEN",),
        code="STATUS-001",
        severity="FATAL",
        title="Missing GH_TOKEN",
        what_happened="status requires GitHub access to read orchestration state.",
        next_step="Set GH_TOKEN and rerun status.",
        alternative="Export GH_TOKEN inline in script execution.",
        example="GH_TOKEN=... cursor-orch status --gist <gist_id>",
        exit_code=1,
    )
    gh_token = env["GH_TOKEN"]
    gist_client = GistClient(token=gh_token)

    try:
        content = gist_client.read_file(gist_id, "state.json")
    except Exception:
        _fail(
            code="STATUS-002",
            severity="ERROR",
            title="Run state is unavailable",
            what_happened="The provided Gist ID is invalid or inaccessible with current token.",
            next_step="Verify --gist value and token scope.",
            alternative="Store and reuse the Gist ID emitted by run output.",
            example="cursor-orch status --gist <saved_gist_id>",
            exit_code=2,
        )

    if not content:
        _fail(
            code="STATUS-003",
            severity="ERROR",
            title="Missing state.json in run artifact",
            what_happened="The Gist does not contain orchestration state metadata.",
            next_step="Confirm this Gist comes from a valid run command.",
            alternative="Rerun orchestration to regenerate artifacts.",
            example="cursor-orch run --config ./orchestrator.yaml",
            exit_code=2,
        )

    state = deserialize(content)

    config_str = gist_client.read_file(gist_id, "config.yaml")
    if not config_str:
        _fail(
            code="STATUS-004",
            severity="ERROR",
            title="Missing or invalid config snapshot",
            what_happened="status could not load config.yaml from the run artifact.",
            next_step="Use a valid run-generated Gist or rerun orchestration.",
            alternative="Regenerate run artifacts in automation before polling status.",
            example="cursor-orch run --config ./orchestrator.yaml && cursor-orch status --gist <gist_id>",
            exit_code=2,
        )

    try:
        config = parse_config(config_str)
    except Exception:
        _fail(
            code="STATUS-004",
            severity="ERROR",
            title="Missing or invalid config snapshot",
            what_happened="status could not load config.yaml from the run artifact.",
            next_step="Use a valid run-generated Gist or rerun orchestration.",
            alternative="Regenerate run artifacts in automation before polling status.",
            example="cursor-orch run --config ./orchestrator.yaml && cursor-orch status --gist <gist_id>",
            exit_code=2,
        )

    if watch:
        _print_next_actions(
            f"Keep watching this run: cursor-orch status --gist {gist_id} --watch",
            f"Inspect orchestrator conversation: cursor-orch logs --gist {gist_id}",
            f"Request a stop if needed: cursor-orch stop --gist {gist_id}",
        )
        render_live(gist_client, gist_id, config)
        return

    events = read_events(gist_client, gist_id)
    render_snapshot(state, config, events)
    _print_next_actions(
        f"Watch live updates: cursor-orch status --gist {gist_id} --watch",
        f"Inspect logs: cursor-orch logs --gist {gist_id}",
    )
    if state.status == "running":
        _print_next_actions(f"Request stop when needed: cursor-orch stop --gist {gist_id}")
    if state.status == "failed":
        _print_next_actions(
            "Re-run with validated configuration: cursor-orch run --config ./orchestrator.yaml",
            f"Fetch conversation details: cursor-orch logs --gist {gist_id}",
        )

    if state.status in ("completed", "running"):
        sys.exit(0)
    elif state.status == "failed":
        sys.exit(1)


@main.command()
@click.option("--gist", "gist_id", required=True, help="Gist ID of the orchestration run")
def stop(gist_id: str) -> None:
    """
    Request a stop signal for a running orchestration.
    Required options: --gist.
    Quick start: cursor-orch stop --gist <gist_id>
    Automation: CURSOR_API_KEY=... GH_TOKEN=... cursor-orch stop --gist <gist_id>
    """
    env = _require_env_values(
        names=("CURSOR_API_KEY", "GH_TOKEN"),
        code="STOP-001",
        severity="FATAL",
        title="Missing credentials for stop operation",
        what_happened="stop requires GH_TOKEN and may require CURSOR_API_KEY to stop agent execution.",
        next_step="Set required variables and retry stop.",
        alternative="Provide env vars inline for one-shot stop.",
        example="CURSOR_API_KEY=... GH_TOKEN=... cursor-orch stop --gist <gist_id>",
        exit_code=1,
    )
    cursor_api_key = env["CURSOR_API_KEY"]
    gh_token = env["GH_TOKEN"]

    gist_client = GistClient(token=gh_token)

    content = gist_client.read_file(gist_id, "state.json")
    if not content:
        _fail(
            code="STOP-002",
            severity="ERROR",
            title="Cannot resolve run state for stop",
            what_happened="state.json was not found in the provided Gist.",
            next_step="Confirm the Gist ID belongs to a valid orchestration run.",
            alternative="Save Gist ID from run output and pass it directly.",
            example="cursor-orch stop --gist <saved_gist_id>",
            exit_code=1,
        )

    state = deserialize(content)

    import json
    from datetime import datetime, timezone

    stop_payload = json.dumps({
        "requested_at": datetime.now(timezone.utc).isoformat(),
        "requested_by": "cli",
    })
    console.print("Writing stop request to Gist...")
    gist_client.write_file(gist_id, "stop-requested.json", stop_payload)

    if state.orchestrator_agent_id:
        console.print(f"Stopping orchestrator agent {state.orchestrator_agent_id}...")
        cursor_client = CursorClient(api_key=cursor_api_key)
        try:
            cursor_client.stop_agent(state.orchestrator_agent_id)
        except Exception:
            logger.warning("Failed to stop orchestrator agent via API")
            _render_feedback(
                code="STOP-003",
                severity="WARN",
                title="Stop request saved, API stop was not confirmed",
                what_happened="stop-requested.json was written but direct agent stop call failed.",
                next_step="Monitor run status to confirm halt on next loop.",
                alternative="Poll status in a script until state changes.",
                example="cursor-orch status --gist <gist_id> --watch",
            )

    console.print("Stop requested. The orchestrator will halt on its next loop iteration.")
    _print_next_actions(
        f"Confirm stop completion: cursor-orch status --gist {gist_id} --watch",
        f"Inspect latest orchestrator logs: cursor-orch logs --gist {gist_id}",
    )


@main.command()
@click.option("--gist", "gist_id", required=True, help="Gist ID of the orchestration run")
@click.option("--task", "task_id", default=None, help="Task ID to fetch logs for")
def logs(gist_id: str, task_id: str | None) -> None:
    """
    Print orchestrator or task conversation logs for a run.
    Required options: --gist.
    Quick start: cursor-orch logs --gist <gist_id>
    Automation: CURSOR_API_KEY=... GH_TOKEN=... cursor-orch logs --gist <gist_id> --task <task_id>
    """
    env = _require_env_values(
        names=("CURSOR_API_KEY", "GH_TOKEN"),
        code="LOGS-001",
        severity="FATAL",
        title="Missing credentials for logs retrieval",
        what_happened="logs needs GH_TOKEN for state and CURSOR_API_KEY for conversation fetch.",
        next_step="Set required variables and retry logs.",
        alternative="Pass env vars inline in scripts.",
        example="CURSOR_API_KEY=... GH_TOKEN=... cursor-orch logs --gist <gist_id>",
        exit_code=1,
    )
    cursor_api_key = env["CURSOR_API_KEY"]
    gh_token = env["GH_TOKEN"]

    gist_client = GistClient(token=gh_token)
    cursor_client = CursorClient(api_key=cursor_api_key)

    content = gist_client.read_file(gist_id, "state.json")
    if not content:
        _fail(
            code="LOGS-002",
            severity="ERROR",
            title="Cannot load run state for logs",
            what_happened="state.json was not found in the provided Gist.",
            next_step="Verify the Gist ID from run output.",
            alternative="Persist gist IDs in automation metadata.",
            example="cursor-orch logs --gist <saved_gist_id>",
            exit_code=1,
        )

    state = deserialize(content)

    if task_id:
        agent = state.agents.get(task_id)
        if not agent:
            _fail(
                code="LOGS-003",
                severity="ERROR",
                title="Task not found in orchestration state",
                what_happened="The supplied --task value does not match any task id in this run.",
                next_step="Inspect status output to identify valid task ids.",
                alternative="Parse task ids from state.json before calling logs.",
                example="cursor-orch logs --gist <gist_id> --task <valid_task_id>",
                exit_code=1,
            )
        if not agent.agent_id:
            _render_feedback(
                code="LOGS-004",
                severity="WARN",
                title="Task has no agent conversation yet",
                what_happened=f"The task exists but no agent id has been assigned (status: {agent.status}).",
                next_step="Wait for scheduling and check status again.",
                alternative="Poll status before requesting task logs.",
                example="cursor-orch status --gist <gist_id> --watch",
            )
            sys.exit(0)
        target_agent_id = agent.agent_id
    else:
        if not state.orchestrator_agent_id:
            _render_feedback(
                code="LOGS-005",
                severity="WARN",
                title="No orchestrator agent id recorded",
                what_happened="The run state does not contain an orchestrator conversation target.",
                next_step="Check if run initialization completed successfully.",
                alternative="Rerun orchestration with valid credentials and config.",
                example="cursor-orch run --config ./orchestrator.yaml",
            )
            sys.exit(0)
        target_agent_id = state.orchestrator_agent_id

    try:
        messages = cursor_client.get_conversation(target_agent_id)
    except Exception as exc:
        _fail(
            code="LOGS-006",
            severity="ERROR",
            title="Failed to fetch conversation logs",
            what_happened=f"The conversation API request failed for the target agent: {exc}.",
            next_step="Verify CURSOR_API_KEY and agent id validity, then retry.",
            alternative="Retry with backoff in scripts.",
            example="cursor-orch logs --gist <gist_id> --task <task_id>",
            exit_code=1,
        )

    if not messages:
        _render_feedback(
            code="LOGS-007",
            severity="INFO",
            title="No messages available yet",
            what_happened="The target conversation exists but has no messages.",
            next_step="Wait briefly and request logs again.",
            alternative="Poll logs with interval in automation.",
            example="while true; do cursor-orch logs --gist <gist_id>; sleep 15; done",
        )
        return

    for msg in messages:
        role_style = "bold cyan" if msg.role == "user" else "bold green"
        console.print(f"[{role_style}][{msg.role}][/{role_style}] {msg.text}")
        console.print()
    _print_next_actions(f"Refresh run state: cursor-orch status --gist {gist_id}")


@main.group(name="config")
def config_group() -> None:
    pass


@config_group.command(name="doctor")
@click.option("--config", "config_path", type=click.Path(exists=False), default=None, help="Path to config YAML")
@click.option("--json", "as_json", is_flag=True, help="Emit machine-readable JSON report")
@click.option("--strict", is_flag=True, help="Return non-zero when warnings are present")
@click.option(
    "--redact",
    type=click.Choice(["full", "partial", "none"], case_sensitive=True),
    default="partial",
    show_default=True,
    help="Redaction mode for prompt and secret fields",
)
def config_doctor(config_path: str | None, as_json: bool, strict: bool, redact: str) -> None:
    resolution = resolve_config_precedence(config_path, None)
    if as_json:
        payload = resolution.to_json(redact=redact)
        console.print(json.dumps(payload, indent=2))
    else:
        _print_resolution_summary(resolution)
        if resolution.findings:
            console.print()
            console.print("Findings:")
            _print_findings(resolution.findings)
    errors = [finding for finding in resolution.findings if finding.severity == "error"]
    warnings = [finding for finding in resolution.findings if finding.severity == "warn"]
    if errors:
        sys.exit(1)
    if strict and warnings:
        sys.exit(2)
    sys.exit(0)


def _poll_agent(cursor_client: CursorClient, agent_id: str) -> None:
    terminal_states = {"finished", "stopped", "failed", "error"}
    last_status = None

    try:
        while True:
            agent = cursor_client.get_agent(agent_id)
            current_status = agent.status.lower()

            if current_status != last_status:
                console.print(f"Agent status: {agent.status}")
                last_status = current_status

            if current_status in terminal_states:
                if agent.summary:
                    console.print(f"Summary: {agent.summary}")
                if agent.pr_url:
                    console.print(f"PR: {agent.pr_url}")
                return

            time.sleep(10)
    except KeyboardInterrupt:
        console.print("Detached. Agent continues running in cloud.")
