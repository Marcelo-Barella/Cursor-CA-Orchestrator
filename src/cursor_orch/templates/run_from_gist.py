#!/usr/bin/env python3
"""Bootstrap loader: fetches runtime code from a Gist and executes it."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

import requests

GIST_API = "https://api.github.com/gists"
FILE_NAME_RE = re.compile(r"^[a-zA-Z0-9_.]+$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def fatal(msg: str) -> None:
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load and run orchestration runtime from a Gist")
    parser.add_argument("--gist", required=True, help="Gist ID")
    parser.add_argument("--gh-token", required=True, help="GitHub token")
    parser.add_argument("--cursor-api-key", required=True, help="Cursor API key")
    return parser.parse_args()


def fetch_gist(gist_id: str, token: str) -> dict:
    resp = requests.get(
        f"{GIST_API}/{gist_id}",
        headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
        timeout=30,
    )
    if resp.status_code != 200:
        fatal(f"Failed to fetch Gist {gist_id}: HTTP {resp.status_code}")
    return resp.json()


def handle_secrets_env(gist_data: dict, gist_id: str, token: str) -> None:
    files = gist_data.get("files", {})
    if "secrets.env" not in files:
        return
    content = files["secrets.env"].get("content", "")
    for line in content.strip().split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ[key.strip()] = value.strip()
    try:
        requests.patch(
            f"{GIST_API}/{gist_id}",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
            json={"files": {"secrets.env": None}},
            timeout=30,
        )
    except Exception as exc:
        print(f"WARNING: Failed to delete secrets.env from Gist: {exc}", file=sys.stderr)


def validate_manifest(manifest: dict, gist_files: dict) -> None:
    if manifest.get("version") != "1":
        fatal(f"Unsupported manifest version: {manifest.get('version')}")
    entrypoint = manifest.get("entrypoint", "")
    if not entrypoint:
        fatal("Manifest entrypoint is empty")
    files = manifest.get("files", [])
    if not files:
        fatal("Manifest files array is empty")
    manifest_names = set()
    for entry in files:
        name = entry.get("name", "")
        sha = entry.get("sha256", "")
        if not FILE_NAME_RE.match(name):
            fatal(f"Invalid file name in manifest: {name}")
        if not SHA256_RE.match(sha):
            fatal(f"Invalid sha256 for {name}: {sha}")
        manifest_names.add(name)
    if entrypoint not in manifest_names:
        fatal(f"Entrypoint '{entrypoint}' not found in manifest files")
    for gist_name in gist_files:
        if gist_name.startswith("runtime__") and gist_name.endswith(".py"):
            if gist_name not in manifest_names:
                fatal(f"Unexpected runtime file in Gist not in manifest: {gist_name}")


def verify_and_materialize(manifest: dict, gist_files: dict) -> str:
    verified: list[tuple[str, str]] = []
    for entry in manifest["files"]:
        name = entry["name"]
        expected_sha = entry["sha256"]
        if name not in gist_files:
            fatal(f"Runtime file '{name}' declared in manifest but missing from Gist")
        content = gist_files[name].get("content", "")
        actual_sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if actual_sha != expected_sha:
            fatal(f"SHA-256 mismatch for {name}: expected {expected_sha}, got {actual_sha}")
        verified.append((name, content))
    for name, content in verified:
        with open(name, "w", encoding="utf-8") as f:
            f.write(content)
    return manifest["entrypoint"]


def main() -> None:
    args = parse_args()

    os.environ["GIST_ID"] = args.gist
    os.environ["GH_TOKEN"] = args.gh_token
    os.environ["CURSOR_API_KEY"] = args.cursor_api_key

    gist_data = fetch_gist(args.gist, args.gh_token)
    handle_secrets_env(gist_data, args.gist, args.gh_token)

    gist_files = gist_data.get("files", {})
    if "runtime_manifest.json" not in gist_files:
        fatal("runtime_manifest.json not found in Gist")
    manifest_content = gist_files["runtime_manifest.json"].get("content", "")
    try:
        manifest = json.loads(manifest_content)
    except json.JSONDecodeError as exc:
        fatal(f"Invalid runtime_manifest.json: {exc}")

    validate_manifest(manifest, gist_files)
    entrypoint = verify_and_materialize(manifest, gist_files)

    result = subprocess.run([sys.executable, entrypoint], check=False)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
