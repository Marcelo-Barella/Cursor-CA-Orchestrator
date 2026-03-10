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
    delta = datetime.now(timezone.utc) - start
    total = int(delta.total_seconds())
    if total < 0:
        return "0s"
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
    if finished_at:
        try:
            end = datetime.fromisoformat(finished_at)
        except ValueError:
            end = datetime.now(timezone.utc)
    else:
        end = datetime.now(timezone.utc)
    total = int((end - start).total_seconds())
    if total < 0:
        return "0s"
    minutes, seconds = divmod(total, 60)
    return f"{minutes}:{seconds:02d}"


def _build_header(
    state: OrchestrationState,
    config: OrchestratorConfig,
) -> Text:
    finished = sum(1 for a in state.agents.values() if a.status == "finished")
    total = len(state.agents)
    elapsed = _elapsed_str(state.started_at)
    color = STATUS_COLORS.get(state.status, "white")
    text = Text()
    text.append(f"cursor-orch: {config.name}  ", style="bold")
    text.append(f"[{finished}/{total} tasks]  ", style="dim")
    text.append(f"status: ", style="dim")
    text.append(f"{state.status}  ", style=color)
    text.append(f"elapsed: {elapsed}", style="dim")
    return text


def _build_table(
    state: OrchestrationState,
    config: OrchestratorConfig,
) -> Table:
    table = Table(show_header=True, header_style="bold")
    table.add_column("Task", min_width=12)
    table.add_column("Repo", min_width=10)
    table.add_column("Status", min_width=10)
    table.add_column("Time", min_width=6, justify="right")
    table.add_column("PR", min_width=10)

    task_map = {t.id: t for t in config.tasks}
    for task_id, agent in state.agents.items():
        task = task_map.get(task_id)
        repo = task.repo if task else "?"
        color = STATUS_COLORS.get(agent.status, "white")
        duration = _duration_str(agent.started_at, agent.finished_at)
        pr = agent.pr_url or "--"
        table.add_row(
            task_id,
            repo,
            Text(agent.status.upper(), style=color),
            duration,
            pr,
        )
    return table


def _build_events_panel(events: list[OrchestrationEvent], max_events: int = 10) -> Panel:
    recent = events[-max_events:] if len(events) > max_events else events
    if not recent:
        return Panel("No events yet.", title="Events", border_style="dim")
    lines: list[str] = []
    for ev in recent:
        ts = ev.timestamp
        try:
            dt = datetime.fromisoformat(ts)
            ts = dt.strftime("%H:%M:%S")
        except ValueError:
            pass
        lines.append(f"[{ts}] {ev.detail}")
    return Panel("\n".join(lines), title="Events", border_style="dim")


def _build_blocked_section(state: OrchestrationState) -> str | None:
    blocked = [a for a in state.agents.values() if a.status == "blocked"]
    if not blocked:
        return None
    lines = ["Blocked tasks:"]
    for agent in blocked:
        lines.append(f"  {agent.task_id}: {agent.blocked_reason or 'Unknown reason'}")
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
    from rich.console import Group

    layout = Table.grid(padding=(1, 0))
    layout.add_row(_build_header(state, config))
    layout.add_row(_build_table(state, config))
    blocked_text = _build_blocked_section(state)
    if blocked_text:
        layout.add_row(Text(blocked_text))
    layout.add_row(_build_events_panel(events))
    layout.add_row(Text("Polling every 10s. Press Ctrl+C to detach.", style="dim italic"))
    return layout


def render_live(
    gist_client: GistClient,
    gist_id: str,
    config: OrchestratorConfig,
) -> None:
    from cursor_orch.state import deserialize, read_events

    console = Console()

    try:
        with Live(console=console, refresh_per_second=1) as live:
            while True:
                try:
                    content = gist_client.read_file(gist_id, "state.json")
                    state = deserialize(content)
                    events = read_events(gist_client, gist_id)
                except Exception:
                    time.sleep(POLL_INTERVAL)
                    continue

                layout = _build_layout(state, config, events)
                live.update(layout)

                if state.status in TERMINAL_STATES:
                    time.sleep(2)
                    break

                time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        console.print("\nDetached from dashboard. Orchestration continues in cloud.")
