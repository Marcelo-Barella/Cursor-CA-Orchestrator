from cursor_orch.config import (
    OrchestratorConfig,
    RepoConfig,
    TaskConfig,
    _validate_repo_refs,
    to_yaml,
)


def test_task_config_create_repo_defaults():
    task = TaskConfig(id="t1", repo="r", prompt="p")
    assert task.create_repo is False
    assert task.repo_config is None


def test_to_yaml_includes_create_repo():
    config = OrchestratorConfig(
        name="test",
        model="default",
        tasks=[
            TaskConfig(id="create-it", repo="__new__", prompt="make repo", create_repo=True),
        ],
    )
    output = to_yaml(config)
    assert "create_repo: true" in output


def test_validate_repo_refs_skips_create_repo():
    repos = {"backend": RepoConfig(url="https://github.com/o/backend", ref="main")}
    tasks = [
        TaskConfig(id="new-repo", repo="__new__", prompt="create", create_repo=True),
    ]
    _validate_repo_refs(tasks, repos)
