from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

from cursor_orch.api.cursor_client import CursorClient
from cursor_orch.api.gist_client import GistClient
from cursor_orch.config import OrchestratorConfig, TaskConfig, parse_config
from cursor_orch.prompt_builder import build_worker_prompt
from cursor_orch.state import (
    AgentState,
    OrchestrationEvent,
    OrchestrationState,
    append_event,
    create_initial_state,
    sync_from_gist,
    sync_to_gist,
)

logger = logging.getLogger(__name__)

POLL_INTERVAL = 30
BLOCKED_TIMEOUT_SECONDS = 300
MAX_RETRY_COUNT = 1
MAX_WORKER_OUTPUT_BYTES = 512 * 1024
MAX_SUMMARY_BYTES = 4096
MAX_OUTPUTS_BYTES = 256 * 1024
RAW_TAIL_BYTES = 8192


def build_dependency_graph(tasks: list[TaskConfig]) -> dict[str, set[str]]:
    return {t.id: set(t.depends_on) for t in tasks}


def get_ready_tasks(graph: dict[str, set[str]], agents: dict[str, AgentState]) -> list[str]:
    ready: list[str] = []
    for task_id, deps in graph.items():
        agent = agents.get(task_id)
        if agent is None or agent.status != "pending":
            continue
        if all(agents.get(d) and agents[d].status == "finished" for d in deps):
            ready.append(task_id)
    return ready


def get_blocked_tasks(agents: dict[str, AgentState]) -> list[AgentState]:
    return [a for a in agents.values() if a.status == "blocked"]


def compute_branch_name(branch_prefix: str, task_id: str, retry_count: int) -> str:
    base = f"{branch_prefix}/{task_id}"
    if retry_count > 0:
        return f"{base}-retry-{retry_count}"
    return base


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_event(event_type: str, detail: str, task_id: str | None = None) -> OrchestrationEvent:
    return OrchestrationEvent(
        timestamp=_now_iso(),
        event_type=event_type,
        task_id=task_id,
        detail=detail,
    )


def _read_worker_output(gist_client: GistClient, gist_id: str, task_id: str) -> dict | None:
    content = gist_client.read_file(gist_id, f"agent-{task_id}.json")
    if not content:
        return None
    raw_bytes = content.encode("utf-8")
    if len(raw_bytes) > MAX_WORKER_OUTPUT_BYTES:
        logger.warning(f"Worker output for {task_id} exceeds 512KB ({len(raw_bytes)} bytes), truncating")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        logger.warning(f"Worker output for {task_id} is not valid JSON, storing raw tail")
        tail = content[-RAW_TAIL_BYTES:] if len(content) > RAW_TAIL_BYTES else content
        return {"task_id": task_id, "status": "completed", "truncated": True, "raw_tail": tail}
    return _truncate_output(data, task_id)


def _truncate_output(data: dict, task_id: str) -> dict:
    summary = data.get("summary", "")
    if isinstance(summary, str) and len(summary.encode("utf-8")) > MAX_SUMMARY_BYTES:
        logger.warning(f"Worker output summary for {task_id} exceeds 4KB, truncating")
        data["summary"] = summary[:MAX_SUMMARY_BYTES] + "\n[TRUNCATED]"
    outputs = data.get("outputs")
    if not isinstance(outputs, dict):
        return data
    serialized = json.dumps(outputs).encode("utf-8")
    if len(serialized) <= MAX_OUTPUTS_BYTES:
        return data
    logger.warning(f"Worker outputs for {task_id} exceed 256KB ({len(serialized)} bytes), truncating")
    while len(json.dumps(outputs).encode("utf-8")) > MAX_OUTPUTS_BYTES and outputs:
        largest_key = max(outputs, key=lambda k: len(json.dumps(outputs[k]).encode("utf-8")))
        val = json.dumps(outputs[largest_key])
        tail = val[-32768:] if len(val) > 32768 else val
        outputs[largest_key] = f"[TRUNCATED]\n{tail}"
        if len(json.dumps(outputs).encode("utf-8")) <= MAX_OUTPUTS_BYTES:
            break
    data["outputs"] = outputs
    data["truncated"] = True
    return data


def _build_summary_md(config: OrchestratorConfig, state: OrchestrationState) -> str:
    finished = sum(1 for a in state.agents.values() if a.status == "finished")
    total = len(state.agents)
    lines = [
        f"# {config.name}",
        f"**Status:** {state.status} | **Progress:** {finished}/{total} tasks",
        "",
        "| Task | Repo | Status | PR |",
        "|------|------|--------|----|",
    ]
    task_map = {t.id: t for t in config.tasks}
    for task_id, agent in state.agents.items():
        task = task_map.get(task_id)
        repo = task.repo if task else "?"
        pr = agent.pr_url or "--"
        lines.append(f"| {task_id} | {repo} | {agent.status} | {pr} |")
    return "\n".join(lines)


def _cascade_failures(
    state: OrchestrationState,
    failed_task_id: str,
    graph: dict[str, set[str]],
    gist_client: GistClient,
    gist_id: str,
) -> list[str]:
    cascaded: list[str] = []
    for task_id, deps in graph.items():
        if failed_task_id not in deps:
            continue
        agent = state.agents.get(task_id)
        if agent is None or agent.status not in ("pending", "blocked"):
            continue
        agent.status = "failed"
        agent.summary = f"Upstream task {failed_task_id} failed"
        cascaded.append(task_id)
        append_event(
            gist_client, gist_id,
            _make_event("task_failed", f"Task {task_id} failed: upstream {failed_task_id} failed", task_id),
        )
    return cascaded


def _has_unsatisfiable_tasks(state: OrchestrationState, graph: dict[str, set[str]]) -> bool:
    failed_ids = {tid for tid, a in state.agents.items() if a.status == "failed"}
    for task_id, deps in graph.items():
        agent = state.agents.get(task_id)
        if agent and agent.status in ("pending", "blocked"):
            if deps & failed_ids:
                return True
    return False


def _poll_agents(
    state: OrchestrationState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
) -> None:
    for task_id, agent in state.agents.items():
        if agent.status not in ("running", "launching"):
            continue
        if agent.agent_id is None:
            continue
        try:
            info = cursor_client.get_agent(agent.agent_id)
        except Exception:
            logger.exception(f"Failed to poll agent {agent.agent_id} for task {task_id}")
            continue
        if info.status == "FINISHED":
            agent.status = "finished"
            agent.finished_at = _now_iso()
            agent.pr_url = info.pr_url
            agent.summary = info.summary
            _read_worker_output(gist_client, gist_id, task_id)
            append_event(gist_client, gist_id, _make_event("task_finished", f"Task {task_id} finished", task_id))
            continue
        if info.status == "ERROR":
            agent.status = "failed"
            agent.finished_at = _now_iso()
            agent.summary = info.summary or "Agent error"
            append_event(gist_client, gist_id, _make_event("task_failed", f"Task {task_id} failed: agent error", task_id))
            continue
        if info.status in ("RUNNING", "CREATING"):
            if agent.status == "launching":
                agent.status = "running"
            output = _read_worker_output(gist_client, gist_id, task_id)
            if output and output.get("status") == "blocked":
                agent.status = "blocked"
                agent.blocked_reason = output.get("blocked_reason", "Unknown")
                if agent.blocked_since is None:
                    agent.blocked_since = _now_iso()
                append_event(gist_client, gist_id, _make_event("task_blocked", f"Task {task_id} blocked: {agent.blocked_reason}", task_id))


def _handle_blocked(
    state: OrchestrationState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
    graph: dict[str, set[str]],
) -> None:
    now = datetime.now(timezone.utc)
    for agent in get_blocked_tasks(state.agents):
        if agent.blocked_since is None:
            continue
        blocked_dt = datetime.fromisoformat(agent.blocked_since)
        elapsed = (now - blocked_dt).total_seconds()
        if elapsed <= BLOCKED_TIMEOUT_SECONDS:
            continue
        if agent.retry_count < MAX_RETRY_COUNT and agent.agent_id:
            prompt = (
                f"Your previous attempt was blocked. Reason: {agent.blocked_reason}. "
                "Please try a different approach or report blocked again with a specific reason."
            )
            try:
                cursor_client.send_followup(agent.agent_id, prompt)
            except Exception:
                logger.exception(f"Failed to send followup for blocked task {agent.task_id}")
            agent.retry_count += 1
            agent.status = "running"
            agent.blocked_reason = None
            agent.blocked_since = None
            try:
                gist_client.delete_file(gist_id, f"agent-{agent.task_id}.json")
            except Exception:
                logger.warning(f"Failed to delete agent-{agent.task_id}.json for retry")
            append_event(gist_client, gist_id, _make_event("task_retried", f"Task {agent.task_id} retried", agent.task_id))
            continue
        agent.status = "failed"
        agent.finished_at = _now_iso()
        agent.summary = agent.blocked_reason or "Blocked and retries exhausted"
        if agent.agent_id:
            try:
                cursor_client.stop_agent(agent.agent_id)
            except Exception:
                logger.warning(f"Failed to stop blocked agent {agent.agent_id}")
        append_event(gist_client, gist_id, _make_event("task_failed", f"Task {agent.task_id} failed: blocked", agent.task_id))
        _cascade_failures(state, agent.task_id, graph, gist_client, gist_id)


def _launch_ready_tasks(
    state: OrchestrationState,
    config: OrchestratorConfig,
    graph: dict[str, set[str]],
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
) -> None:
    ready = get_ready_tasks(graph, state.agents)
    task_map = {t.id: t for t in config.tasks}
    gh_token = os.environ["GH_TOKEN"]

    for task_id in ready:
        task = task_map[task_id]
        dep_outputs: dict[str, dict] = {}
        for dep_id in task.depends_on:
            output = _read_worker_output(gist_client, gist_id, dep_id)
            dep_outputs[dep_id] = output.get("outputs", {}) if output else {}

        prompt = build_worker_prompt(task, gist_id, gh_token, dep_outputs)
        branch = compute_branch_name(config.target.branch_prefix, task_id, state.agents[task_id].retry_count)
        repo_config = config.repositories[task.repo]
        model = task.model or config.model

        try:
            info = cursor_client.launch_agent(
                prompt=prompt,
                repository=repo_config.url,
                ref=repo_config.ref,
                model=model,
                branch_name=branch,
                auto_pr=config.target.auto_create_pr,
            )
        except Exception:
            logger.exception(f"Failed to launch agent for task {task_id}")
            state.agents[task_id].status = "failed"
            state.agents[task_id].summary = "Failed to launch agent"
            append_event(gist_client, gist_id, _make_event("task_failed", f"Task {task_id} failed: launch error", task_id))
            continue

        agent = state.agents[task_id]
        agent.agent_id = info.id
        agent.status = "launching"
        agent.started_at = _now_iso()
        append_event(gist_client, gist_id, _make_event("task_launched", f"Launched {task_id} ({info.id})", task_id))


def _stop_all_running(state: OrchestrationState, cursor_client: CursorClient) -> None:
    for agent in state.agents.values():
        if agent.status in ("running", "launching") and agent.agent_id:
            try:
                cursor_client.stop_agent(agent.agent_id)
                agent.status = "stopped"
                agent.finished_at = _now_iso()
            except Exception:
                logger.warning(f"Failed to stop agent {agent.agent_id}")


def run_orchestration(gist_id: str, cursor_client: CursorClient, gist_client: GistClient) -> None:
    config_str = gist_client.read_file(gist_id, "config.yaml")
    config = parse_config(config_str)

    try:
        state = sync_from_gist(gist_client, gist_id)
    except Exception:
        state = create_initial_state(config, gist_id)

    if state.status == "pending":
        state.status = "running"
        state.started_at = _now_iso()
        sync_to_gist(gist_client, gist_id, state)
        append_event(gist_client, gist_id, _make_event("orchestration_started", "Orchestration started"))

    graph = build_dependency_graph(config.tasks)

    try:
        _orchestration_loop(state, config, graph, cursor_client, gist_client, gist_id)
    except Exception as exc:
        logger.exception("Orchestration loop failed")
        state.status = "failed"
        state.error = str(exc)
        sync_to_gist(gist_client, gist_id, state)
        raise


def _orchestration_loop(
    state: OrchestrationState,
    config: OrchestratorConfig,
    graph: dict[str, set[str]],
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
) -> None:
    while True:
        stop_content = gist_client.read_file(gist_id, "stop-requested.json")
        if stop_content:
            logger.info("Stop requested, halting orchestration")
            _stop_all_running(state, cursor_client)
            state.status = "stopped"
            summary_md = _build_summary_md(config, state)
            gist_client.write_file(gist_id, "summary.md", summary_md)
            sync_to_gist(gist_client, gist_id, state)
            append_event(gist_client, gist_id, _make_event("orchestration_stopped", "Orchestration stopped by user"))
            break

        _poll_agents(state, cursor_client, gist_client, gist_id)
        _handle_blocked(state, cursor_client, gist_client, gist_id, graph)
        _launch_ready_tasks(state, config, graph, cursor_client, gist_client, gist_id)

        summary_md = _build_summary_md(config, state)
        gist_client.write_file(gist_id, "summary.md", summary_md)
        sync_to_gist(gist_client, gist_id, state)

        if all(a.status == "finished" for a in state.agents.values()):
            state.status = "completed"
            sync_to_gist(gist_client, gist_id, state)
            append_event(gist_client, gist_id, _make_event("orchestration_completed", "All tasks completed"))
            logger.info("Orchestration completed successfully")
            break

        failed_ids = {tid for tid, a in state.agents.items() if a.status == "failed"}
        if failed_ids:
            for fid in list(failed_ids):
                _cascade_failures(state, fid, graph, gist_client, gist_id)
            pending_viable = [
                tid for tid, a in state.agents.items()
                if a.status in ("pending", "running", "launching", "blocked")
            ]
            if not pending_viable:
                state.status = "failed"
                state.error = f"Failed tasks: {', '.join(sorted(failed_ids))}"
                sync_to_gist(gist_client, gist_id, state)
                append_event(gist_client, gist_id, _make_event("orchestration_failed", f"Orchestration failed: {state.error}"))
                logger.error(f"Orchestration failed: {state.error}")
                break

        sleep_time = POLL_INTERVAL
        remaining = gist_client.rate_limit_remaining
        if remaining is not None and gist_client._rate_limit_limit is not None:
            used_pct = 1.0 - (remaining / gist_client._rate_limit_limit)
            if used_pct > 0.8:
                sleep_time = POLL_INTERVAL * 2
                logger.warning(f"Rate limit >80% consumed ({remaining} remaining), doubling poll interval to {sleep_time}s")
        time.sleep(sleep_time)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    gist_id = os.environ["GIST_ID"]
    gh_token = os.environ["GH_TOKEN"]
    cursor_api_key = os.environ["CURSOR_API_KEY"]

    cursor_client = CursorClient(api_key=cursor_api_key)
    gist_client = GistClient(token=gh_token)

    run_orchestration(gist_id, cursor_client, gist_client)
