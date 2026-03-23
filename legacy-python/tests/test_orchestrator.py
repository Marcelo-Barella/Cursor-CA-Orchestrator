import pytest

from cursor_orch.config import OrchestratorConfig, RepoConfig, TargetConfig, TaskConfig, to_yaml
from cursor_orch.orchestrator import run_orchestration
from cursor_orch.state import create_initial_state, deserialize, read_events, serialize, set_phase_status


class _FakeGistClient:
    def __init__(self, config: OrchestratorConfig, gist_id: str):
        self.files = {
            "config.yaml": to_yaml(config),
            "state.json": serialize(create_initial_state(config, gist_id)),
        }

    def read_file(self, gist_id: str, filename: str) -> str:
        return self.files.get(filename, "")

    def write_file(self, gist_id: str, filename: str, content: str) -> None:
        self.files[filename] = content


class _FakeCursorClient:
    pass


def test_run_orchestration_persists_unexpected_loop_failure(monkeypatch):
    config = OrchestratorConfig(
        name="Test",
        model="default",
        repositories={"frontend": RepoConfig(url="https://github.com/example/frontend", ref="main")},
        tasks=[TaskConfig(id="setup-api-client", repo="frontend", prompt="Set up the API client")],
        target=TargetConfig(auto_create_pr=False, branch_prefix="cursor-orch"),
    )
    gist_id = "gist-123"
    gist_client = _FakeGistClient(config, gist_id)

    def fake_loop(state, config, graph, cursor_client, gist_client, active_gist_id):
        state.agents["setup-api-client"].status = "launching"
        set_phase_status(state, "execution", "running", timestamp="2026-03-13T20:42:23+00:00")
        raise RuntimeError("connection dropped")

    monkeypatch.setattr("cursor_orch.orchestrator._orchestration_loop", fake_loop)

    with pytest.raises(RuntimeError, match="connection dropped"):
        run_orchestration(gist_id, _FakeCursorClient(), gist_client)

    state = deserialize(gist_client.files["state.json"])
    events = read_events(gist_client, gist_id)

    assert state.status == "failed"
    assert state.error == "connection dropped"
    assert state.main_agent is not None
    assert state.main_agent.status == "failed"
    assert state.phase_agents["execution"].status == "failed"
    assert any(
        event.event_type == "orchestration_failed" and event.detail == "Orchestration loop failed: connection dropped"
        for event in events
    )
