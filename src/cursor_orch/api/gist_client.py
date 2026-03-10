from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://api.github.com"

INITIAL_DELAY = 5.0
BACKOFF_MULTIPLIER = 2.0
MAX_DELAY = 60.0
MAX_RETRIES_429 = 5
MAX_RETRIES_TRANSIENT = 3
JITTER_FACTOR = 0.2
TRANSIENT_CODES = (502, 503, 504)


class GistAPIError(Exception):
    def __init__(self, message: str, status_code: int = 0):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class GistNotFound(GistAPIError):
    def __init__(self, gist_id: str = ""):
        super().__init__(f"Gist not found: {gist_id}", 404)


class RateLimitError(GistAPIError):
    def __init__(self, message: str = "Rate limit exceeded", retry_after: float = 0):
        super().__init__(message, 429)
        self.retry_after = retry_after


@dataclass
class GistInfo:
    id: str
    url: str
    files: dict[str, str]


def _compute_delay(attempt: int) -> float:
    delay = min(INITIAL_DELAY * (BACKOFF_MULTIPLIER ** attempt), MAX_DELAY)
    jitter = delay * JITTER_FACTOR
    return delay + random.uniform(-jitter, jitter)


class GistClient:
    def __init__(self, token: str):
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
        })
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

        while True:
            resp = self._session.request(method, url, **kwargs)
            self._track_rate_limit(resp)

            if resp.status_code == 429:
                retries_429 += 1
                if retries_429 > MAX_RETRIES_429:
                    raise RateLimitError("GitHub API rate limit exceeded after max retries")
                delay = _compute_delay(retries_429 - 1)
                retry_after = resp.headers.get("Retry-After")
                if retry_after is not None:
                    delay = max(delay, float(retry_after))
                logger.warning(f"Rate limited (429). Retry {retries_429}/{MAX_RETRIES_429} in {delay:.1f}s")
                time.sleep(delay)
                continue

            if resp.status_code in TRANSIENT_CODES:
                retries_transient += 1
                if retries_transient > MAX_RETRIES_TRANSIENT:
                    raise GistAPIError(f"Transient error {resp.status_code} after max retries", resp.status_code)
                delay = _compute_delay(retries_transient - 1)
                logger.warning(f"Transient error ({resp.status_code}). Retry {retries_transient}/{MAX_RETRIES_TRANSIENT} in {delay:.1f}s")
                time.sleep(delay)
                continue

            if resp.status_code == 404:
                raise GistNotFound()

            if resp.status_code >= 400:
                raise GistAPIError(f"GitHub API error: {resp.status_code} {resp.text[:500]}", resp.status_code)

            return resp

    def create_gist(self, description: str, files: dict[str, str], public: bool = False) -> GistInfo:
        payload = {
            "description": description,
            "public": public,
            "files": {name: {"content": content} for name, content in files.items()},
        }
        resp = self._request("POST", f"{BASE_URL}/gists", json=payload)
        data = resp.json()
        return _parse_gist_info(data)

    def read_gist(self, gist_id: str) -> GistInfo:
        resp = self._request("GET", f"{BASE_URL}/gists/{gist_id}")
        return _parse_gist_info(resp.json())

    def update_gist(self, gist_id: str, files: dict[str, str]) -> None:
        payload = {
            "files": {name: {"content": content} for name, content in files.items()},
        }
        self._request("PATCH", f"{BASE_URL}/gists/{gist_id}", json=payload)

    def read_file(self, gist_id: str, filename: str) -> str:
        gist = self.read_gist(gist_id)
        return gist.files.get(filename, "")

    def write_file(self, gist_id: str, filename: str, content: str) -> None:
        payload = {
            "files": {filename: {"content": content}},
        }
        self._request("PATCH", f"{BASE_URL}/gists/{gist_id}", json=payload)

    def delete_file(self, gist_id: str, filename: str) -> None:
        payload: dict[str, object] = {
            "files": {filename: None},
        }
        self._request("PATCH", f"{BASE_URL}/gists/{gist_id}", json=payload)


def _parse_gist_info(data: dict) -> GistInfo:
    files = {
        name: info.get("content", "")
        for name, info in data.get("files", {}).items()
    }
    return GistInfo(
        id=data["id"],
        url=data.get("html_url", ""),
        files=files,
    )
