from __future__ import annotations

import logging
import random
import time
from collections.abc import Mapping

import requests

from cursor_orch.packager import build_runtime_ref, package_runtime_snapshot, validate_payload_size

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"

INITIAL_DELAY = 5.0
BACKOFF_MULTIPLIER = 2.0
MAX_DELAY = 60.0
MAX_RETRIES_429 = 5
MAX_RETRIES_TRANSIENT = 3
JITTER_FACTOR = 0.2
TRANSIENT_CODES = (502, 503, 504)

BOOTSTRAP_INSTALL_COMMAND = "python3 -m pip install -e ."
BOOTSTRAP_ENTRYPOINT = "python3 -m cursor_orch.orchestrator"
RULE_PATH = ".cursor/rules/orchestrator.mdc"
READONLY_RULE_PATH = ".cursor/rules/readonly-guard.mdc"

RULE_TEMPLATE = """---
description: Orchestration bootstrap rule
globs:
alwaysApply: true
---

This is a pinned cursor-orch bootstrap runtime repository.
The launch prompt defines your task for this run. Follow the launch prompt exactly.
If the launch prompt instructs you to execute shell commands, run those commands exactly as written and report the requested raw output.

STRICT RULES:
- This repository is READ-ONLY. You have NO permission to write files under any circumstances.
- Do NOT modify any files in this repository.
- Do NOT create any new files other than what the executed commands create.
- Do NOT read or interpret the Python source code.
- Do NOT retry failed commands unless the output explicitly requests it.
- Report complete stdout and stderr output.
"""

READONLY_GUARD_RULE = """---
description: Read-only bootstrap repository guard
globs:
alwaysApply: true
---

This is a bootstrap repository for cursor-orch. It must remain unchanged.
Do NOT create, modify, or delete any files in this repository.
Do NOT write code, fix errors, or add functionality.
Your only job is to execute commands as instructed by the orchestrator rule.
"""


def build_bootstrap_rule() -> str:
    return RULE_TEMPLATE


def build_bootstrap_snapshot_files(runtime_files: Mapping[str, str] | None = None) -> dict[str, str]:
    snapshot = package_runtime_snapshot() if runtime_files is None else dict(runtime_files)
    snapshot[RULE_PATH] = build_bootstrap_rule()
    snapshot[READONLY_RULE_PATH] = READONLY_GUARD_RULE
    return snapshot


def _compute_delay(attempt: int) -> float:
    delay = min(INITIAL_DELAY * (BACKOFF_MULTIPLIER ** attempt), MAX_DELAY)
    jitter = delay * JITTER_FACTOR
    return delay + random.uniform(-jitter, jitter)


def _compute_429_delay(attempt: int, resp: requests.Response) -> float:
    delay = _compute_delay(attempt)
    retry_after = resp.headers.get("Retry-After")
    if retry_after is not None:
        delay = max(delay, float(retry_after))
    return delay


def _github_api(session: requests.Session, method: str, url: str, **kwargs: object) -> requests.Response:
    retries_429 = 0
    retries_transient = 0

    while True:
        resp = session.request(method, url, **kwargs)

        is_secondary_rate_limit = (
            resp.status_code == 403
            and ("rate limit" in resp.text.lower() or resp.headers.get("Retry-After"))
        )

        if (resp.status_code == 429 or is_secondary_rate_limit) and retries_429 < MAX_RETRIES_429:
            delay = _compute_429_delay(retries_429, resp)
            retries_429 += 1
            logger.warning(f"Rate limited ({resp.status_code}). Retry {retries_429}/{MAX_RETRIES_429} in {delay:.1f}s")
            time.sleep(delay)
            continue

        if resp.status_code == 429 or is_secondary_rate_limit:
            raise RuntimeError(f"GitHub rate limit exceeded for {url}")

        if resp.status_code in TRANSIENT_CODES and retries_transient < MAX_RETRIES_TRANSIENT:
            delay = _compute_delay(retries_transient)
            retries_transient += 1
            logger.warning(f"Transient error ({resp.status_code}). Retry {retries_transient}/{MAX_RETRIES_TRANSIENT}")
            time.sleep(delay)
            continue

        if resp.status_code in TRANSIENT_CODES:
            raise RuntimeError(f"Transient error {resp.status_code} for {url}")

        return resp


def _make_session(gh_token: str) -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "Authorization": f"token {gh_token}",
        "Accept": "application/vnd.github+json",
    })
    return session


def resolve_github_user(session: requests.Session) -> str:
    resp = _github_api(session, "GET", f"{GITHUB_API}/user")
    if resp.status_code == 401:
        raise RuntimeError("GitHub token is invalid or expired (HTTP 401). Check your GH_TOKEN.")
    if resp.status_code == 403:
        raise RuntimeError("GitHub API forbidden (HTTP 403). Your token may lack required scopes or you are rate-limited.")
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to resolve GitHub user: HTTP {resp.status_code}")
    return resp.json()["login"]


def _create_repo(session: requests.Session, name: str) -> dict:
    payload = {
        "name": name,
        "description": "Bootstrap repo for cursor-orch orchestration",
        "private": True,
        "auto_init": True,
        "has_issues": False,
        "has_projects": False,
        "has_wiki": False,
    }
    resp = _github_api(session, "POST", f"{GITHUB_API}/user/repos", json=payload)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create repo: HTTP {resp.status_code} {resp.text[:300]}")
    data = resp.json()
    logger.info(f"Created bootstrap repo: {data['html_url']}")
    time.sleep(2)
    return data


def _get_repo(session: requests.Session, owner: str, repo: str) -> dict | None:
    resp = _github_api(session, "GET", f"{GITHUB_API}/repos/{owner}/{repo}")
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to check repo: HTTP {resp.status_code}")
    return resp.json()


def _get_ref_sha(session: requests.Session, owner: str, repo: str, ref: str) -> str | None:
    resp = _github_api(session, "GET", f"{GITHUB_API}/repos/{owner}/{repo}/git/ref/heads/{ref}")
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to resolve ref {ref}: HTTP {resp.status_code}")
    data = resp.json()
    return data.get("object", {}).get("sha")


def _create_blob(session: requests.Session, owner: str, repo: str, content: str) -> str:
    resp = _github_api(
        session,
        "POST",
        f"{GITHUB_API}/repos/{owner}/{repo}/git/blobs",
        json={"content": content, "encoding": "utf-8"},
    )
    if resp.status_code != 201:
        raise RuntimeError(f"Failed to create blob: HTTP {resp.status_code} {resp.text[:300]}")
    return resp.json()["sha"]


def _create_tree(session: requests.Session, owner: str, repo: str, files: Mapping[str, str]) -> str:
    tree = [
        {
            "path": path,
            "mode": "100644",
            "type": "blob",
            "sha": _create_blob(session, owner, repo, content),
        }
        for path, content in sorted(files.items())
    ]
    resp = _github_api(
        session,
        "POST",
        f"{GITHUB_API}/repos/{owner}/{repo}/git/trees",
        json={"tree": tree},
    )
    if resp.status_code != 201:
        raise RuntimeError(f"Failed to create tree: HTTP {resp.status_code} {resp.text[:300]}")
    return resp.json()["sha"]


def _create_commit(session: requests.Session, owner: str, repo: str, message: str, tree_sha: str, parent_sha: str) -> str:
    resp = _github_api(
        session,
        "POST",
        f"{GITHUB_API}/repos/{owner}/{repo}/git/commits",
        json={"message": message, "tree": tree_sha, "parents": [parent_sha]},
    )
    if resp.status_code != 201:
        raise RuntimeError(f"Failed to create commit: HTTP {resp.status_code} {resp.text[:300]}")
    return resp.json()["sha"]


def _create_ref(session: requests.Session, owner: str, repo: str, ref: str, sha: str) -> None:
    resp = _github_api(
        session,
        "POST",
        f"{GITHUB_API}/repos/{owner}/{repo}/git/refs",
        json={"ref": f"refs/heads/{ref}", "sha": sha},
    )
    if resp.status_code == 422:
        logger.info(f"Ref {ref} already exists")
        return
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create ref {ref}: HTTP {resp.status_code} {resp.text[:300]}")


def _ensure_runtime_snapshot_ref(
    session: requests.Session,
    owner: str,
    repo: str,
    default_branch: str,
    runtime_files: Mapping[str, str],
) -> str:
    runtime_ref = build_runtime_ref(runtime_files)
    if _get_ref_sha(session, owner, repo, runtime_ref) is not None:
        logger.info(f"Reusing runtime ref {runtime_ref}")
        return runtime_ref

    parent_sha = _get_ref_sha(session, owner, repo, default_branch)
    if parent_sha is None:
        raise RuntimeError(f"Failed to resolve default branch head for {default_branch}")

    tree_sha = _create_tree(session, owner, repo, runtime_files)
    commit_sha = _create_commit(
        session,
        owner,
        repo,
        f"Pin orchestration runtime {runtime_ref}",
        tree_sha,
        parent_sha,
    )
    _create_ref(session, owner, repo, runtime_ref, commit_sha)
    logger.info(f"Created runtime ref {runtime_ref}")
    return runtime_ref


def ensure_bootstrap_repo(gh_token: str, repo_name: str) -> dict:
    session = _make_session(gh_token)
    owner = resolve_github_user(session)

    repo_data = _get_repo(session, owner, repo_name)
    if repo_data is None:
        logger.info(f"Bootstrap repo not found. Creating {owner}/{repo_name}...")
        repo_data = _create_repo(session, repo_name)
    else:
        logger.info(f"Bootstrap repo exists: {repo_data['html_url']}")

    runtime_files = build_bootstrap_snapshot_files()
    validate_payload_size(runtime_files)
    runtime_ref = _ensure_runtime_snapshot_ref(
        session,
        owner,
        repo_name,
        repo_data.get("default_branch", "main"),
        runtime_files,
    )
    return {
        "owner": owner,
        "name": repo_name,
        "url": repo_data["html_url"],
        "default_branch": repo_data.get("default_branch", "main"),
        "runtime_ref": runtime_ref,
    }
