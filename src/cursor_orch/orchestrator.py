from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

import requests

from cursor_orch.api.cursor_client import CursorClient
from cursor_orch.api.gist_client import GistClient
from cursor_orch.config import OrchestratorConfig, TaskConfig, parse_config, to_yaml
from cursor_orch.planner import build_planner_prompt, parse_task_plan, wait_for_plan
from cursor_orch.prompt_builder import build_repo_creation_prompt, build_worker_prompt
from cursor_orch.state import (
    AgentState,
    OrchestrationEvent,
    OrchestrationState,
    assign_task_phase,
    append_event,
    create_initial_state,
    ensure_lifecycle_agents,
    seed_main_agent,
    set_phase_status,
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
    return [
        task_id
        for task_id, deps in graph.items()
        if _is_task_ready(task_id, deps, agents)
    ]


def _is_task_ready(task_id: str, deps: set[str], agents: dict[str, AgentState]) -> bool:
    agent = agents.get(task_id)
    if agent is None or agent.status != "pending":
        return False
    return all(agents.get(d) and agents[d].status == "finished" for d in deps)


def get_blocked_tasks(agents: dict[str, AgentState]) -> list[AgentState]:
    return [a for a in agents.values() if a.status == "blocked"]


def compute_branch_name(branch_prefix: str, task_id: str, retry_count: int) -> str:
    base = f"{branch_prefix}/{task_id}"
    if retry_count > 0:
        return f"{base}-retry-{retry_count}"
    return base


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_event(
    event_type: str,
    detail: str,
    task_id: str | None = None,
    *,
    phase_id: str | None = None,
    agent_node_id: str | None = None,
    agent_kind: str | None = None,
    payload: dict[str, str] | None = None,
) -> OrchestrationEvent:
    return OrchestrationEvent(
        timestamp=_now_iso(),
        event_type=event_type,
        task_id=task_id,
        phase_id=phase_id,
        agent_node_id=agent_node_id,
        agent_kind=agent_kind,
        detail=detail,
        payload=payload or {},
    )


def _read_worker_output(gist_client: GistClient, gist_id: str, task_id: str) -> dict | None:
    content = gist_client.read_file(gist_id, f"agent-{task_id}.json")
    if not content:
        return None
    if len(content.encode("utf-8")) > MAX_WORKER_OUTPUT_BYTES:
        logger.warning(f"Worker output for {task_id} exceeds 512KB, truncating")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        logger.warning(f"Worker output for {task_id} is not valid JSON, storing raw tail")
        tail = content[-RAW_TAIL_BYTES:] if len(content) > RAW_TAIL_BYTES else content
        return {"task_id": task_id, "status": "completed", "truncated": True, "raw_tail": tail}
    return _truncate_output(data, task_id)


def _truncate_output(data: dict, task_id: str) -> dict:
    _truncate_summary(data, task_id)
    _truncate_outputs(data, task_id)
    return data


def _truncate_summary(data: dict, task_id: str) -> None:
    summary = data.get("summary", "")
    if not isinstance(summary, str):
        return
    if len(summary.encode("utf-8")) <= MAX_SUMMARY_BYTES:
        return
    logger.warning(f"Worker output summary for {task_id} exceeds 4KB, truncating")
    data["summary"] = summary[:MAX_SUMMARY_BYTES] + "\n[TRUNCATED]"


def _truncate_outputs(data: dict, task_id: str) -> None:
    outputs = data.get("outputs")
    if not isinstance(outputs, dict):
        return
    serialized_len = len(json.dumps(outputs).encode("utf-8"))
    if serialized_len <= MAX_OUTPUTS_BYTES:
        return
    logger.warning(f"Worker outputs for {task_id} exceed 256KB ({serialized_len} bytes), truncating")
    _shrink_outputs(outputs)
    data["truncated"] = True


def _shrink_outputs(outputs: dict) -> None:
    while len(json.dumps(outputs).encode("utf-8")) > MAX_OUTPUTS_BYTES and outputs:
        largest_key = max(outputs, key=lambda k: len(json.dumps(outputs[k]).encode("utf-8")))
        val = json.dumps(outputs[largest_key])
        tail = val[-32768:] if len(val) > 32768 else val
        outputs[largest_key] = f"[TRUNCATED]\n{tail}"
        if len(json.dumps(outputs).encode("utf-8")) <= MAX_OUTPUTS_BYTES:
            break


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
        repo = task_map[task_id].repo if task_id in task_map else "?"
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
        event = _make_event("task_failed", f"Task {task_id} failed: upstream {failed_task_id} failed", task_id)
        append_event(gist_client, gist_id, event)
    return cascaded


def _poll_single_agent(
    task_id: str,
    agent: AgentState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
    state: OrchestrationState,
) -> None:
    if agent.status not in ("running", "launching") or agent.agent_id is None:
        return
    try:
        info = cursor_client.get_agent(agent.agent_id)
    except Exception:
        logger.exception(f"Failed to poll agent {agent.agent_id} for task {task_id}")
        return
    _update_agent_from_poll(task_id, agent, info, gist_client, gist_id, state)


def _update_agent_from_poll(
    task_id: str,
    agent: AgentState,
    info: object,
    gist_client: GistClient,
    gist_id: str,
    state: OrchestrationState,
) -> None:
    if info.status == "FINISHED":
        _mark_agent_finished(task_id, agent, info, gist_client, gist_id, state)
        return
    if info.status == "ERROR":
        _mark_agent_error(task_id, agent, info, gist_client, gist_id)
        return
    if info.status in ("RUNNING", "CREATING"):
        _check_running_agent(task_id, agent, gist_client, gist_id)
        return


def _mark_agent_finished(
    task_id: str,
    agent: AgentState,
    info: object,
    gist_client: GistClient,
    gist_id: str,
    state: OrchestrationState,
) -> None:
    agent.status = "finished"
    agent.finished_at = _now_iso()
    agent.pr_url = info.pr_url
    agent.summary = info.summary
    _read_worker_output(gist_client, gist_id, task_id)
    phase_id = state.task_phase_map.get(task_id)
    append_event(
        gist_client,
        gist_id,
        _make_event(
            "task_finished",
            f"Task {task_id} finished",
            task_id,
            phase_id=phase_id,
            agent_node_id=task_id,
            agent_kind="task",
            payload={"status": agent.status},
        ),
    )


def _mark_agent_error(
    task_id: str, agent: AgentState, info: object,
    gist_client: GistClient, gist_id: str,
) -> None:
    agent.status = "failed"
    agent.finished_at = _now_iso()
    agent.summary = info.summary or "Agent error"
    append_event(gist_client, gist_id, _make_event("task_failed", f"Task {task_id} failed: agent error", task_id))


def _check_running_agent(
    task_id: str, agent: AgentState,
    gist_client: GistClient, gist_id: str,
) -> None:
    if agent.status == "launching":
        agent.status = "running"
    output = _read_worker_output(gist_client, gist_id, task_id)
    if not output or output.get("status") != "blocked":
        return
    agent.status = "blocked"
    agent.blocked_reason = output.get("blocked_reason", "Unknown")
    if agent.blocked_since is None:
        agent.blocked_since = _now_iso()
    append_event(gist_client, gist_id, _make_event("task_blocked", f"Task {task_id} blocked: {agent.blocked_reason}", task_id))


def _poll_agents(
    state: OrchestrationState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
) -> None:
    for task_id, agent in state.agents.items():
        _poll_single_agent(task_id, agent, cursor_client, gist_client, gist_id, state)


def _handle_single_blocked(
    agent: AgentState,
    now: datetime,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
    graph: dict[str, set[str]],
    state: OrchestrationState,
) -> None:
    if agent.blocked_since is None:
        return
    elapsed = (now - datetime.fromisoformat(agent.blocked_since)).total_seconds()
    if elapsed <= BLOCKED_TIMEOUT_SECONDS:
        return
    if agent.retry_count < MAX_RETRY_COUNT and agent.agent_id:
        _retry_blocked_agent(agent, cursor_client, gist_client, gist_id)
        return
    _fail_blocked_agent(agent, cursor_client, gist_client, gist_id, graph, state)


def _retry_blocked_agent(
    agent: AgentState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
) -> None:
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


def _fail_blocked_agent(
    agent: AgentState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
    graph: dict[str, set[str]],
    state: OrchestrationState,
) -> None:
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


def _handle_blocked(
    state: OrchestrationState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
    graph: dict[str, set[str]],
) -> None:
    now = datetime.now(timezone.utc)
    for agent in get_blocked_tasks(state.agents):
        _handle_single_blocked(agent, now, cursor_client, gist_client, gist_id, graph, state)


def _resolve_repo_for_task(
    task: TaskConfig,
    config: OrchestratorConfig,
    dep_outputs: dict[str, dict],
    gh_token: str,
) -> tuple[str, str]:
    if task.create_repo:
        gh_user = _resolve_github_username(gh_token)
        bootstrap_url = f"https://github.com/{gh_user}/{config.bootstrap_repo_name}"
        return bootstrap_url, "main"

    if task.repo in config.repositories:
        rc = config.repositories[task.repo]
        return rc.url, rc.ref

    for dep_id, outputs in dep_outputs.items():
        if "repo_url" in outputs:
            return outputs["repo_url"], "main"

    raise ValueError(f"Cannot resolve repository for task {task.id}: repo alias '{task.repo}' not found and no upstream repo_url")


def _launch_single_task(
    task_id: str,
    state: OrchestrationState,
    config: OrchestratorConfig,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
) -> None:
    assign_task_phase(state, task_id, "execution")
    set_phase_status(state, "execution", "running", timestamp=_now_iso())
    task_map = {t.id: t for t in config.tasks}
    task = task_map[task_id]
    gh_token = os.environ["GH_TOKEN"]
    dep_outputs = _gather_dep_outputs(task, gist_client, gist_id)
    repo_url, ref = _resolve_repo_for_task(task, config, dep_outputs, gh_token)
    if task.create_repo:
        prompt = build_repo_creation_prompt(task, gist_id, gh_token, dep_outputs)
    else:
        prompt = build_worker_prompt(task, gist_id, gh_token, dep_outputs)
    branch = compute_branch_name(config.target.branch_prefix, task_id, state.agents[task_id].retry_count)
    model = task.model or config.model
    info = _try_launch_agent(cursor_client, prompt, repo_url, ref, model, branch, config.target.auto_create_pr)
    if info is None:
        state.agents[task_id].status = "failed"
        state.agents[task_id].summary = "Failed to launch agent"
        append_event(gist_client, gist_id, _make_event("task_failed", f"Task {task_id} failed: launch error", task_id))
        return
    agent = state.agents[task_id]
    agent.agent_id = info.id
    agent.status = "launching"
    agent.started_at = _now_iso()
    append_event(
        gist_client,
        gist_id,
        _make_event(
            "task_launched",
            f"Launched {task_id} ({info.id})",
            task_id,
            phase_id="execution",
            agent_node_id=task_id,
            agent_kind="task",
        ),
    )


def _gather_dep_outputs(task: TaskConfig, gist_client: GistClient, gist_id: str) -> dict[str, dict]:
    dep_outputs: dict[str, dict] = {}
    for dep_id in task.depends_on:
        output = _read_worker_output(gist_client, gist_id, dep_id)
        dep_outputs[dep_id] = output.get("outputs", {}) if output else {}
    return dep_outputs


def _try_launch_agent(
    cursor_client: CursorClient,
    prompt: str,
    repo_url: str,
    ref: str,
    model: str,
    branch: str,
    auto_pr: bool,
) -> object | None:
    try:
        return cursor_client.launch_agent(
            prompt=prompt, repository=repo_url, ref=ref,
            model=model, branch_name=branch, auto_pr=auto_pr,
        )
    except Exception:
        logger.exception("Failed to launch agent")
        return None


def _launch_ready_tasks(
    state: OrchestrationState,
    config: OrchestratorConfig,
    graph: dict[str, set[str]],
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
) -> None:
    ready = get_ready_tasks(graph, state.agents)
    for task_id in ready:
        _launch_single_task(task_id, state, config, cursor_client, gist_client, gist_id)


def _stop_all_running(state: OrchestrationState, cursor_client: CursorClient) -> None:
    for agent in state.agents.values():
        _stop_single_agent(agent, cursor_client)


def _stop_single_agent(agent: AgentState, cursor_client: CursorClient) -> None:
    if agent.status not in ("running", "launching") or agent.agent_id is None:
        return
    try:
        cursor_client.stop_agent(agent.agent_id)
        agent.status = "stopped"
        agent.finished_at = _now_iso()
    except Exception:
        logger.warning(f"Failed to stop agent {agent.agent_id}")


def _check_all_finished(state: OrchestrationState) -> bool:
    return all(a.status == "finished" for a in state.agents.values())


def _check_terminal_failure(state: OrchestrationState, graph: dict[str, set[str]]) -> bool:
    failed_ids = {tid for tid, a in state.agents.items() if a.status == "failed"}
    if not failed_ids:
        return False
    pending_viable = [
        tid for tid, a in state.agents.items()
        if a.status in ("pending", "running", "launching", "blocked")
    ]
    return len(pending_viable) == 0


def _compute_sleep_time(gist_client: GistClient) -> int:
    remaining = gist_client.rate_limit_remaining
    limit = gist_client._rate_limit_limit
    if remaining is None or limit is None:
        return POLL_INTERVAL
    used_pct = 1.0 - (remaining / limit)
    if used_pct > 0.8:
        logger.warning(f"Rate limit >80% consumed ({remaining} remaining), doubling poll interval")
        return POLL_INTERVAL * 2
    return POLL_INTERVAL


def _resolve_github_username(gh_token: str) -> str:
    resp = requests.get(
        "https://api.github.com/user",
        headers={"Authorization": f"Bearer {gh_token}"},
    )
    resp.raise_for_status()
    return resp.json()["login"]


def _run_planning_phase(
    config: OrchestratorConfig,
    gist_id: str,
    cursor_client: CursorClient,
    gist_client: GistClient,
) -> bool:
    append_event(
        gist_client,
        gist_id,
        _make_event("planning_started", "Planning phase started", phase_id="planning", agent_kind="phase"),
    )
    try:
        gh_token = os.environ["GH_TOKEN"]
        planner_prompt = build_planner_prompt(config, gist_id, gh_token)

        gh_user = _resolve_github_username(gh_token)
        bootstrap_url = f"https://github.com/{gh_user}/{config.bootstrap_repo_name}"

        cursor_client.launch_agent(
            prompt=planner_prompt,
            repository=bootstrap_url,
            ref="main",
            model=config.model,
            branch_name=f"cursor-orch-planner-{gist_id[:8]}",
            auto_pr=False,
        )

        plan_content = wait_for_plan(gist_client, gist_id)
        if plan_content is None:
            raise RuntimeError("Timed out waiting for task plan from planner agent")

        parsed_tasks = parse_task_plan(plan_content, config)
        config.tasks = parsed_tasks
        gist_client.write_file(gist_id, "config.yaml", to_yaml(config))

        append_event(
            gist_client,
            gist_id,
            _make_event(
                "planning_completed",
                f"Planning completed: {len(parsed_tasks)} tasks",
                phase_id="planning",
                agent_kind="phase",
            ),
        )
        return True
    except Exception as exc:
        append_event(
            gist_client,
            gist_id,
            _make_event("planning_failed", str(exc), phase_id="planning", agent_kind="phase"),
        )
        raise


def run_orchestration(gist_id: str, cursor_client: CursorClient, gist_client: GistClient) -> None:
    config_str = gist_client.read_file(gist_id, "config.yaml")
    config = parse_config(config_str)

    planning_ran = False
    planning_ok = False
    if config.prompt and not config.tasks:
        planning_ran = True
        try:
            planning_ok = _run_planning_phase(config, gist_id, cursor_client, gist_client)
        except Exception:
            planning_ok = False
            raise

    try:
        state = sync_from_gist(gist_client, gist_id)
    except Exception:
        state = create_initial_state(config, gist_id)

    if state.status == "pending":
        state.status = "running"
        state.started_at = _now_iso()
        seed_main_agent(state, agent_id=state.orchestrator_agent_id, status="running", started_at=state.started_at)
        sync_to_gist(gist_client, gist_id, state)
        append_event(
            gist_client,
            gist_id,
            _make_event(
                "orchestration_started",
                "Orchestration started",
                agent_node_id="main-orchestrator",
                agent_kind="main",
            ),
        )
    if planning_ran:
        set_phase_status(
            state,
            "planning",
            "finished" if planning_ok else "failed",
            timestamp=_now_iso(),
        )
        sync_to_gist(gist_client, gist_id, state)

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
        if _check_stop_requested(state, cursor_client, gist_client, gist_id, config):
            break
        _poll_agents(state, cursor_client, gist_client, gist_id)
        _handle_blocked(state, cursor_client, gist_client, gist_id, graph)
        _launch_ready_tasks(state, config, graph, cursor_client, gist_client, gist_id)
        _write_progress(state, config, gist_client, gist_id)
        if _check_completion(state, gist_client, gist_id):
            break
        if _check_failure(state, graph, gist_client, gist_id):
            break
        time.sleep(_compute_sleep_time(gist_client))


def _check_stop_requested(
    state: OrchestrationState,
    cursor_client: CursorClient,
    gist_client: GistClient,
    gist_id: str,
    config: OrchestratorConfig,
) -> bool:
    stop_content = gist_client.read_file(gist_id, "stop-requested.json")
    if not stop_content:
        return False
    logger.info("Stop requested, halting orchestration")
    _stop_all_running(state, cursor_client)
    state.status = "stopped"
    gist_client.write_file(gist_id, "summary.md", _build_summary_md(config, state))
    sync_to_gist(gist_client, gist_id, state)
    append_event(
        gist_client,
        gist_id,
        _make_event(
            "orchestration_stopped",
            "Orchestration stopped by user",
            agent_node_id="main-orchestrator",
            agent_kind="main",
        ),
    )
    return True


def _write_progress(
    state: OrchestrationState,
    config: OrchestratorConfig,
    gist_client: GistClient,
    gist_id: str,
) -> None:
    summary_md = _build_summary_md(config, state)
    gist_client.write_file(gist_id, "summary.md", summary_md)
    sync_to_gist(gist_client, gist_id, state)


def _check_completion(state: OrchestrationState, gist_client: GistClient, gist_id: str) -> bool:
    if not _check_all_finished(state):
        return False
    state.status = "completed"
    sync_to_gist(gist_client, gist_id, state)
    append_event(
        gist_client,
        gist_id,
        _make_event(
            "orchestration_completed",
            "All tasks completed",
            agent_node_id="main-orchestrator",
            agent_kind="main",
        ),
    )
    logger.info("Orchestration completed successfully")
    return True


def _check_failure(
    state: OrchestrationState,
    graph: dict[str, set[str]],
    gist_client: GistClient,
    gist_id: str,
) -> bool:
    failed_ids = {tid for tid, a in state.agents.items() if a.status == "failed"}
    if not failed_ids:
        return False
    for fid in list(failed_ids):
        _cascade_failures(state, fid, graph, gist_client, gist_id)
    if not _check_terminal_failure(state, graph):
        return False
    state.status = "failed"
    state.error = f"Failed tasks: {', '.join(sorted(failed_ids))}"
    sync_to_gist(gist_client, gist_id, state)
    append_event(
        gist_client,
        gist_id,
        _make_event(
            "orchestration_failed",
            f"Orchestration failed: {state.error}",
            agent_node_id="main-orchestrator",
            agent_kind="main",
        ),
    )
    logger.error(f"Orchestration failed: {state.error}")
    return True


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
