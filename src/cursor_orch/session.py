from __future__ import annotations

from pathlib import Path

from cursor_orch.config import (
    OrchestratorConfig,
    RepoConfig,
    parse_config,
    to_yaml,
    validate_config,
)

SESSION_DIR = Path.home() / ".cursor-orch"
SESSION_PATH = SESSION_DIR / "session.yaml"


class Session:
    def __init__(self) -> None:
        self._config = OrchestratorConfig(
            name="",
            model="",
        )

    def set_name(self, name: str) -> None:
        self._config.name = name

    def set_model(self, model: str) -> None:
        self._config.model = model

    def set_prompt(self, prompt: str) -> None:
        self._config.prompt = prompt

    def add_repo(self, alias: str, url: str, ref: str = "main") -> bool:
        replaced = alias in self._config.repositories
        self._config.repositories[alias] = RepoConfig(url=url, ref=ref)
        return replaced

    def remove_repo(self, alias: str) -> bool:
        if alias in self._config.repositories:
            del self._config.repositories[alias]
            return True
        return False

    def set_branch_prefix(self, prefix: str) -> None:
        self._config.target.branch_prefix = prefix

    def set_auto_pr(self, enabled: bool) -> None:
        self._config.target.auto_create_pr = enabled

    def set_bootstrap_repo(self, name: str) -> None:
        self._config.bootstrap_repo_name = name

    @property
    def config(self) -> OrchestratorConfig:
        return self._config

    def build_config(self) -> OrchestratorConfig:
        return self._config

    def validate(self) -> list[str]:
        try:
            validate_config(self._config)
        except ValueError as exc:
            return [str(exc)]
        return []

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(to_yaml(self._config))

    def load(self, path: Path) -> None:
        self._config = parse_config(path.read_text())

    def save_session(self) -> None:
        self.save(SESSION_PATH)

    def load_session(self) -> bool:
        if not SESSION_PATH.exists():
            return False
        self.load(SESSION_PATH)
        return True
