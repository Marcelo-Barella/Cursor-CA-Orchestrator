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
    result = build_worker_prompt(task, gist_id="g123", gh_token="tok", dependency_outputs={})
    assert result.startswith(WORKER_SYSTEM_PROMPT)


def test_build_repo_creation_prompt_starts_with_system_prompt():
    task = _make_task(create_repo=True, repo_config={"url_template": "https://github.com/o/r"})
    result = build_repo_creation_prompt(task, gist_id="g123", gh_token="tok", dependency_outputs={})
    assert result.startswith(WORKER_SYSTEM_PROMPT)
    assert "REPO CREATION TASK" in result
