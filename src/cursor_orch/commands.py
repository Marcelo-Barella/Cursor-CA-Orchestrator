from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from cursor_orch.session import Session


@dataclass
class CommandInfo:
    name: str
    handler: Callable
    usage: str
    description: str


def cmd_name(session: Session, name: str) -> str:
    session.set_name(name)
    return f"[green]Session name set to[/green] [bold]{name}[/bold]"


def cmd_model(session: Session, model: str) -> str:
    session.set_model(model)
    return f"[green]Model set to[/green] [bold]{model}[/bold]"


def cmd_repo(session: Session, alias: str, url: str, ref: str = "main") -> str:
    replaced = session.add_repo(alias, url, ref)
    parts: list[str] = []
    if replaced:
        parts.append(f"[red]Replacing existing repo[/red] [bold]{alias}[/bold]")
    parts.append(
        f"[green]Repo added:[/green] [bold]{alias}[/bold] -> {url} [dim](ref: {ref})[/dim]"
    )
    return "\n".join(parts)


def cmd_repo_remove(session: Session, alias: str) -> str:
    removed = session.remove_repo(alias)
    if removed:
        return f"[green]Repo removed:[/green] [bold]{alias}[/bold]"
    return f"[red]Repo not found:[/red] [bold]{alias}[/bold]"


def cmd_repos(session: Session) -> str:
    repos = session.config.repositories
    if not repos:
        return "[dim]No repositories configured.[/dim]"
    lines = ["[bold]Repositories:[/bold]"]
    for alias, repo in repos.items():
        lines.append(f"  [bold]{alias}[/bold] -> {repo.url} [dim](ref: {repo.ref})[/dim]")
    return "\n".join(lines)


def cmd_prompt(session: Session) -> str:
    return "[dim]Enter your prompt (multi-line). Submit an empty line to finish:[/dim]"


def cmd_prompt_set(session: Session, text: str) -> str:
    session.set_prompt(text)
    return f"[green]Prompt set[/green] [dim]({len(text)} characters)[/dim]"


def cmd_branch_prefix(session: Session, prefix: str) -> str:
    session.set_branch_prefix(prefix)
    return f"[green]Branch prefix set to[/green] [bold]{prefix}[/bold]"


def cmd_auto_pr(session: Session, toggle: str | None = None) -> str:
    if toggle is None:
        current = session.config.target.auto_create_pr
        new_state = not current
    elif toggle.lower() == "on":
        new_state = True
    elif toggle.lower() == "off":
        new_state = False
    else:
        return f"[red]Invalid value:[/red] {toggle}. Use [bold]on[/bold] or [bold]off[/bold]."
    session.set_auto_pr(new_state)
    state_label = "[green]on[/green]" if new_state else "[red]off[/red]"
    return f"[green]Auto PR:[/green] {state_label}"


def cmd_bootstrap_repo(session: Session, name: str) -> str:
    session.set_bootstrap_repo(name)
    return f"[green]Bootstrap repo set to[/green] [bold]{name}[/bold]"


def cmd_config(session: Session) -> str:
    cfg = session.config
    prompt_preview = cfg.prompt[:80] + "..." if len(cfg.prompt) > 80 else cfg.prompt
    repo_count = len(cfg.repositories)
    auto_pr = "[green]on[/green]" if cfg.target.auto_create_pr else "[red]off[/red]"
    lines = [
        "[bold]Current Configuration:[/bold]",
        f"  [bold]Name:[/bold]           {cfg.name}",
        f"  [bold]Model:[/bold]          {cfg.model}",
        f"  [bold]Repositories:[/bold]   {repo_count}",
        f"  [bold]Prompt:[/bold]         {prompt_preview or '[dim]not set[/dim]'}",
        f"  [bold]Branch prefix:[/bold]  {cfg.target.branch_prefix}",
        f"  [bold]Auto PR:[/bold]        {auto_pr}",
        f"  [bold]Bootstrap repo:[/bold] {cfg.bootstrap_repo_name}",
    ]
    return "\n".join(lines)


def cmd_save(session: Session, path: str | None = None) -> str:
    if path:
        session.save(Path(path))
        return f"[green]Config saved to[/green] [bold]{path}[/bold]"
    session.save_session()
    return "[green]Session saved.[/green]"


def cmd_load(session: Session, path: str) -> str:
    target = Path(path)
    if not target.exists():
        return f"[red]File not found:[/red] {path}"
    try:
        session.load(target)
    except Exception as exc:
        return f"[red]Error loading config:[/red] {exc}"
    return f"[green]Config loaded from[/green] [bold]{path}[/bold]"


def cmd_help() -> str:
    lines = ["[bold]Available Commands:[/bold]", ""]
    for info in COMMANDS.values():
        lines.append(f"  [bold]{info.usage}[/bold]")
        lines.append(f"    [dim]{info.description}[/dim]")
    return "\n".join(lines)


def cmd_run(session: Session) -> dict | None:
    errors = session.validate()
    if errors:
        return {"errors": errors}
    return {"config": session.build_config()}


COMMANDS: dict[str, CommandInfo] = {
    "name": CommandInfo(
        name="name",
        handler=cmd_name,
        usage="/name <session-name>",
        description="Set the session name.",
    ),
    "model": CommandInfo(
        name="model",
        handler=cmd_model,
        usage="/model <model-name>",
        description="Set the AI model to use.",
    ),
    "repo": CommandInfo(
        name="repo",
        handler=cmd_repo,
        usage="/repo <alias> <url> [ref]",
        description="Add or replace a repository.",
    ),
    "repo-remove": CommandInfo(
        name="repo-remove",
        handler=cmd_repo_remove,
        usage="/repo-remove <alias>",
        description="Remove a repository by alias.",
    ),
    "repos": CommandInfo(
        name="repos",
        handler=cmd_repos,
        usage="/repos",
        description="List all configured repositories.",
    ),
    "prompt": CommandInfo(
        name="prompt",
        handler=cmd_prompt,
        usage="/prompt",
        description="Enter a multi-line prompt.",
    ),
    "prompt-set": CommandInfo(
        name="prompt-set",
        handler=cmd_prompt_set,
        usage="/prompt-set <text>",
        description="Set the prompt text directly.",
    ),
    "branch-prefix": CommandInfo(
        name="branch-prefix",
        handler=cmd_branch_prefix,
        usage="/branch-prefix <prefix>",
        description="Set the branch name prefix.",
    ),
    "auto-pr": CommandInfo(
        name="auto-pr",
        handler=cmd_auto_pr,
        usage="/auto-pr [on|off]",
        description="Toggle or set automatic PR creation.",
    ),
    "bootstrap-repo": CommandInfo(
        name="bootstrap-repo",
        handler=cmd_bootstrap_repo,
        usage="/bootstrap-repo <name>",
        description="Set the bootstrap repository name.",
    ),
    "config": CommandInfo(
        name="config",
        handler=cmd_config,
        usage="/config",
        description="Show current configuration summary.",
    ),
    "save": CommandInfo(
        name="save",
        handler=cmd_save,
        usage="/save [path]",
        description="Save config to file or session.",
    ),
    "load": CommandInfo(
        name="load",
        handler=cmd_load,
        usage="/load <path>",
        description="Load config from a YAML file.",
    ),
    "help": CommandInfo(
        name="help",
        handler=cmd_help,
        usage="/help",
        description="Show this help message.",
    ),
    "run": CommandInfo(
        name="run",
        handler=cmd_run,
        usage="/run",
        description="Validate and run the orchestrator.",
    ),
}
