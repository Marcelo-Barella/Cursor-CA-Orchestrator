from cursor_orch import bootstrap


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text
        self.headers: dict[str, str] = {}

    def json(self) -> dict:
        return self._payload


def test_build_bootstrap_rule_runs_checked_in_orchestrator():
    rule = bootstrap.build_bootstrap_rule()

    assert "run_from_gist.py" not in rule
    assert "runtime_manifest.json" not in rule
    assert "launch prompt defines your task" in rule
    assert "python3 -m pip install -e ." not in rule
    assert "python3 -m cursor_orch.orchestrator" not in rule
    assert "ALL agents" in rule
    assert "push changes directly to the assigned branch" in rule


def test_build_bootstrap_snapshot_files_adds_static_rules():
    snapshot = bootstrap.build_bootstrap_snapshot_files({
        "pyproject.toml": "[project]\nname = 'cursor-orch'\n",
        "src/cursor_orch/orchestrator.py": "print('ok')\n",
    })

    assert bootstrap.RULE_PATH in snapshot
    assert bootstrap.READONLY_RULE_PATH in snapshot
    assert "run_from_gist.py" not in snapshot


def test_ensure_bootstrap_repo_reuses_existing_runtime_ref(monkeypatch):
    runtime_snapshot = {
        "pyproject.toml": "[project]\nname = 'cursor-orch'\n",
        "src/cursor_orch/orchestrator.py": "print('ok')\n",
    }
    session = object()
    calls: list[tuple[str, str]] = []

    monkeypatch.setattr(bootstrap, "_make_session", lambda gh_token: session)
    monkeypatch.setattr(bootstrap, "resolve_github_user", lambda active_session: "octocat")
    monkeypatch.setattr(bootstrap, "package_runtime_snapshot", lambda: dict(runtime_snapshot))

    expected_snapshot = bootstrap.build_bootstrap_snapshot_files(dict(runtime_snapshot))
    expected_ref = bootstrap.build_runtime_ref(expected_snapshot)

    def fake_github_api(active_session, method: str, url: str, **kwargs):
        assert active_session is session
        calls.append((method, url))
        if url == "https://api.github.com/repos/octocat/cursor-orch-bootstrap":
            return _FakeResponse(
                200,
                {
                    "html_url": "https://github.com/octocat/cursor-orch-bootstrap",
                    "default_branch": "main",
                },
            )
        if url == f"https://api.github.com/repos/octocat/cursor-orch-bootstrap/git/ref/heads/{expected_ref}":
            return _FakeResponse(200, {"object": {"sha": "existing-runtime-commit"}})
        raise AssertionError(f"Unexpected request: {method} {url}")

    monkeypatch.setattr(bootstrap, "_github_api", fake_github_api)

    repo_info = bootstrap.ensure_bootstrap_repo("gh-token", "cursor-orch-bootstrap")

    assert repo_info["runtime_ref"] == expected_ref
    assert all(method == "GET" for method, _ in calls)
