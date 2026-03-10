from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

import click
from rich.console import Console

from cursor_orch.api.cursor_client import CursorClient
from cursor_orch.api.gist_client import GistClient
from cursor_orch.bootstrap import ensure_bootstrap_repo, update_cursor_rule
from cursor_orch.config import OrchestratorConfig, parse_config, to_yaml, validate_config
from cursor_orch.dashboard import render_live, render_snapshot
from cursor_orch.packager import create_manifest, package_runtime, validate_payload_size
from cursor_orch.repl import run_repl
from cursor_orch.state import (
    create_initial_state,
    deserialize,
    read_events,
    serialize,
)

logger = logging.getLogger(__name__)
console = Console()


def _get_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        console.print(f"[red]Error: {name} environment variable is required[/red]")
        sys.exit(1)
    return value


def _resolve_config(config_path: str | None) -> OrchestratorConfig:
    if not config_path:
        console.print("[red]Error: --config is required for non-interactive mode[/red]")
        sys.exit(1)
    path = Path(config_path)
    if not path.exists():
        console.print(f"[red]Config not found: {path}[/red]")
        sys.exit(1)
    content = path.read_text(encoding="utf-8")
    config = parse_config(content)
    validate_config(config)
    return config


def _resolve_bootstrap_name(cli_name: str | None, config: OrchestratorConfig | None) -> str:
    if cli_name:
        return cli_name
    if config and config.bootstrap_repo_name:
        return config.bootstrap_repo_name
    return "cursor-orch-bootstrap"


def _run_prompt_only(config: OrchestratorConfig, config_yaml: str, bootstrap_repo: str | None = None) -> None:
    cursor_api_key = _get_env("CURSOR_API_KEY")
    gh_token = _get_env("GH_TOKEN")

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


def _run_orchestration(config: OrchestratorConfig, config_yaml: str, bootstrap_repo: str | None = None) -> None:
    cursor_api_key = _get_env("CURSOR_API_KEY")
    gh_token = _get_env("GH_TOKEN")

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
    gist_client.write_file(gist_id, "state.json", serialize(initial_state))

    render_live(gist_client, gist_id, config)


def _run_interactive() -> None:
    config = run_repl()
    if config is None:
        console.print("Exiting.")
        return
    console.print(f"Validating config: {config.name} ({len(config.tasks)} tasks, {len(config.repositories)} repos)...")
    config_yaml = to_yaml(config)
    _run_orchestration(config, config_yaml)


@click.group(invoke_without_command=True)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose logging")
@click.pass_context
def main(ctx: click.Context, verbose: bool) -> None:
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
    config = _resolve_config(config_path)
    console.print(f"Validating config: {config.name} ({len(config.tasks)} tasks, {len(config.repositories)} repos)...")
    config_yaml = Path(config_path).read_text(encoding="utf-8")
    _run_orchestration(config, config_yaml, bootstrap_repo)


@main.command()
@click.option("--gist", "gist_id", required=True, help="Gist ID of the orchestration run")
@click.option("--watch", is_flag=True, help="Enable live polling dashboard")
def status(gist_id: str, watch: bool) -> None:
    gh_token = _get_env("GH_TOKEN")
    gist_client = GistClient(token=gh_token)

    try:
        content = gist_client.read_file(gist_id, "state.json")
    except Exception:
        console.print(f"[red]Gist not found or inaccessible: {gist_id}[/red]")
        sys.exit(2)

    if not content:
        console.print(f"[red]No state.json found in Gist {gist_id}[/red]")
        sys.exit(2)

    state = deserialize(content)

    config_str = gist_client.read_file(gist_id, "config.yaml")
    if not config_str:
        console.print("[red]No config.yaml found in Gist[/red]")
        sys.exit(2)

    config = parse_config(config_str)

    if watch:
        render_live(gist_client, gist_id, config)
        return

    events = read_events(gist_client, gist_id)
    render_snapshot(state, config, events)

    if state.status in ("completed", "running"):
        sys.exit(0)
    elif state.status == "failed":
        sys.exit(1)


@main.command()
@click.option("--gist", "gist_id", required=True, help="Gist ID of the orchestration run")
def stop(gist_id: str) -> None:
    cursor_api_key = _get_env("CURSOR_API_KEY")
    gh_token = _get_env("GH_TOKEN")

    gist_client = GistClient(token=gh_token)

    content = gist_client.read_file(gist_id, "state.json")
    if not content:
        console.print(f"[red]No state.json found in Gist {gist_id}[/red]")
        sys.exit(1)

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

    console.print("Stop requested. The orchestrator will halt on its next loop iteration.")


@main.command()
@click.option("--gist", "gist_id", required=True, help="Gist ID of the orchestration run")
@click.option("--task", "task_id", default=None, help="Task ID to fetch logs for")
def logs(gist_id: str, task_id: str | None) -> None:
    cursor_api_key = _get_env("CURSOR_API_KEY")
    gh_token = _get_env("GH_TOKEN")

    gist_client = GistClient(token=gh_token)
    cursor_client = CursorClient(api_key=cursor_api_key)

    content = gist_client.read_file(gist_id, "state.json")
    if not content:
        console.print(f"[red]No state.json found in Gist {gist_id}[/red]")
        sys.exit(1)

    state = deserialize(content)

    if task_id:
        agent = state.agents.get(task_id)
        if not agent:
            console.print(f"[red]Task '{task_id}' not found[/red]")
            sys.exit(1)
        if not agent.agent_id:
            console.print(f"[yellow]Task '{task_id}' has no agent (status: {agent.status})[/yellow]")
            sys.exit(0)
        target_agent_id = agent.agent_id
    else:
        if not state.orchestrator_agent_id:
            console.print("[yellow]No orchestrator agent ID recorded[/yellow]")
            sys.exit(0)
        target_agent_id = state.orchestrator_agent_id

    try:
        messages = cursor_client.get_conversation(target_agent_id)
    except Exception as exc:
        console.print(f"[red]Failed to fetch conversation: {exc}[/red]")
        sys.exit(1)

    if not messages:
        console.print("[dim]No messages found.[/dim]")
        return

    for msg in messages:
        role_style = "bold cyan" if msg.role == "user" else "bold green"
        console.print(f"[{role_style}][{msg.role}][/{role_style}] {msg.text}")
        console.print()


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
