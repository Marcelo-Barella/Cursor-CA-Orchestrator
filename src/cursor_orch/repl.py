from __future__ import annotations

from pathlib import Path

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import WordCompleter
from prompt_toolkit.history import FileHistory
from rich.console import Console

from cursor_orch.commands import COMMANDS, cmd_help, cmd_prompt_set, cmd_run
from cursor_orch.config import OrchestratorConfig
from cursor_orch.session import Session

_NON_MUTATION = {"help", "config", "repos", "run"}


def _build_completer() -> WordCompleter:
    words = [f"/{k}" for k in COMMANDS]
    words.extend(["/exit", "/quit", "/clear"])
    return WordCompleter(words)


def _parse_input(raw: str) -> tuple[str, list[str]]:
    parts = raw[1:].split()
    if not parts:
        return "", []
    cmd = parts[0]
    args = parts[1:]
    if cmd == "repo" and args and args[0] == "remove":
        return "repo-remove", args[1:]
    return cmd, args


def _read_multiline(prompt_session: PromptSession, console: Console) -> str | None:
    lines: list[str] = []
    while True:
        try:
            line = prompt_session.prompt("... ")
        except KeyboardInterrupt:
            console.print("[red]Prompt input cancelled.[/red]")
            return None
        except EOFError:
            break
        if line == "":
            break
        lines.append(line)
    if not lines:
        return None
    return "\n".join(lines)


def _handle_run(session: Session, console: Console) -> OrchestratorConfig | None:
    result = cmd_run(session)
    if result is None:
        return None
    if "errors" in result:
        for err in result["errors"]:
            console.print(f"[red]Error:[/red] {err}")
        return None
    if "config" in result:
        return result["config"]
    return None


def _dispatch(
    cmd: str,
    args: list[str],
    session: Session,
    console: Console,
) -> str | None:
    cmd_info = COMMANDS[cmd]
    if cmd == "help":
        return cmd_help()
    try:
        return cmd_info.handler(session, *args)
    except TypeError:
        return f"[red]Usage:[/red] {cmd_info.usage}"


def run_repl() -> OrchestratorConfig | None:
    session = Session()
    console = Console()

    history_dir = Path.home() / ".cursor-orch"
    history_dir.mkdir(parents=True, exist_ok=True)
    history_path = history_dir / "history"

    prompt_session: PromptSession[str] = PromptSession(
        history=FileHistory(str(history_path)),
        completer=_build_completer(),
    )

    console.print("[bold]cursor-orch v0.1.0[/bold]")
    console.print("[dim]Type /help for available commands.[/dim]")

    if session.load_session():
        console.print("[green]Resumed previous session. Type /config to review.[/green]")

    while True:
        try:
            text = prompt_session.prompt("> ").strip()
        except KeyboardInterrupt:
            continue
        except EOFError:
            break

        if not text:
            continue

        if not text.startswith("/"):
            console.print("Unknown input. Type /help for available commands.")
            continue

        cmd, args = _parse_input(text)
        if not cmd:
            continue

        if cmd in ("exit", "quit"):
            return None

        if cmd == "clear":
            console.clear()
            continue

        if cmd not in COMMANDS:
            console.print(f"[red]Unknown command:[/red] /{cmd}. Type /help for available commands.")
            continue

        if cmd == "prompt":
            console.print(COMMANDS["prompt"].handler(session))
            multiline_text = _read_multiline(prompt_session, console)
            if multiline_text is not None:
                result = cmd_prompt_set(session, multiline_text)
                console.print(result)
                session.save_session()
            continue

        if cmd == "run":
            config = _handle_run(session, console)
            if config is not None:
                return config
            continue

        output = _dispatch(cmd, args, session, console)
        if output:
            console.print(output)

        if cmd not in _NON_MUTATION:
            session.save_session()

    return None
