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


def _github_api(session: requests.Session, method: str, url: str, **kwargs: object) -> requests.Response:
    retries_429 = 0
    retries_transient = 0

    while True:
        resp = session.request(method, url, **kwargs)

        if resp.status_code == 429:
            retries_429 += 1
            if retries_429 > MAX_RETRIES_429:
                raise RuntimeError(f"GitHub rate limit exceeded for {url}")
            delay = _compute_delay(retries_429 - 1)
            retry_after = resp.headers.get("Retry-After")
            if retry_after is not None:
                delay = max(delay, float(retry_after))
            logger.warning(f"Rate limited. Retry {retries_429}/{MAX_RETRIES_429} in {delay:.1f}s")
            time.sleep(delay)
            continue

        if resp.status_code in TRANSIENT_CODES:
            retries_transient += 1
            if retries_transient > MAX_RETRIES_TRANSIENT:
                raise RuntimeError(f"Transient error {resp.status_code} for {url}")
            delay = _compute_delay(retries_transient - 1)
            logger.warning(f"Transient error ({resp.status_code}). Retry {retries_transient}/{MAX_RETRIES_TRANSIENT}")
            time.sleep(delay)
            continue

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
    payload: dict[str, object] = {
        "message": message,
        "content": encoded,
    }
    if sha is not None:
        payload["sha"] = sha
    resp = _github_api(session, "PUT", f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}", json=payload)
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
    # brief pause for GitHub to initialize repo
    time.sleep(2)
    return data


def _commit_bootstrap_files(session: requests.Session, owner: str, repo: str) -> None:
    _commit_file(
        session, owner, repo,
        "requirements.txt",
        b"requests\n",
        "Add requirements.txt",
    )
    loader_content = _get_loader_content()
    _commit_file(
        session, owner, repo,
        "bootstrap/run_from_gist.py",
        loader_content.encode("utf-8"),
        "Add bootstrap loader",
    )
    _commit_file(
        session, owner, repo,
        ".cursor/rules/orchestrator.mdc",
        PLACEHOLDER_RULE.encode("utf-8"),
        "Add placeholder Cursor rule",
    )


def _verify_and_update_loader(session: requests.Session, owner: str, repo: str) -> None:
    bundled = _get_loader_content()
    bundled_sha256 = hashlib.sha256(bundled.encode("utf-8")).hexdigest()

    resp = _github_api(session, "GET", f"{GITHUB_API}/repos/{owner}/{repo}/contents/bootstrap/run_from_gist.py")
    if resp.status_code == 404:
        _commit_file(session, owner, repo, "bootstrap/run_from_gist.py", bundled.encode("utf-8"), "Add bootstrap loader")
        return
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to check loader: HTTP {resp.status_code}")

    file_data = resp.json()
    remote_content = base64.b64decode(file_data.get("content", "")).decode("utf-8")
    remote_sha256 = hashlib.sha256(remote_content.encode("utf-8")).hexdigest()

    if remote_sha256 != bundled_sha256:
        logger.info("Loader script outdated, updating")
        _commit_file(
            session, owner, repo,
            "bootstrap/run_from_gist.py",
            bundled.encode("utf-8"),
            "Update bootstrap loader",
            sha=file_data["sha"],
        )

    req_resp = _github_api(session, "GET", f"{GITHUB_API}/repos/{owner}/{repo}/contents/requirements.txt")
    if req_resp.status_code == 404:
        _commit_file(session, owner, repo, "requirements.txt", b"requests\n", "Add requirements.txt")
    elif req_resp.status_code == 200:
        req_data = req_resp.json()
        remote_req = base64.b64decode(req_data.get("content", "")).decode("utf-8")
        if remote_req.strip() != "requests":
            _commit_file(session, owner, repo, "requirements.txt", b"requests\n", "Update requirements.txt", sha=req_data["sha"])


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
    _commit_file(
        session, owner, repo_name,
        path,
        rule_content.encode("utf-8"),
        "Update Cursor rule for orchestration run",
        sha=sha,
    )
    logger.info("Updated Cursor rule in bootstrap repo")
