from __future__ import annotations

from pathlib import Path

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import WordCompleter
from prompt_toolkit.history import FileHistory
from rich.console import Console

from cursor_orch.commands import (
    COMMANDS,
    cmd_help,
    cmd_prompt_set,
    cmd_run,
    prompt_set_command_text,
    setup_summary_lines,
    validate_model_value,
    validate_prompt_value,
)
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
        session.clear_setup_state()
        session.save_session()
        return result["config"]
    return None


def _is_control(value: str, control: str) -> bool:
    return value.strip().lower() == control


def _run_guided_setup(
    session: Session,
    prompt_session: PromptSession[str],
    console: Console,
) -> OrchestratorConfig | None:
    console.print("Welcome to cursor-orch interactive setup.")
    console.print("I will ask only what is required for your first run.")
    console.print("Controls: type 'skip' (use default), 'back' (previous step), or 'exit' (cancel setup).")

    setup_state = session.setup_state()
    step = str(setup_state.get("step", "model"))
    if step not in {"model", "prompt", "confirm"}:
        step = "model"
    if step == "confirm" and not session.has_required_guided_values():
        step = "model"

    session.set_setup_state(active=True, step=step)
    session.save_session()

    while True:
        if step == "model":
            console.print("Step 1/2 - Model")
            try:
                raw = prompt_session.prompt("AI model [default: gpt-5]: ")
            except KeyboardInterrupt:
                console.print("Setup cancelled. Returning to REPL.")
                session.set_setup_state(active=True, step="model")
                session.save_session()
                return None
            except EOFError:
                console.print("Setup closed. Returning to REPL.")
                session.set_setup_state(active=True, step="model")
                session.save_session()
                return None
            text = raw.strip()
            if _is_control(text, "exit"):
                session.set_setup_state(active=True, step="model")
                session.save_session()
                return None
            if _is_control(text, "back"):
                console.print("Already at first step.")
                continue
            if text == "" or _is_control(text, "skip"):
                value = "gpt-5"
            else:
                error = validate_model_value(text)
                if error:
                    console.print(f"[red]{error}[/red]")
                    continue
                value = text
            session.set_model(value)
            session.set_setup_state(active=True, step="prompt")
            session.save_session()
            console.print(f"Model set to: {value}")
            console.print(f"Equivalent command: /model {value}")
            step = "prompt"
            continue

        if step == "prompt":
            console.print("Step 2/2 - Prompt")
            console.print("Enter orchestration prompt. Finish with an empty line.")
            console.print("Prompt (required):")
            lines: list[str] = []
            while True:
                try:
                    line = prompt_session.prompt("... ")
                except KeyboardInterrupt:
                    console.print("Setup cancelled. Returning to REPL.")
                    session.set_setup_state(active=True, step="prompt")
                    session.save_session()
                    return None
                except EOFError:
                    console.print("Setup closed. Returning to REPL.")
                    session.set_setup_state(active=True, step="prompt")
                    session.save_session()
                    return None
                if not lines:
                    stripped = line.strip()
                    if _is_control(stripped, "back"):
                        step = "model"
                        session.set_setup_state(active=True, step="model")
                        session.save_session()
                        break
                    if _is_control(stripped, "exit"):
                        session.set_setup_state(active=True, step="prompt")
                        session.save_session()
                        return None
                    if _is_control(stripped, "skip"):
                        console.print("Prompt is required for first run. Enter prompt text or type 'back'/'exit'.")
                        continue
                if line == "":
                    prompt_text = "\n".join(lines)
                    error = validate_prompt_value(prompt_text)
                    if error:
                        console.print(error)
                        lines = []
                        continue
                    session.set_prompt(prompt_text)
                    session.set_setup_state(active=True, step="confirm")
                    session.save_session()
                    console.print(f"Prompt captured ({len(prompt_text)} characters).")
                    console.print("Equivalent command: /prompt")
                    console.print(f"Equivalent command: {prompt_set_command_text(prompt_text)}")
                    step = "confirm"
                    break
                lines.append(line)
            continue

        if step == "confirm":
            console.print("Setup complete. Review before execution:")
            for line in setup_summary_lines(session):
                console.print(line)
            console.print("Next actions:")
            console.print("1) run   -> execute now")
            console.print("2) back  -> edit previous step")
            console.print("3) exit  -> cancel and return to REPL")
            while True:
                try:
                    action = prompt_session.prompt("Choose action [run/back/exit]: ").strip().lower()
                except KeyboardInterrupt:
                    console.print("Setup cancelled. Returning to REPL.")
                    session.set_setup_state(active=True, step="confirm")
                    session.save_session()
                    return None
                except EOFError:
                    console.print("Setup closed. Returning to REPL.")
                    session.set_setup_state(active=True, step="confirm")
                    session.save_session()
                    return None
                if action == "back":
                    step = "prompt"
                    session.set_setup_state(active=True, step="prompt")
                    session.save_session()
                    break
                if action == "exit":
                    session.set_setup_state(active=True, step="confirm")
                    session.save_session()
                    return None
                if action == "run":
                    console.print("Equivalent command: /run")
                    result = cmd_run(session)
                    if result is None:
                        console.print("Run blocked: unknown error")
                        console.print("Type 'back' to edit required input or 'exit' to return to REPL.")
                        continue
                    if "errors" in result:
                        console.print(f"Run blocked: {result['errors'][0]}")
                        console.print("Type 'back' to edit required input or 'exit' to return to REPL.")
                        continue
                    if "config" in result:
                        session.clear_setup_state()
                        session.save_session()
                        console.print("Setup complete. Launching run.")
                        return result["config"]
                else:
                    console.print("Invalid choice. Type run, back, or exit.")
            continue


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

    console.print("[bold]cursor-orch v0.2.0[/bold]")
    console.print("[dim]Type /help for available commands.[/dim]")
    console.print("[dim]Next: complete guided setup (or set prompt via /prompt), then run /run.[/dim]")
    console.print("[dim]Before /run, ensure CURSOR_API_KEY and GH_TOKEN are set (copy .env.example to .env).[/dim]")

    resumed = session.load_session()
    if resumed:
        console.print("[green]Resumed previous session. Type /config to review.[/green]")

    direct_commands_entered = False
    setup_state = session.setup_state()
    setup_active = bool(setup_state.get("active", False))
    if setup_active:
        step = str(setup_state.get("step", "model"))
        console.print(f"[yellow]Resuming guided setup from step: {step}.[/yellow]")
    should_run_guided = session.should_resume_guided_setup() or (
        (not session.has_required_guided_values()) and not direct_commands_entered
    )
    if should_run_guided:
        config = _run_guided_setup(session, prompt_session, console)
        if config is not None:
            return config

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

        direct_commands_entered = True

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
