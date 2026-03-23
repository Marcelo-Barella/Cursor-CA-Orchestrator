from cursor_orch.packager import build_runtime_digest, build_runtime_ref, create_runtime_metadata, package_runtime_snapshot


def test_package_runtime_snapshot_uses_canonical_repo_paths():
    files = package_runtime_snapshot()

    assert "pyproject.toml" in files
    assert "src/cursor_orch/orchestrator.py" in files
    assert "src/cursor_orch/api/cursor_client.py" in files
    assert "runtime_manifest.json" not in files
    assert all(not path.startswith("runtime__") for path in files)


def test_runtime_ref_is_deterministic_for_same_snapshot_bytes():
    files_a = {
        "src/cursor_orch/orchestrator.py": "print('a')\n",
        "pyproject.toml": "[project]\nname = 'cursor-orch'\n",
    }
    files_b = {
        "pyproject.toml": "[project]\nname = 'cursor-orch'\n",
        "src/cursor_orch/orchestrator.py": "print('a')\n",
    }

    assert build_runtime_digest(files_a) == build_runtime_digest(files_b)
    assert build_runtime_ref(files_a) == build_runtime_ref(files_b)


def test_runtime_metadata_uses_checked_in_entrypoint():
    metadata = create_runtime_metadata({
        "pyproject.toml": "[project]\nname = 'cursor-orch'\n",
        "src/cursor_orch/orchestrator.py": "print('a')\n",
    })

    assert metadata["entrypoint"] == "python -m cursor_orch.orchestrator"
    assert metadata["ref"].startswith("runtime/")
