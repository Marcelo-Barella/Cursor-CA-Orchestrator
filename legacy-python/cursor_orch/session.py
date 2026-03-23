from __future__ import annotations

from pathlib import Path

import yaml

from cursor_orch.config import (
    OrchestratorConfig,
    RepoConfig,
    parse_config,
    to_yaml,
    validate_config,
)

SESSION_DIR = Path.home() / ".cursor-orch"
SESSION_PATH = SESSION_DIR / "session.yaml"
SETUP_STATE_PATH = SESSION_DIR / "setup-state.yaml"
VALID_SETUP_STEPS = {"model", "prompt", "confirm"}


class Session:
    def __init__(self) -> None:
        self._config = OrchestratorConfig(
            name="",
            model="",
        )
        self._setup_state: dict[str, str | bool] = {
            "active": False,
            "step": "model",
        }

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

    def has_required_guided_values(self) -> bool:
        return bool(self._config.model.strip()) and bool(self._config.prompt.strip())

    def setup_state(self) -> dict[str, str | bool]:
        return dict(self._setup_state)

    def set_setup_state(self, *, active: bool | None = None, step: str | None = None) -> None:
        if active is not None:
            self._setup_state["active"] = active
        if step is not None:
            normalized_step = step if step in VALID_SETUP_STEPS else "model"
            self._setup_state["step"] = normalized_step

    def clear_setup_state(self) -> None:
        self._setup_state = {
            "active": False,
            "step": "model",
        }

    def should_resume_guided_setup(self) -> bool:
        active = bool(self._setup_state.get("active", False))
        if not active:
            return False
        step = str(self._setup_state.get("step", "model"))
        if step not in VALID_SETUP_STEPS:
            return True
        if step == "confirm":
            return True
        return not self.has_required_guided_values()

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
        self._save_setup_state()

    def load_session(self) -> bool:
        loaded = False
        if SESSION_PATH.exists():
            self.load(SESSION_PATH)
            loaded = True
        self._load_setup_state()
        return loaded

    def _save_setup_state(self) -> None:
        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "active": bool(self._setup_state.get("active", False)),
            "step": str(self._setup_state.get("step", "model")),
        }
        SETUP_STATE_PATH.write_text(yaml.safe_dump(payload, sort_keys=False))

    def _load_setup_state(self) -> None:
        if not SETUP_STATE_PATH.exists():
            self.clear_setup_state()
            return
        raw = yaml.safe_load(SETUP_STATE_PATH.read_text())
        if not isinstance(raw, dict):
            self.clear_setup_state()
            return
        active_raw = raw.get("active", False)
        step_raw = raw.get("step", "model")
        active = bool(active_raw)
        step = str(step_raw)
        if step not in VALID_SETUP_STEPS:
            step = "model"
        self._setup_state = {
            "active": active,
            "step": step,
        }
