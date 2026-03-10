from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cursor_orch.api.gist_client import GistClient

logger = logging.getLogger(__name__)

MAX_RUNTIME_PAYLOAD_BYTES = 1_048_576

PACKAGE_ROOT = Path(__file__).parent

SOURCE_MAP: list[tuple[str, str]] = [
    ("orchestrator.py", "runtime__orchestrator.py"),
    ("api/cursor_client.py", "runtime__cursor_client.py"),
    ("api/gist_client.py", "runtime__gist_client.py"),
    ("config.py", "runtime__config.py"),
    ("state.py", "runtime__state.py"),
    ("prompt_builder.py", "runtime__prompt_builder.py"),
]

IMPORT_REWRITES: list[tuple[str, str]] = [
    ("from cursor_orch.api.cursor_client import", "from runtime__cursor_client import"),
    ("from cursor_orch.api.gist_client import", "from runtime__gist_client import"),
    ("from cursor_orch.prompt_builder import", "from runtime__prompt_builder import"),
    ("from cursor_orch.orchestrator import", "from runtime__orchestrator import"),
    ("from cursor_orch.config import", "from runtime__config import"),
    ("from cursor_orch.state import", "from runtime__state import"),
    ("import cursor_orch.api.cursor_client", "import runtime__cursor_client"),
    ("import cursor_orch.api.gist_client", "import runtime__gist_client"),
    ("import cursor_orch.prompt_builder", "import runtime__prompt_builder"),
    ("import cursor_orch.orchestrator", "import runtime__orchestrator"),
    ("import cursor_orch.config", "import runtime__config"),
    ("import cursor_orch.state", "import runtime__state"),
]

IMPORT_REWRITES.sort(key=lambda pair: len(pair[0]), reverse=True)


def _rewrite_imports(source: str) -> str:
    for original, replacement in IMPORT_REWRITES:
        source = source.replace(original, replacement)
    return source


def package_runtime() -> dict[str, str]:
    files: dict[str, str] = {}
    for source_rel, gist_name in SOURCE_MAP:
        source_path = PACKAGE_ROOT / source_rel
        content = source_path.read_text(encoding="utf-8")
        rewritten = _rewrite_imports(content)
        files[gist_name] = rewritten
    return files


def validate_payload_size(files: dict[str, str]) -> None:
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


def create_manifest(files: dict[str, str]) -> str:
    file_entries = []
    for _, gist_name in SOURCE_MAP:
        content = files[gist_name]
        sha256 = hashlib.sha256(content.encode("utf-8")).hexdigest()
        file_entries.append({"name": gist_name, "sha256": sha256})
    manifest = {
        "version": "1",
        "entrypoint": "runtime__orchestrator.py",
        "files": file_entries,
    }
    return json.dumps(manifest, indent=2)


def upload_runtime(gist_client: GistClient, gist_id: str) -> None:
    files = package_runtime()
    validate_payload_size(files)
    manifest = create_manifest(files)
    upload_files = dict(files)
    upload_files["runtime_manifest.json"] = manifest
    gist_client.update_gist(gist_id, upload_files)
    logger.info(f"Uploaded runtime payload: {len(files)} files + manifest")
