from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://api.cursor.com"

INITIAL_DELAY = 5.0
BACKOFF_MULTIPLIER = 2.0
MAX_DELAY = 60.0
MAX_RETRIES_429 = 5
MAX_RETRIES_TRANSIENT = 3
JITTER_FACTOR = 0.2
TRANSIENT_CODES = (502, 503, 504)


class AgentAPIError(Exception):
    def __init__(self, message: str, status_code: int = 0):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class AgentNotFound(AgentAPIError):
    def __init__(self, agent_id: str = ""):
        super().__init__(f"Agent not found: {agent_id}", 404)


class RateLimitError(AgentAPIError):
    def __init__(self, message: str = "Rate limit exceeded", retry_after: float = 0):
        super().__init__(message, 429)
        self.retry_after = retry_after


@dataclass
class AgentInfo:
    id: str
    name: str
    status: str
    repository: str
    branch_name: str
    pr_url: str | None
    summary: str | None
    created_at: str


@dataclass
class Message:
    id: str
    role: str
    text: str


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


class CursorClient:
    def __init__(self, api_key: str):
        self._session = requests.Session()
        self._session.auth = (api_key, "")

    def _request(self, method: str, path: str, **kwargs: object) -> requests.Response:
        url = f"{BASE_URL}{path}"
        retries_429 = 0
        retries_transient = 0

        while True:
            resp = self._session.request(method, url, **kwargs)

            if resp.status_code == 429 and retries_429 < MAX_RETRIES_429:
                delay = _compute_429_delay(retries_429, resp)
                retries_429 += 1
                logger.warning(f"Rate limited (429). Retry {retries_429}/{MAX_RETRIES_429} in {delay:.1f}s")
                time.sleep(delay)
                continue

            if resp.status_code == 429:
                raise RateLimitError("Cursor API rate limit exceeded after max retries")

            if resp.status_code in TRANSIENT_CODES and retries_transient < MAX_RETRIES_TRANSIENT:
                delay = _compute_delay(retries_transient)
                retries_transient += 1
                logger.warning(f"Transient error ({resp.status_code}). Retry {retries_transient}/{MAX_RETRIES_TRANSIENT} in {delay:.1f}s")
                time.sleep(delay)
                continue

            if resp.status_code in TRANSIENT_CODES:
                raise AgentAPIError(f"Transient error {resp.status_code} after max retries", resp.status_code)

            if resp.status_code == 404:
                raise AgentNotFound()

            if resp.status_code >= 400:
                raise AgentAPIError(f"Cursor API error: {resp.status_code} {resp.text[:500]}", resp.status_code)

            return resp

    def launch_agent(
        self,
        prompt: str,
        repository: str,
        ref: str,
        model: str,
        branch_name: str,
        auto_pr: bool,
    ) -> AgentInfo:
        body = {
            "prompt": {"text": prompt},
            "model": model,
            "source": {"repository": repository, "ref": ref},
            "target": {
                "autoCreatePr": auto_pr,
                "branchName": branch_name,
                "openAsCursorGithubApp": True,
                "skipReviewerRequest": True,
            },
        }
        resp = self._request("POST", "/v0/agents", json=body)
        return _parse_agent_info(resp.json())

    def get_agent(self, agent_id: str) -> AgentInfo:
        resp = self._request("GET", f"/v0/agents/{agent_id}")
        return _parse_agent_info(resp.json())

    def list_agents(self, limit: int = 100) -> list[AgentInfo]:
        resp = self._request("GET", "/v0/agents", params={"limit": limit})
        data = resp.json()
        return [_parse_agent_info(a) for a in data.get("agents", [])]

    def get_conversation(self, agent_id: str) -> list[Message]:
        resp = self._request("GET", f"/v0/agents/{agent_id}/conversation")
        data = resp.json()
        return [
            Message(
                id=m.get("id", ""),
                role="user" if m.get("type") == "user_message" else "assistant",
                text=m.get("text", ""),
            )
            for m in data.get("messages", [])
        ]

    def send_followup(self, agent_id: str, prompt: str) -> None:
        self._request("POST", f"/v0/agents/{agent_id}/followup", json={"prompt": {"text": prompt}})

    def stop_agent(self, agent_id: str) -> None:
        self._request("POST", f"/v0/agents/{agent_id}/stop")

    def delete_agent(self, agent_id: str) -> None:
        self._request("DELETE", f"/v0/agents/{agent_id}")

    def list_models(self) -> list[str]:
        resp = self._request("GET", "/v0/models")
        return resp.json()


def _parse_agent_info(data: dict) -> AgentInfo:
    target = data.get("target", {})
    source = data.get("source", {})
    return AgentInfo(
        id=data.get("id", ""),
        name=data.get("name", ""),
        status=data.get("status", "UNKNOWN"),
        repository=source.get("repository", ""),
        branch_name=target.get("branchName", ""),
        pr_url=target.get("prUrl"),
        summary=data.get("summary"),
        created_at=data.get("createdAt", ""),
    )
