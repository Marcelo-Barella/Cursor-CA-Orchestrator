from types import SimpleNamespace

from cursor_orch.cli import _build_orchestration_launch_prompt, _run_orchestration
from cursor_orch.config import OrchestratorConfig, TargetConfig, to_yaml


class _FakeGistClient:
    created_files: dict[str, str] | None = None
    update_calls: list[tuple[str, dict[str, str]]] = []
    writes: list[tuple[str, str, str]] = []

    def __init__(self, token: str):
        self.token = token

    def create_gist(self, description: str, files: dict[str, str]):
        self.__class__.created_files = dict(files)
        return SimpleNamespace(id="gist-123", url="https://gist.github.com/example/gist-123")

    def update_gist(self, gist_id: str, files: dict[str, str]) -> None:
        self.__class__.update_calls.append((gist_id, dict(files)))

    def write_file(self, gist_id: str, filename: str, content: str) -> None:
        self.__class__.writes.append((gist_id, filename, content))


class _FakeCursorClient:
    launches: list[dict[str, str | bool]] = []

    def __init__(self, api_key: str):
        self.api_key = api_key

    def launch_agent(
        self,
        prompt: str,
        repository: str,
        ref: str,
        model: str,
        branch_name: str,
        auto_pr: bool,
    ):
        self.__class__.launches.append({
            "prompt": prompt,
            "repository": repository,
            "ref": ref,
            "model": model,
            "branch_name": branch_name,
            "auto_pr": auto_pr,
        })
        return SimpleNamespace(id="agent-123", status="CREATING")


def test_build_orchestration_launch_prompt_exports_runtime_context():
    prompt = _build_orchestration_launch_prompt(
        gist_id="gist-123",
        gh_token="gh-token",
        cursor_api_key="cursor-token",
        runtime_ref="runtime/abc123",
    )

    assert "export GIST_ID='gist-123'" in prompt
    assert "export GH_TOKEN='gh-token'" in prompt
    assert "export CURSOR_API_KEY='cursor-token'" in prompt
    assert "export CURSOR_ORCH_RUNTIME_REF='runtime/abc123'" in prompt
    assert "python3 -m pip install -e ." in prompt
    assert "python3 -m cursor_orch.orchestrator" in prompt


def test_run_orchestration_uses_data_only_gist_and_pinned_runtime_ref(monkeypatch):
    _FakeGistClient.created_files = None
    _FakeGistClient.update_calls = []
    _FakeGistClient.writes = []
    _FakeCursorClient.launches = []

    config = OrchestratorConfig(
        name="Pinned runtime run",
        model="default",
        target=TargetConfig(auto_create_pr=False, branch_prefix="cursor-orch"),
    )
    config_yaml = to_yaml(config)

    monkeypatch.setattr(
        "cursor_orch.cli.ensure_bootstrap_repo",
        lambda gh_token, repo_name: {
            "owner": "octocat",
            "name": repo_name,
            "url": f"https://github.com/octocat/{repo_name}",
            "default_branch": "main",
            "runtime_ref": "runtime/abc123",
        },
    )
    monkeypatch.setattr("cursor_orch.cli.GistClient", _FakeGistClient)
    monkeypatch.setattr("cursor_orch.cli.CursorClient", _FakeCursorClient)
    monkeypatch.setattr("cursor_orch.cli.render_live", lambda gist_client, gist_id, active_config: None)

    _run_orchestration(
        config,
        config_yaml,
        "cursor-token",
        "gh-token",
        "cursor-orch-bootstrap",
    )

    assert _FakeGistClient.created_files == {
        "config.yaml": config_yaml,
        "state.json": _FakeGistClient.created_files["state.json"],
        "summary.md": "# Pinned runtime run\n\nOrchestration pending...\n",
    }
    assert _FakeGistClient.update_calls == []
    assert len(_FakeCursorClient.launches) == 1

    launch = _FakeCursorClient.launches[0]
    assert launch["repository"] == "https://github.com/octocat/cursor-orch-bootstrap"
    assert launch["ref"] == "runtime/abc123"
    assert "export GIST_ID='gist-123'" in str(launch["prompt"])
    assert "export CURSOR_ORCH_RUNTIME_REF='runtime/abc123'" in str(launch["prompt"])
