from __future__ import annotations

import base64
import hashlib
import logging
import random
import time
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"

INITIAL_DELAY = 5.0
BACKOFF_MULTIPLIER = 2.0
MAX_DELAY = 60.0
MAX_RETRIES_429 = 5
MAX_RETRIES_TRANSIENT = 3
JITTER_FACTOR = 0.2
TRANSIENT_CODES = (502, 503, 504)

RULE_TEMPLATE = """---
description: Orchestration bootstrap rule
globs:
alwaysApply: true
---

You are an orchestration bootstrap agent. Your ONLY task is to execute the following commands exactly as written. Do not modify any files. Do not improvise. Do not add features. Do not interpret the output. Execute the commands and report the raw output.

Commands to execute (run sequentially in the shell):

pip install -r requirements.txt
python bootstrap/run_from_gist.py --gist {GIST_ID} --gh-token {GH_TOKEN} --cursor-api-key {CURSOR_API_KEY}

If the first command (pip install) fails, stop and report the error.
If the second command (python bootstrap/run_from_gist.py) fails, report the full stderr output.
If the second command succeeds, report "Bootstrap complete" followed by the last 50 lines of stdout.

STRICT RULES:
- Do NOT modify any files in this repository.
- Do NOT create any new files other than what the script creates.
- Do NOT install packages other than those in requirements.txt.
- Do NOT read or interpret the Python script source code.
- Do NOT retry failed commands unless the script output explicitly requests it.
- Report complete stdout and stderr output.
"""

PLACEHOLDER_RULE = RULE_TEMPLATE.format(
    GIST_ID="<PLACEHOLDER>",
    GH_TOKEN="<PLACEHOLDER>",
    CURSOR_API_KEY="<PLACEHOLDER>",
)


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


def _get_file_sha(session: requests.Session, owner: str, repo: str, path: str) -> str | None:
    resp = _github_api(session, "GET", f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}")
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to get file sha for {path}: HTTP {resp.status_code}")
    return resp.json().get("sha")


def _commit_file(
    session: requests.Session,
    owner: str,
    repo: str,
    path: str,
    content_bytes: bytes,
    message: str,
    sha: str | None = None,
) -> None:
    encoded = base64.b64encode(content_bytes).decode("ascii")
    payload: dict[str, object] = {"message": message, "content": encoded}
    if sha is not None:
        payload["sha"] = sha
    resp = _github_api(session, "PUT", f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}", json=payload)
    if resp.status_code == 403:
        raise RuntimeError(
            f"Failed to commit {path}: HTTP 403 - token lacks required permissions. "
            "Ensure your fine-grained PAT has 'Contents: Read and write' under Repository permissions "
            "and that Repository access includes the target repo (or is set to 'All repositories')."
        )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Failed to commit {path}: HTTP {resp.status_code} {resp.text[:300]}")


def _get_loader_content() -> str:
    loader_path = Path(__file__).parent / "templates" / "run_from_gist.py"
    return loader_path.read_text(encoding="utf-8")


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


def _commit_bootstrap_files(session: requests.Session, owner: str, repo: str) -> None:
    _commit_file(session, owner, repo, "requirements.txt", b"requests\n", "Add requirements.txt")
    loader_content = _get_loader_content()
    _commit_file(session, owner, repo, "bootstrap/run_from_gist.py", loader_content.encode("utf-8"), "Add bootstrap loader")
    _commit_file(session, owner, repo, ".cursor/rules/orchestrator.mdc", PLACEHOLDER_RULE.encode("utf-8"), "Add placeholder Cursor rule")


def _check_and_update_file(
    session: requests.Session,
    owner: str,
    repo: str,
    path: str,
    expected_content: bytes,
    message: str,
) -> None:
    resp = _github_api(session, "GET", f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}")
    if resp.status_code == 404:
        _commit_file(session, owner, repo, path, expected_content, message)
        return
    if resp.status_code == 403:
        raise RuntimeError(
            f"Permission denied checking {path}: HTTP 403. "
            "Ensure your GitHub token has 'contents:write' scope (classic) "
            "or 'Contents > Read and write' permission (fine-grained)."
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to check {path}: HTTP {resp.status_code}")
    file_data = resp.json()
    remote_content = base64.b64decode(file_data.get("content", ""))
    remote_sha256 = hashlib.sha256(remote_content).hexdigest()
    expected_sha256 = hashlib.sha256(expected_content).hexdigest()
    if remote_sha256 != expected_sha256:
        logger.info(f"Updating {path} (content changed)")
        _commit_file(session, owner, repo, path, expected_content, message, sha=file_data["sha"])


def _verify_and_update_loader(session: requests.Session, owner: str, repo: str) -> None:
    loader_content = _get_loader_content()
    _check_and_update_file(session, owner, repo, "bootstrap/run_from_gist.py", loader_content.encode("utf-8"), "Update bootstrap loader")
    _check_and_update_file(session, owner, repo, "requirements.txt", b"requests\n", "Update requirements.txt")


def ensure_bootstrap_repo(gh_token: str, repo_name: str) -> dict:
    session = _make_session(gh_token)
    owner = resolve_github_user(session)

    resp = _github_api(session, "GET", f"{GITHUB_API}/repos/{owner}/{repo_name}")
    if resp.status_code == 404:
        logger.info(f"Bootstrap repo not found. Creating {owner}/{repo_name}...")
        data = _create_repo(session, repo_name)
        _commit_bootstrap_files(session, owner, repo_name)
        return {"owner": owner, "name": repo_name, "url": data["html_url"]}

    if resp.status_code != 200:
        raise RuntimeError(f"Failed to check repo: HTTP {resp.status_code}")

    data = resp.json()
    logger.info(f"Bootstrap repo exists: {data['html_url']}")
    _verify_and_update_loader(session, owner, repo_name)
    return {"owner": owner, "name": repo_name, "url": data["html_url"]}


def update_cursor_rule(
    gh_token: str,
    owner: str,
    repo_name: str,
    gist_id: str,
    cursor_api_key: str,
) -> None:
    session = _make_session(gh_token)
    rule_content = RULE_TEMPLATE.format(
        GIST_ID=gist_id,
        GH_TOKEN=gh_token,
        CURSOR_API_KEY=cursor_api_key,
    )
    path = ".cursor/rules/orchestrator.mdc"
    sha = _get_file_sha(session, owner, repo_name, path)
    _commit_file(session, owner, repo_name, path, rule_content.encode("utf-8"), "Update Cursor rule for orchestration run", sha=sha)
    logger.info("Updated Cursor rule in bootstrap repo")
