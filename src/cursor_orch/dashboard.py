from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

if TYPE_CHECKING:
    from cursor_orch.api.gist_client import GistClient
    from cursor_orch.config import OrchestratorConfig
    from cursor_orch.state import OrchestrationEvent, OrchestrationState

POLL_INTERVAL = 10

STATUS_COLORS = {
    "finished": "green",
    "running": "yellow",
    "pending": "blue",
    "failed": "red",
    "blocked": "magenta",
    "launching": "cyan",
    "stopped": "dim",
}

TERMINAL_STATES = {"completed", "failed", "stopped"}


def _elapsed_str(started_at: str | None) -> str:
    if not started_at:
        return "--"
    try:
        start = datetime.fromisoformat(started_at)
    except ValueError:
        return "--"
    total = int((datetime.now(timezone.utc) - start).total_seconds())
    return _format_seconds(max(total, 0))


def _format_seconds(total: int) -> str:
    minutes, seconds = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours > 0:
        return f"{hours}h{minutes:02d}m"
    if minutes > 0:
        return f"{minutes}m{seconds:02d}s"
    return f"{seconds}s"


def _duration_str(started_at: str | None, finished_at: str | None) -> str:
    if not started_at:
        return "--"
    try:
        start = datetime.fromisoformat(started_at)
    except ValueError:
        return "--"
    end = _parse_end_time(finished_at)
    total = int((end - start).total_seconds())
    minutes, seconds = divmod(max(total, 0), 60)
    return f"{minutes}:{seconds:02d}"


def _parse_end_time(finished_at: str | None) -> datetime:
    if not finished_at:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(finished_at)
    except ValueError:
        return datetime.now(timezone.utc)


def _build_header(state: OrchestrationState, config: OrchestratorConfig) -> Text:
    finished = sum(1 for a in state.agents.values() if a.status == "finished")
    total = len(state.agents)
    elapsed = _elapsed_str(state.started_at)
    color = STATUS_COLORS.get(state.status, "white")
    text = Text()
    text.append(f"cursor-orch: {config.name}  ", style="bold")
    tasks_label = "[planning...]" if total == 0 and getattr(config, "prompt", "") else f"[{finished}/{total} tasks]"
    text.append(f"{tasks_label}  ", style="dim")
    text.append("status: ", style="dim")
    text.append(f"{state.status}  ", style=color)
    text.append(f"elapsed: {elapsed}", style="dim")
    return text


def _build_table(state: OrchestrationState, config: OrchestratorConfig) -> Table:
    table = Table(show_header=True, header_style="bold")
    table.add_column("Task", min_width=12)
    table.add_column("Repo", min_width=10)
    table.add_column("Status", min_width=10)
    table.add_column("Time", min_width=6, justify="right")
    table.add_column("PR", min_width=10)
    task_map = {t.id: t for t in config.tasks}
    for task_id, agent in state.agents.items():
        _add_task_row(table, task_id, agent, task_map)
    return table


def _add_task_row(table: Table, task_id: str, agent: object, task_map: dict) -> None:
    task = task_map.get(task_id)
    repo = task.repo if task else "?"
    color = STATUS_COLORS.get(agent.status, "white")
    duration = _duration_str(agent.started_at, agent.finished_at)
    pr = agent.pr_url or "--"
    table.add_row(task_id, repo, Text(agent.status.upper(), style=color), duration, pr)


def _build_events_panel(events: list[OrchestrationEvent], max_events: int = 10) -> Panel:
    recent = events[-max_events:] if len(events) > max_events else events
    if not recent:
        return Panel("No events yet.", title="Events", border_style="dim")
    lines = [_format_event(ev) for ev in recent]
    return Panel("\n".join(lines), title="Events", border_style="dim")


def _format_event(ev: OrchestrationEvent) -> str:
    ts = ev.timestamp
    try:
        ts = datetime.fromisoformat(ts).strftime("%H:%M:%S")
    except ValueError:
        pass
    return f"[{ts}] {ev.detail}"


def _build_blocked_section(state: OrchestrationState) -> str | None:
    blocked = [a for a in state.agents.values() if a.status == "blocked"]
    if not blocked:
        return None
    lines = ["Blocked tasks:"]
    lines.extend(f"  {a.task_id}: {a.blocked_reason or 'Unknown reason'}" for a in blocked)
    return "\n".join(lines)


def render_snapshot(
    state: OrchestrationState,
    config: OrchestratorConfig,
    events: list[OrchestrationEvent],
) -> None:
    console = Console()
    console.print()
    console.print(_build_header(state, config))
    console.print()
    console.print(_build_table(state, config))
    blocked_text = _build_blocked_section(state)
    if blocked_text:
        console.print()
        console.print(blocked_text)
    console.print()
    console.print(_build_events_panel(events))


def _build_layout(
    state: OrchestrationState,
    config: OrchestratorConfig,
    events: list[OrchestrationEvent],
) -> Table:
    layout = Table.grid(padding=(1, 0))
    layout.add_row(_build_header(state, config))
    layout.add_row(_build_table(state, config))
    blocked_text = _build_blocked_section(state)
    if blocked_text:
        layout.add_row(Text(blocked_text))
    layout.add_row(_build_events_panel(events))
    layout.add_row(Text("Polling every 10s. Press Ctrl+C to detach.", style="dim italic"))
    return layout


def _poll_and_render(live: Live, gist_client: GistClient, gist_id: str, config: OrchestratorConfig) -> bool:
    from cursor_orch.state import deserialize, read_events

    try:
        content = gist_client.read_file(gist_id, "state.json")
        state = deserialize(content)
        events = read_events(gist_client, gist_id)
    except Exception:
        return False

    layout = _build_layout(state, config, events)
    live.update(layout)
    return state.status in TERMINAL_STATES


def render_live(gist_client: GistClient, gist_id: str, config: OrchestratorConfig) -> None:
    console = Console()
    try:
        _run_live_loop(console, gist_client, gist_id, config)
    except KeyboardInterrupt:
        console.print("\nDetached from dashboard. Orchestration continues in cloud.")


def _run_live_loop(
    console: Console,
    gist_client: GistClient,
    gist_id: str,
    config: OrchestratorConfig,
) -> None:
    live = Live(console=console, refresh_per_second=1)
    live.start()
    try:
        _live_poll_loop(live, gist_client, gist_id, config)
    finally:
        live.stop()


def _live_poll_loop(
    live: Live,
    gist_client: GistClient,
    gist_id: str,
    config: OrchestratorConfig,
) -> None:
    while True:
        is_terminal = _poll_and_render(live, gist_client, gist_id, config)
        if is_terminal:
            time.sleep(2)
            break
        time.sleep(POLL_INTERVAL)
