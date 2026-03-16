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
    from cursor_orch.api.repo_store import RepoStoreClient
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
    "completed": "green",
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


def _hierarchy_status_priority(status: str) -> int:
    if status in ("running", "launching", "blocked"):
        return 0
    if status == "pending":
        return 1
    if status in ("finished", "completed", "stopped"):
        return 2
    if status == "failed":
        return 3
    return 4


def _build_hierarchy_panel(state: OrchestrationState, config: OrchestratorConfig) -> Panel:
    from cursor_orch.state import LifecycleAgentState, ensure_lifecycle_agents

    ensure_lifecycle_agents(state)
    main = state.main_agent
    if main is None:
        main = LifecycleAgentState(
            node_id="main-orchestrator",
            label=getattr(config, "name", None) or "Orchestrator",
            kind="main",
            status=state.status,
            started_at=state.started_at,
            finished_at=None,
        )
    phases = state.phase_agents or {}
    phase_order = ("planning", "scheduling", "execution", "finalization")
    lines: list[str] = []
    main_color = STATUS_COLORS.get(main.status, "white")
    main_dur = _duration_str(main.started_at, main.finished_at)
    lines.append(f"{main.label}  [{main_color}]{main.status}[/{main_color}]  {main_dur}")
    task_phase_map = getattr(state, "task_phase_map", None) or {}
    assigned: set[str] = set()
    for phase_id in phase_order:
        phase = phases.get(phase_id)
        if phase is None:
            continue
        phase_color = STATUS_COLORS.get(phase.status, "white")
        phase_dur = _duration_str(phase.started_at, phase.finished_at)
        lines.append(f"  {phase.label}  [{phase_color}]{phase.status}[/{phase_color}]  {phase_dur}")
        child_tasks = [(tid, state.agents.get(tid)) for tid, p in task_phase_map.items() if p == phase_id]
        child_tasks.sort(key=lambda x: (_hierarchy_status_priority(getattr(x[1], "status", "pending") or "pending"), x[0]))
        for tid, agent in child_tasks:
            assigned.add(tid)
            status = getattr(agent, "status", "pending") if agent else "pending"
            color = STATUS_COLORS.get(status, "white")
            dur = _duration_str(getattr(agent, "started_at", None), getattr(agent, "finished_at", None)) if agent else "--"
            lines.append(f"    {tid}  [{color}]{status}[/{color}]  {dur}")
    unassigned = [(tid, state.agents.get(tid)) for tid in state.agents if tid not in assigned]
    unassigned.sort(key=lambda x: (_hierarchy_status_priority(getattr(x[1], "status", "pending") or "pending"), x[0]))
    for tid, agent in unassigned:
        status = getattr(agent, "status", "pending") if agent else "pending"
        color = STATUS_COLORS.get(status, "white")
        dur = _duration_str(getattr(agent, "started_at", None), getattr(agent, "finished_at", None)) if agent else "--"
        lines.append(f"  {tid}  [{color}]{status}[/{color}]  {dur}")
    content = "\n".join(lines) if lines else "No hierarchy data."
    try:
        renderable = Text.from_markup(content)
    except Exception:
        renderable = content
    return Panel(renderable, title="Hierarchy", border_style="dim")


def _timeline_event_status(event_type: str) -> str | None:
    if "launch" in event_type or "launched" in event_type:
        return "launching"
    if "blocked" in event_type:
        return "blocked"
    if "retried" in event_type:
        return "running"
    if "finished" in event_type or "completed" in event_type:
        return "finished"
    if "failed" in event_type:
        return "failed"
    if "stopped" in event_type:
        return "stopped"
    if "orchestration_completed" in event_type:
        return "completed"
    if "orchestration_failed" in event_type:
        return "failed"
    if "orchestration_stopped" in event_type:
        return "stopped"
    return None


def _build_timeline_panel(events: list[OrchestrationEvent], max_items: int = 10) -> Panel:
    if not events:
        return Panel("No events yet.", title="Timeline", border_style="dim")
    sorted_events = sorted(events, key=lambda e: e.timestamp)
    recent = sorted_events[-max_items:] if len(sorted_events) > max_items else sorted_events
    lines: list[str] = []
    for ev in recent:
        ts = ev.timestamp
        try:
            ts = datetime.fromisoformat(ts).strftime("%H:%M:%S")
        except ValueError:
            pass
        entity_label = ev.task_id or getattr(ev, "agent_node_id", None) or "Run"
        status = _timeline_event_status(ev.event_type)
        if status:
            color = STATUS_COLORS.get(status, "dim")
            status_part = f"  [{color}]{status}[/{color}]"
        else:
            status_part = ""
        detail = ev.detail or ev.event_type
        lines.append(f"[dim]{ts}[/dim] {entity_label}{status_part}  {detail}")
    try:
        renderable = Text.from_markup("\n".join(lines))
    except Exception:
        renderable = "\n".join(lines)
    return Panel(renderable, title="Timeline", border_style="dim")


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
    console.print()
    console.print(_build_hierarchy_panel(state, config))
    console.print()
    console.print(_build_timeline_panel(events))
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
    layout.add_row(_build_hierarchy_panel(state, config))
    layout.add_row(_build_timeline_panel(events))
    blocked_text = _build_blocked_section(state)
    if blocked_text:
        layout.add_row(Text(blocked_text))
    layout.add_row(_build_events_panel(events))
    layout.add_row(Text("Polling every 10s. Press Ctrl+C to detach.", style="dim italic"))
    return layout


def _poll_and_render(live: Live, repo_store: RepoStoreClient, run_id: str, config: OrchestratorConfig) -> bool:
    from cursor_orch.state import deserialize, read_events

    try:
        content = repo_store.read_file(run_id, "state.json")
        state = deserialize(content)
        events = read_events(repo_store, run_id)
    except Exception:
        return False

    layout = _build_layout(state, config, events)
    live.update(layout)
    return state.status in TERMINAL_STATES


def render_live(repo_store: RepoStoreClient, run_id: str, config: OrchestratorConfig) -> None:
    console = Console()
    try:
        _run_live_loop(console, repo_store, run_id, config)
    except KeyboardInterrupt:
        console.print("\nDetached from dashboard. Orchestration continues in cloud.")


def _run_live_loop(
    console: Console,
    repo_store: RepoStoreClient,
    run_id: str,
    config: OrchestratorConfig,
) -> None:
    live = Live(console=console, refresh_per_second=1)
    live.start()
    try:
        _live_poll_loop(live, repo_store, run_id, config)
    finally:
        live.stop()


def _live_poll_loop(
    live: Live,
    repo_store: RepoStoreClient,
    run_id: str,
    config: OrchestratorConfig,
) -> None:
    while True:
        is_terminal = _poll_and_render(live, repo_store, run_id, config)
        if is_terminal:
            time.sleep(2)
            break
        time.sleep(POLL_INTERVAL)
