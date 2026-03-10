from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cursor_orch.api.gist_client import GistClient
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
class OrchestrationState:
    orchestration_id: str
    gist_id: str
    orchestrator_agent_id: str | None = None
    status: str = "pending"
    started_at: str | None = None
    agents: dict[str, AgentState] = field(default_factory=dict)
    error: str | None = None


@dataclass
class OrchestrationEvent:
    timestamp: str
    event_type: str
    task_id: str | None = None
    detail: str = ""


def create_initial_state(config: OrchestratorConfig, gist_id: str) -> OrchestrationState:
    agents = {
        task.id: AgentState(task_id=task.id)
        for task in config.tasks
    }
    return OrchestrationState(
        orchestration_id=gist_id,
        gist_id=gist_id,
        agents=agents,
    )


def serialize(state: OrchestrationState) -> str:
    return json.dumps(asdict(state), indent=2)


def deserialize(json_str: str) -> OrchestrationState:
    raw = json.loads(json_str)
    agents = {
        k: AgentState(**v)
        for k, v in raw.pop("agents", {}).items()
    }
    return OrchestrationState(**raw, agents=agents)


def serialize_event(event: OrchestrationEvent) -> str:
    return json.dumps(asdict(event), separators=(",", ":"))


def deserialize_event(json_str: str) -> OrchestrationEvent:
    return OrchestrationEvent(**json.loads(json_str))


def sync_to_gist(gist_client: GistClient, gist_id: str, state: OrchestrationState) -> None:
    gist_client.write_file(gist_id, "state.json", serialize(state))


def sync_from_gist(gist_client: GistClient, gist_id: str) -> OrchestrationState:
    content = gist_client.read_file(gist_id, "state.json")
    return deserialize(content)


def append_event(gist_client: GistClient, gist_id: str, event: OrchestrationEvent) -> None:
    existing = gist_client.read_file(gist_id, "events.jsonl")
    line = serialize_event(event)
    content = f"{existing}{line}\n" if existing else f"{line}\n"
    content = _rotate_events(content)
    gist_client.write_file(gist_id, "events.jsonl", content)


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


def read_events(gist_client: GistClient, gist_id: str) -> list[OrchestrationEvent]:
    content = gist_client.read_file(gist_id, "events.jsonl")
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
