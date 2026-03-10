import json

import pytest

from cursor_orch.config import OrchestratorConfig, RepoConfig
from cursor_orch.planner import build_planner_prompt, parse_task_plan
from cursor_orch.system_prompt import PLANNER_SYSTEM_PROMPT


def _make_config(**overrides) -> OrchestratorConfig:
    defaults = {
        "name": "test",
        "model": "default",
        "prompt": "Do things",
        "repositories": {"backend": RepoConfig(url="https://github.com/o/backend", ref="main")},
    }
    defaults.update(overrides)
    return OrchestratorConfig(**defaults)


def test_build_planner_prompt_starts_with_system_prompt():
    config = _make_config()
    result = build_planner_prompt(config, gist_id="g123", gh_token="tok")
    assert result.startswith(PLANNER_SYSTEM_PROMPT)


def test_parse_task_plan_accepts_create_repo_tasks():
    config = _make_config()
    plan = json.dumps({
        "tasks": [
            {
                "id": "create-repo",
                "repo": "__new__",
                "prompt": "Create a new repo",
                "depends_on": [],
                "timeout_minutes": 30,
                "create_repo": True,
                "repo_config": {"url_template": "https://github.com/o/new-repo"},
            }
        ]
    })
    tasks = parse_task_plan(plan, config)
    assert len(tasks) == 1
    assert tasks[0].create_repo is True


def test_parse_task_plan_rejects_unknown_repo_without_create_repo():
    config = _make_config()
    plan = json.dumps({
        "tasks": [
            {
                "id": "bad-task",
                "repo": "nonexistent",
                "prompt": "This should fail",
                "depends_on": [],
                "timeout_minutes": 30,
            }
        ]
    })
    with pytest.raises(ValueError, match="unknown repository"):
        parse_task_plan(plan, config)
