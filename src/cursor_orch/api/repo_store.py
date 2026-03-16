from __future__ import annotations

import base64
import logging
import random
import time

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://api.github.com"

INITIAL_DELAY = 5.0
BACKOFF_MULTIPLIER = 2.0
MAX_DELAY = 60.0
MAX_RETRIES_429 = 5
MAX_RETRIES_TRANSIENT = 3
MAX_RETRIES_409 = 3
MAX_RETRIES_NETWORK = 3
JITTER_FACTOR = 0.2
TRANSIENT_CODES = (502, 503, 504)


class RepoStoreError(Exception):
    def __init__(self, message: str, status_code: int = 0):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class RepoStoreNotFound(RepoStoreError):
    def __init__(self, path: str = ""):
        super().__init__(f"Not found: {path}", 404)


class RateLimitError(RepoStoreError):
    def __init__(self, message: str = "Rate limit exceeded", retry_after: float = 0):
        super().__init__(message, 429)
        self.retry_after = retry_after


def _encode_content(content: str) -> str:
    return base64.b64encode(content.encode("utf-8")).decode("ascii")


def _decode_content(encoded: str) -> str:
    return base64.b64decode(encoded).decode("utf-8")


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


class RepoStoreClient:
    def __init__(self, token: str, owner: str, repo: str):
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
        })
        self._owner = owner
        self._repo = repo
        self._rate_limit_remaining: int | None = None
        self._rate_limit_limit: int | None = None
        self._rate_limit_reset: int | None = None

    @property
    def rate_limit_remaining(self) -> int | None:
        return self._rate_limit_remaining

    def _track_rate_limit(self, resp: requests.Response) -> None:
        remaining = resp.headers.get("X-RateLimit-Remaining")
        if remaining is not None:
            self._rate_limit_remaining = int(remaining)
        limit = resp.headers.get("X-RateLimit-Limit")
        if limit is not None:
            self._rate_limit_limit = int(limit)
        reset = resp.headers.get("X-RateLimit-Reset")
        if reset is not None:
            self._rate_limit_reset = int(reset)

    def _request(self, method: str, url: str, **kwargs: object) -> requests.Response:
        retries_429 = 0
        retries_transient = 0
        retries_network = 0

        while True:
            try:
                resp = self._session.request(method, url, **kwargs)
            except requests.exceptions.RequestException as exc:
                if retries_network < MAX_RETRIES_NETWORK:
                    delay = _compute_delay(retries_network)
                    retries_network += 1
                    logger.warning(
                        "GitHub API network error (%s). Retry %s/%s in %.1fs",
                        type(exc).__name__,
                        retries_network,
                        MAX_RETRIES_NETWORK,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                raise RepoStoreError(
                    f"GitHub API network error after max retries: {type(exc).__name__}: {exc}"
                ) from exc
            self._track_rate_limit(resp)

            if resp.status_code == 429 and retries_429 < MAX_RETRIES_429:
                delay = _compute_429_delay(retries_429, resp)
                retries_429 += 1
                logger.warning("Rate limited (429). Retry %s/%s in %.1fs", retries_429, MAX_RETRIES_429, delay)
                time.sleep(delay)
                continue

            if resp.status_code == 429:
                raise RateLimitError("GitHub API rate limit exceeded after max retries")

            if resp.status_code in TRANSIENT_CODES and retries_transient < MAX_RETRIES_TRANSIENT:
                delay = _compute_delay(retries_transient)
                retries_transient += 1
                logger.warning("Transient error (%s). Retry %s/%s in %.1fs", resp.status_code, retries_transient, MAX_RETRIES_TRANSIENT, delay)
                time.sleep(delay)
                continue

            if resp.status_code in TRANSIENT_CODES:
                raise RepoStoreError(f"Transient error {resp.status_code} after max retries", resp.status_code)

            if resp.status_code == 404:
                raise RepoStoreNotFound()

            if resp.status_code >= 400:
                raise RepoStoreError(f"GitHub API error: {resp.status_code} {resp.text[:500]}", resp.status_code)

            return resp

    def _get_default_branch_sha(self) -> str:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}"
        resp = self._request("GET", url)
        default_branch: str = resp.json().get("default_branch", "main")
        ref_url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/ref/heads/{default_branch}"
        ref_resp = self._request("GET", ref_url)
        sha: str = ref_resp.json()["object"]["sha"]
        return sha

    def _get_file_sha(self, run_id: str, filename: str) -> str | None:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/contents/{filename}"
        try:
            resp = self._request("GET", url, params={"ref": f"run/{run_id}"})
        except RepoStoreNotFound:
            return None
        data = resp.json()
        sha: str | None = data.get("sha")
        return sha

    def create_run(self, run_id: str) -> None:
        sha = self._get_default_branch_sha()
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/refs"
        payload = {"ref": f"refs/heads/run/{run_id}", "sha": sha}
        try:
            self._request("POST", url, json=payload)
        except RepoStoreError as exc:
            if exc.status_code == 422:
                logger.info("Branch run/%s already exists, skipping", run_id)
                return
            raise

    def read_file(self, run_id: str, filename: str) -> str:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/contents/{filename}"
        try:
            resp = self._request("GET", url, params={"ref": f"run/{run_id}"})
        except RepoStoreNotFound:
            return ""
        data = resp.json()
        encoded: str = data.get("content", "")
        return _decode_content(encoded.replace("\n", ""))

    def write_file(self, run_id: str, filename: str, content: str) -> None:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/contents/{filename}"
        branch = f"run/{run_id}"
        encoded = _encode_content(content)

        for attempt in range(MAX_RETRIES_409 + 1):
            sha = self._get_file_sha(run_id, filename)
            payload: dict[str, object] = {
                "message": f"update {filename}",
                "content": encoded,
                "branch": branch,
            }
            if sha is not None:
                payload["sha"] = sha

            try:
                self._request("PUT", url, json=payload)
                return
            except RepoStoreError as exc:
                if exc.status_code in (409, 422) and attempt < MAX_RETRIES_409:
                    delay = _compute_delay(attempt)
                    logger.warning(
                        "Write conflict (%s) for %s. Retry %s/%s in %.1fs",
                        exc.status_code,
                        filename,
                        attempt + 1,
                        MAX_RETRIES_409,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                raise

    def delete_file(self, run_id: str, filename: str) -> None:
        sha = self._get_file_sha(run_id, filename)
        if sha is None:
            return
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/contents/{filename}"
        payload: dict[str, object] = {
            "message": f"delete {filename}",
            "sha": sha,
            "branch": f"run/{run_id}",
        }
        try:
            self._request("DELETE", url, json=payload)
        except RepoStoreNotFound:
            return

    def list_run_files(self, run_id: str) -> list[str]:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/contents/"
        try:
            resp = self._request("GET", url, params={"ref": f"run/{run_id}"})
        except RepoStoreNotFound:
            return []
        items: list[dict] = resp.json()
        return [item["name"] for item in items if isinstance(item, dict)]

    def _get_branch_sha(self, run_id: str) -> str:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/ref/heads/run/{run_id}"
        resp = self._request("GET", url)
        sha: str = resp.json()["object"]["sha"]
        return sha

    def _create_blob(self, content: str) -> str:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/blobs"
        resp = self._request("POST", url, json={"content": content, "encoding": "utf-8"})
        sha: str = resp.json()["sha"]
        return sha

    def _create_tree(self, file_blobs: dict[str, str]) -> str:
        tree = [
            {"path": path, "mode": "100644", "type": "blob", "sha": blob_sha}
            for path, blob_sha in file_blobs.items()
        ]
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/trees"
        resp = self._request("POST", url, json={"tree": tree})
        sha: str = resp.json()["sha"]
        return sha

    def _create_commit(self, message: str, tree_sha: str, parent_sha: str) -> str:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/commits"
        payload = {"message": message, "tree": tree_sha, "parents": [parent_sha]}
        resp = self._request("POST", url, json=payload)
        sha: str = resp.json()["sha"]
        return sha

    def _update_branch_ref(self, run_id: str, commit_sha: str) -> None:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/refs/heads/run/{run_id}"
        self._request("PATCH", url, json={"sha": commit_sha})

    def list_run_branches(self) -> list[str]:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/refs/heads/run/"
        try:
            resp = self._request("GET", url)
        except RepoStoreNotFound:
            return []
        items = resp.json()
        if not isinstance(items, list):
            return []
        return [
            item["ref"].removeprefix("refs/heads/")
            for item in items
            if isinstance(item, dict) and "ref" in item
        ]

    def delete_run_branch(self, run_id: str) -> None:
        url = f"{BASE_URL}/repos/{self._owner}/{self._repo}/git/refs/heads/run/{run_id}"
        try:
            self._request("DELETE", url)
        except RepoStoreNotFound:
            pass

    def batch_write_files(self, run_id: str, files: dict[str, str], message: str = "batch update") -> None:
        for attempt in range(MAX_RETRIES_409 + 1):
            parent_sha = self._get_branch_sha(run_id)
            file_blobs = {path: self._create_blob(content) for path, content in files.items()}
            tree_sha = self._create_tree(file_blobs)
            commit_sha = self._create_commit(message, tree_sha, parent_sha)
            try:
                self._update_branch_ref(run_id, commit_sha)
                return
            except RepoStoreError as exc:
                if exc.status_code == 422 and attempt < MAX_RETRIES_409:
                    delay = _compute_delay(attempt)
                    logger.warning(
                        "Ref update conflict (422). Retry %s/%s in %.1fs",
                        attempt + 1,
                        MAX_RETRIES_409,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                raise
