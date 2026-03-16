from __future__ import annotations

import json
from datetime import datetime, timezone
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cursor_orch.api.repo_store import RepoStoreClient
    from cursor_orch.config import OrchestratorConfig

MAX_EVENTS_BYTES = 256 * 1024
ROTATE_KEEP_BYTES = 128 * 1024


@dataclass
class AgentState:
    task_id: str
    agent_id: str | None = None
    status: str = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    pr_url: str | None = None
    summary: str | None = None
    blocked_reason: str | None = None
    blocked_since: str | None = None
    retry_count: int = 0


@dataclass
class LifecycleAgentState:
    node_id: str
    label: str
    kind: str
    status: str = "pending"
    parent_node_id: str | None = None
    task_id: str | None = None
    agent_id: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


@dataclass
class OrchestrationState:
    orchestration_id: str
    run_id: str
    orchestrator_agent_id: str | None = None
    status: str = "pending"
    started_at: str | None = None
    agents: dict[str, AgentState] = field(default_factory=dict)
    main_agent: LifecycleAgentState | None = None
    phase_agents: dict[str, LifecycleAgentState] = field(default_factory=dict)
    task_phase_map: dict[str, str] = field(default_factory=dict)
    error: str | None = None


@dataclass
class OrchestrationEvent:
    timestamp: str
    event_type: str
    task_id: str | None = None
    phase_id: str | None = None
    agent_node_id: str | None = None
    agent_kind: str | None = None
    detail: str = ""
    payload: dict[str, str] = field(default_factory=dict)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_phase_agents() -> dict[str, LifecycleAgentState]:
    return {
        "planning": LifecycleAgentState(
            node_id="phase-planning",
            label="Planning",
            kind="phase",
            parent_node_id="main-orchestrator",
        ),
        "scheduling": LifecycleAgentState(
            node_id="phase-scheduling",
            label="Scheduling",
            kind="phase",
            parent_node_id="main-orchestrator",
        ),
        "execution": LifecycleAgentState(
            node_id="phase-execution",
            label="Execution",
            kind="phase",
            parent_node_id="main-orchestrator",
        ),
        "finalization": LifecycleAgentState(
            node_id="phase-finalization",
            label="Finalization",
            kind="phase",
            parent_node_id="main-orchestrator",
        ),
    }


def create_initial_state(config: OrchestratorConfig, run_id: str) -> OrchestrationState:
    agents = {
        task.id: AgentState(task_id=task.id)
        for task in config.tasks
    }
    state = OrchestrationState(
        orchestration_id=run_id,
        run_id=run_id,
        agents=agents,
    )
    ensure_lifecycle_agents(state)
    return state


def ensure_lifecycle_agents(state: OrchestrationState) -> None:
    if state.main_agent is None:
        state.main_agent = LifecycleAgentState(
            node_id="main-orchestrator",
            label="Main Orchestrator",
            kind="main",
            status=state.status,
            agent_id=state.orchestrator_agent_id,
            started_at=state.started_at,
        )
    else:
        if state.main_agent.agent_id is None and state.orchestrator_agent_id:
            state.main_agent.agent_id = state.orchestrator_agent_id
        if state.main_agent.started_at is None and state.started_at:
            state.main_agent.started_at = state.started_at
    if not state.phase_agents:
        state.phase_agents = _default_phase_agents()
    else:
        defaults = _default_phase_agents()
        for phase_id, default in defaults.items():
            state.phase_agents.setdefault(phase_id, default)


def seed_main_agent(
    state: OrchestrationState,
    *,
    agent_id: str | None,
    status: str,
    started_at: str | None = None,
) -> None:
    ensure_lifecycle_agents(state)
    state.orchestrator_agent_id = agent_id
    if state.main_agent is None:
        return
    state.main_agent.agent_id = agent_id
    state.main_agent.status = status
    if started_at:
        state.main_agent.started_at = started_at
    elif state.main_agent.started_at is None:
        state.main_agent.started_at = _now_iso()


def set_phase_status(
    state: OrchestrationState,
    phase_id: str,
    status: str,
    *,
    timestamp: str | None = None,
) -> None:
    ensure_lifecycle_agents(state)
    phase = state.phase_agents.get(phase_id)
    if phase is None:
        phase = LifecycleAgentState(
            node_id=f"phase-{phase_id}",
            label=phase_id.replace("-", " ").title(),
            kind="phase",
            parent_node_id="main-orchestrator",
        )
        state.phase_agents[phase_id] = phase
    phase.status = status
    if status in ("running", "launching") and phase.started_at is None:
        phase.started_at = timestamp or _now_iso()
    if status in ("finished", "failed", "stopped"):
        phase.finished_at = timestamp or _now_iso()


def assign_task_phase(state: OrchestrationState, task_id: str, phase_id: str) -> None:
    ensure_lifecycle_agents(state)
    state.task_phase_map[task_id] = phase_id


def serialize(state: OrchestrationState) -> str:
    return json.dumps(asdict(state), indent=2)


def _lifecycle_agent_from_dict(d: dict, default_node_id: str, default_label: str, default_kind: str) -> LifecycleAgentState:
    return LifecycleAgentState(
        node_id=d.get("node_id") or default_node_id,
        label=d.get("label") or default_label,
        kind=d.get("kind") or default_kind,
        status=d.get("status", "pending"),
        parent_node_id=d.get("parent_node_id"),
        task_id=d.get("task_id"),
        agent_id=d.get("agent_id"),
        started_at=d.get("started_at"),
        finished_at=d.get("finished_at"),
    )


def deserialize(json_str: str) -> OrchestrationState:
    raw = json.loads(json_str)
    if "gist_id" in raw and "run_id" not in raw:
        raw["run_id"] = raw.pop("gist_id")
    elif "gist_id" in raw:
        raw.pop("gist_id")
    agents = {
        k: AgentState(**v)
        for k, v in raw.pop("agents", {}).items()
    }
    raw_main_agent = raw.pop("main_agent", None)
    main_agent = (
        _lifecycle_agent_from_dict(raw_main_agent, "main-orchestrator", "Main Orchestrator", "main")
        if isinstance(raw_main_agent, dict) and raw_main_agent
        else None
    )
    phase_agents = {}
    for phase_id, phase_data in raw.pop("phase_agents", {}).items():
        if not isinstance(phase_data, dict):
            continue
        default_node_id = f"phase-{phase_id}"
        default_label = phase_id.replace("-", " ").title()
        phase_agents[phase_id] = _lifecycle_agent_from_dict(phase_data, default_node_id, default_label, "phase")
    task_phase_map = {
        str(task_id): str(phase_id)
        for task_id, phase_id in raw.pop("task_phase_map", {}).items()
    }
    state = OrchestrationState(
        **raw,
        agents=agents,
        main_agent=main_agent,
        phase_agents=phase_agents,
        task_phase_map=task_phase_map,
    )
    ensure_lifecycle_agents(state)
    return state


def serialize_event(event: OrchestrationEvent) -> str:
    return json.dumps(asdict(event), separators=(",", ":"))


def deserialize_event(json_str: str) -> OrchestrationEvent:
    return OrchestrationEvent(**json.loads(json_str))


def sync_to_repo(repo_store: RepoStoreClient, run_id: str, state: OrchestrationState) -> None:
    repo_store.write_file(run_id, "state.json", serialize(state))


def sync_from_repo(repo_store: RepoStoreClient, run_id: str) -> OrchestrationState:
    content = repo_store.read_file(run_id, "state.json")
    return deserialize(content)


def append_event(repo_store: RepoStoreClient, run_id: str, event: OrchestrationEvent) -> None:
    existing = repo_store.read_file(run_id, "events.jsonl")
    line = serialize_event(event)
    content = f"{existing}{line}\n" if existing else f"{line}\n"
    content = _rotate_events(content)
    repo_store.write_file(run_id, "events.jsonl", content)


def _rotate_events(content: str) -> str:
    if len(content.encode("utf-8")) <= MAX_EVENTS_BYTES:
        return content
    encoded = content.encode("utf-8")
    tail = encoded[-ROTATE_KEEP_BYTES:]
    text = tail.decode("utf-8", errors="replace")
    first_newline = text.find("\n")
    if first_newline >= 0:
        return text[first_newline + 1:]
    return text


def read_events(repo_store: RepoStoreClient, run_id: str) -> list[OrchestrationEvent]:
    content = repo_store.read_file(run_id, "events.jsonl")
    if not content.strip():
        return []
    events: list[OrchestrationEvent] = []
    for line in content.strip().split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            events.append(deserialize_event(stripped))
        except (json.JSONDecodeError, TypeError):
            continue
    return events
