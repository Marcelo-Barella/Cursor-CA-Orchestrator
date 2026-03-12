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


def test_parse_task_plan_links_transitive_create_repo_dependency_for_new_repo_task():
    config = _make_config()
    plan = json.dumps({
        "tasks": [
            {
                "id": "create-repo-a",
                "repo": "__new__",
                "prompt": "Create repo A",
                "depends_on": [],
                "timeout_minutes": 30,
                "create_repo": True,
            },
            {
                "id": "implement-repo-a",
                "repo": "__new__",
                "prompt": "Implement feature in repo A",
                "depends_on": ["create-repo-a"],
                "timeout_minutes": 30,
            },
            {
                "id": "test-repo-a",
                "repo": "__new__",
                "prompt": "Run tests in repo A",
                "depends_on": ["implement-repo-a"],
                "timeout_minutes": 30,
            },
            {
                "id": "create-repo-b",
                "repo": "__new__",
                "prompt": "Create repo B",
                "depends_on": [],
                "timeout_minutes": 30,
                "create_repo": True,
            },
        ]
    })
    tasks = parse_task_plan(plan, config)
    test_task = next(task for task in tasks if task.id == "test-repo-a")
    assert "create-repo-a" in test_task.depends_on
    assert "create-repo-b" not in test_task.depends_on


def test_parse_task_plan_rejects_ambiguous_transitive_create_repo_dependency():
    config = _make_config()
    plan = json.dumps({
        "tasks": [
            {
                "id": "create-repo-a",
                "repo": "__new__",
                "prompt": "Create repo A",
                "depends_on": [],
                "timeout_minutes": 30,
                "create_repo": True,
            },
            {
                "id": "create-repo-b",
                "repo": "__new__",
                "prompt": "Create repo B",
                "depends_on": [],
                "timeout_minutes": 30,
                "create_repo": True,
            },
            {
                "id": "fan-in-task",
                "repo": "__new__",
                "prompt": "Task with ambiguous upstream repo origin",
                "depends_on": ["create-repo-a", "create-repo-b"],
                "timeout_minutes": 30,
            },
            {
                "id": "downstream-task",
                "repo": "__new__",
                "prompt": "Task that inherits ambiguity",
                "depends_on": ["fan-in-task"],
                "timeout_minutes": 30,
            },
        ]
    })
    with pytest.raises(ValueError, match="does not depend on a create_repo task"):
        parse_task_plan(plan, config)
