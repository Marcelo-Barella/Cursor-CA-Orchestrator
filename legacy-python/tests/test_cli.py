from types import SimpleNamespace

from cursor_orch.cli import _build_orchestration_launch_prompt, _run_orchestration
from cursor_orch.config import OrchestratorConfig, TargetConfig, to_yaml


class _FakeRepoStoreClient:
    writes: list[tuple[str, str, str]] = []
    run_created: list[str] = []

    def __init__(self, token: str, owner: str, repo: str):
        self.token = token
        self.owner = owner
        self.repo = repo
        self.__class__.writes = []
        self.__class__.run_created = []
        self._files: dict[str, str] = {}

    def create_run(self, run_id: str) -> None:
        self.__class__.run_created.append(run_id)

    def write_file(self, run_id: str, filename: str, content: str) -> None:
        self.__class__.writes.append((run_id, filename, content))
        self._files[filename] = content

    def read_file(self, run_id: str, filename: str) -> str:
        return self._files.get(filename, "")


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
        run_id="run-123",
        gh_token="gh-token",
        cursor_api_key="cursor-token",
        runtime_ref="runtime/abc123",
        bootstrap_owner="octocat",
        bootstrap_repo_name="cursor-orch-bootstrap",
    )

    assert "export RUN_ID='run-123'" in prompt
    assert "export GH_TOKEN='gh-token'" in prompt
    assert "export CURSOR_API_KEY='cursor-token'" in prompt
    assert "export CURSOR_ORCH_RUNTIME_REF='runtime/abc123'" in prompt
    assert "python3 -m pip install -e ." in prompt
    assert "python3 -m cursor_orch.orchestrator" in prompt


def test_run_orchestration_uses_data_only_gist_and_pinned_runtime_ref(monkeypatch):
    _FakeRepoStoreClient.writes = []
    _FakeRepoStoreClient.run_created = []
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
    monkeypatch.setattr("cursor_orch.cli.RepoStoreClient", _FakeRepoStoreClient)
    monkeypatch.setattr("cursor_orch.cli.CursorClient", _FakeCursorClient)
    monkeypatch.setattr("cursor_orch.cli.render_live", lambda repo_store, run_id, active_config: None)

    _run_orchestration(
        config,
        config_yaml,
        "cursor-token",
        "gh-token",
        "cursor-orch-bootstrap",
    )

    written_filenames = [filename for _, filename, _ in _FakeRepoStoreClient.writes]
    assert "config.yaml" in written_filenames
    assert "state.json" in written_filenames
    assert "summary.md" in written_filenames

    config_yaml_written = next(content for _, filename, content in _FakeRepoStoreClient.writes if filename == "config.yaml")
    assert config_yaml_written == config_yaml

    summary_written = next(content for _, filename, content in _FakeRepoStoreClient.writes if filename == "summary.md")
    assert summary_written == "# Pinned runtime run\n\nOrchestration pending...\n"

    assert len(_FakeCursorClient.launches) >= 1

    launch = _FakeCursorClient.launches[0]
    assert launch["repository"] == "https://github.com/octocat/cursor-orch-bootstrap"
    assert launch["ref"] == "runtime/abc123"
    assert "export RUN_ID=" in str(launch["prompt"])
    assert "export CURSOR_ORCH_RUNTIME_REF='runtime/abc123'" in str(launch["prompt"])
