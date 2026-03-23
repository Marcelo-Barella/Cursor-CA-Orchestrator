from cursor_orch.config import TaskConfig
from cursor_orch.prompt_builder import build_repo_creation_prompt, build_worker_prompt
from cursor_orch.system_prompt import WORKER_SYSTEM_PROMPT


def _make_task(**overrides) -> TaskConfig:
    defaults = {
        "id": "test-task",
        "repo": "my-repo",
        "prompt": "Do something",
    }
    defaults.update(overrides)
    return TaskConfig(**defaults)


def test_build_worker_prompt_starts_with_system_prompt():
    task = _make_task()
    result = build_worker_prompt(task, run_id="r123", gh_token="tok", dependency_outputs={})
    assert result.startswith(WORKER_SYSTEM_PROMPT)


def test_build_repo_creation_prompt_starts_with_system_prompt():
    task = _make_task(create_repo=True, repo_config={"url_template": "https://github.com/o/r"})
    result = build_repo_creation_prompt(task, run_id="r123", gh_token="tok", dependency_outputs={})
    assert result.startswith(WORKER_SYSTEM_PROMPT)
    assert "REPO CREATION TASK" in result


def test_worker_prompt_contains_gh_output_protocol():
    task = _make_task()
    result = build_worker_prompt(task, run_id="r123", gh_token="tok", dependency_outputs={}, bootstrap_owner="owner", bootstrap_repo="repo")
    assert "gh api" in result
    assert "gh api --method PUT" in result
    assert "/repos/" in result
    assert "urllib.request" not in result
    assert "output = {" in result
    assert "json.dumps(output, indent=2)" in result


def test_worker_prompt_output_protocol_uses_task_id():
    task = _make_task(id="my-task")
    result = build_worker_prompt(task, run_id="r123", gh_token="tok", dependency_outputs={})
    assert "agent-my-task.json" in result


def test_repo_creation_prompt_allows_gh_cli():
    task = _make_task(create_repo=True, repo_config={"url_template": "https://github.com/o/r"})
    result = build_repo_creation_prompt(task, run_id="r123", gh_token="tok", dependency_outputs={})
    assert "do NOT have access to the `gh` CLI" not in result
