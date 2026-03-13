from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path

MAX_RUNTIME_PAYLOAD_BYTES = 1_048_576

PACKAGE_ROOT = Path(__file__).parent
PROJECT_ROOT = PACKAGE_ROOT.parent.parent

RUNTIME_SOURCE_PATHS: tuple[str, ...] = (
    "__init__.py",
    "config.py",
    "orchestrator.py",
    "planner.py",
    "prompt_builder.py",
    "state.py",
    "system_prompt.py",
    "api/__init__.py",
    "api/cursor_client.py",
    "api/gist_client.py",
)
RUNTIME_METADATA_PATHS: tuple[str, ...] = ("pyproject.toml",)
RUNTIME_REF_PREFIX = "runtime/"


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _package_source_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for source_rel in RUNTIME_SOURCE_PATHS:
        source_path = PACKAGE_ROOT / source_rel
        target_path = (Path("src/cursor_orch") / source_rel).as_posix()
        files[target_path] = _read_text(source_path)
    return files


def _package_metadata_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for rel_path in RUNTIME_METADATA_PATHS:
        source_path = PROJECT_ROOT / rel_path
        files[rel_path] = _read_text(source_path)
    return files


def package_runtime_snapshot() -> dict[str, str]:
    files = _package_metadata_files()
    files.update(_package_source_files())
    return files


def package_runtime() -> dict[str, str]:
    return package_runtime_snapshot()


def validate_payload_size(files: Mapping[str, str]) -> None:
    total = 0
    sizes: list[tuple[str, int]] = []
    for name, content in files.items():
        size = len(content.encode("utf-8"))
        sizes.append((name, size))
        total += size
    if total > MAX_RUNTIME_PAYLOAD_BYTES:
        detail = ", ".join(f"{n}: {s}" for n, s in sizes)
        raise ValueError(
            f"Runtime payload exceeds 1MB limit ({total} bytes). "
            f"Individual sizes: {detail}"
        )


def build_runtime_digest(files: Mapping[str, str] | None = None) -> str:
    runtime_files = package_runtime_snapshot() if files is None else dict(files)
    digest = hashlib.sha256()
    for path in sorted(runtime_files):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(runtime_files[path].encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def build_runtime_ref(files: Mapping[str, str] | None = None) -> str:
    return f"{RUNTIME_REF_PREFIX}{build_runtime_digest(files)}"


def create_runtime_metadata(files: Mapping[str, str] | None = None) -> dict[str, object]:
    runtime_files = package_runtime_snapshot() if files is None else dict(files)
    return {
        "version": "2",
        "digest": build_runtime_digest(runtime_files),
        "ref": build_runtime_ref(runtime_files),
        "entrypoint": "python -m cursor_orch.orchestrator",
        "files": [
            {
                "path": path,
                "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            }
            for path, content in sorted(runtime_files.items())
        ],
    }


def create_manifest(files: Mapping[str, str]) -> str:
    return json.dumps(create_runtime_metadata(files), indent=2, sort_keys=True)
