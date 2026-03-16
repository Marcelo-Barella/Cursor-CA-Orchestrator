from __future__ import annotations

import base64

import pytest
import requests

from cursor_orch.api.repo_store import (
    MAX_RETRIES_409,
    MAX_RETRIES_NETWORK,
    RateLimitError,
    RepoStoreClient,
    RepoStoreError,
    RepoStoreNotFound,
)


class _FakeResponse:
    def __init__(self, status_code: int, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text
        self.headers: dict[str, str] = {}

    def json(self):
        return self._payload


def _make_client() -> RepoStoreClient:
    return RepoStoreClient("gh-token", "owner", "repo")


def _make_queue(*responses):
    queue = list(responses)

    def fake_request(method, url, **kwargs):
        return queue.pop(0)

    return fake_request


def test_create_run_creates_branch(monkeypatch):
    client = _make_client()
    calls = []

    def fake_request(method, url, **kwargs):
        calls.append((method, url))
        if method == "GET" and "/repos/owner/repo" == url.split("api.github.com")[1]:
            return _FakeResponse(200, {"default_branch": "main"})
        if method == "GET" and "/git/ref/heads/main" in url:
            return _FakeResponse(200, {"object": {"sha": "abc123"}})
        if method == "POST" and "/git/refs" in url:
            return _FakeResponse(201, {})
        raise AssertionError(f"Unexpected request: {method} {url}")

    monkeypatch.setattr(client._session, "request", fake_request)
    client.create_run("run-1")
    assert len(calls) == 3


def test_create_run_already_exists_422(monkeypatch):
    client = _make_client()

    def fake_request(method, url, **kwargs):
        if method == "GET" and "/git/ref/heads" not in url:
            return _FakeResponse(200, {"default_branch": "main"})
        if method == "GET" and "/git/ref/heads" in url:
            return _FakeResponse(200, {"object": {"sha": "abc123"}})
        if method == "POST":
            return _FakeResponse(422, {}, "Reference already exists")
        raise AssertionError(f"Unexpected request: {method} {url}")

    monkeypatch.setattr(client._session, "request", fake_request)
    client.create_run("run-1")


def test_read_file_returns_decoded_content(monkeypatch):
    client = _make_client()
    encoded = base64.b64encode(b"hello world").decode("ascii")

    monkeypatch.setattr(
        client._session,
        "request",
        _make_queue(_FakeResponse(200, {"content": encoded})),
    )
    result = client.read_file("run-1", "file.txt")
    assert result == "hello world"


def test_read_file_returns_empty_on_404(monkeypatch):
    client = _make_client()

    monkeypatch.setattr(
        client._session,
        "request",
        _make_queue(_FakeResponse(404, {}, "Not Found")),
    )
    result = client.read_file("run-1", "missing.txt")
    assert result == ""


def test_write_file_creates_new_file(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)

    monkeypatch.setattr(
        client._session,
        "request",
        _make_queue(
            _FakeResponse(404, {}, "Not Found"),
            _FakeResponse(201, {}),
        ),
    )
    client.write_file("run-1", "new.txt", "content")


def test_write_file_updates_existing_file(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)
    put_payloads: list[dict] = []

    queue = [
        _FakeResponse(200, {"sha": "existing-sha"}),
        _FakeResponse(200, {}),
    ]

    def fake_request(method, url, **kwargs):
        if method == "PUT":
            put_payloads.append(kwargs.get("json", {}))
        return queue.pop(0)

    monkeypatch.setattr(client._session, "request", fake_request)
    client.write_file("run-1", "existing.txt", "updated content")
    assert put_payloads[0].get("sha") == "existing-sha"


def test_write_file_retries_on_409(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)

    monkeypatch.setattr(
        client._session,
        "request",
        _make_queue(
            _FakeResponse(404, {}),
            _FakeResponse(409, {}, "Conflict"),
            _FakeResponse(404, {}),
            _FakeResponse(200, {}),
        ),
    )
    client.write_file("run-1", "file.txt", "content")


def test_delete_file_succeeds(monkeypatch):
    client = _make_client()
    deleted: list[bool] = []

    def fake_request(method, url, **kwargs):
        if method == "GET":
            return _FakeResponse(200, {"sha": "del-sha"})
        if method == "DELETE":
            deleted.append(True)
            return _FakeResponse(200, {})
        raise AssertionError(f"Unexpected: {method}")

    monkeypatch.setattr(client._session, "request", fake_request)
    client.delete_file("run-1", "file.txt")
    assert deleted == [True]


def test_delete_file_noop_when_not_found(monkeypatch):
    client = _make_client()
    delete_called = False

    def fake_request(method, url, **kwargs):
        nonlocal delete_called
        if method == "GET":
            return _FakeResponse(404, {}, "Not Found")
        if method == "DELETE":
            delete_called = True
            return _FakeResponse(200, {})
        raise AssertionError(f"Unexpected: {method}")

    monkeypatch.setattr(client._session, "request", fake_request)
    client.delete_file("run-1", "missing.txt")
    assert not delete_called


def test_batch_write_files_creates_blobs_tree_commit(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)
    calls: list[tuple[str, str]] = []

    responses = [
        _FakeResponse(200, {"object": {"sha": "base-sha"}}),
        _FakeResponse(201, {"sha": "blob-sha-1"}),
        _FakeResponse(201, {"sha": "blob-sha-2"}),
        _FakeResponse(201, {"sha": "tree-sha"}),
        _FakeResponse(201, {"sha": "commit-sha"}),
        _FakeResponse(200, {}),
    ]
    queue = list(responses)

    def fake_request(method, url, **kwargs):
        calls.append((method, url))
        return queue.pop(0)

    monkeypatch.setattr(client._session, "request", fake_request)
    client.batch_write_files("run-1", {"a.txt": "hello", "b.txt": "world"})
    assert len(calls) >= 6


def test_batch_write_files_retries_on_ref_update_422(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)
    patch_calls = 0

    responses_first_pass = [
        _FakeResponse(200, {"object": {"sha": "base-sha"}}),
        _FakeResponse(201, {"sha": "blob-sha"}),
        _FakeResponse(201, {"sha": "tree-sha"}),
        _FakeResponse(201, {"sha": "commit-sha"}),
        _FakeResponse(422, {}, "Conflict"),
    ]
    responses_second_pass = [
        _FakeResponse(200, {"object": {"sha": "base-sha-2"}}),
        _FakeResponse(201, {"sha": "blob-sha-2"}),
        _FakeResponse(201, {"sha": "tree-sha-2"}),
        _FakeResponse(201, {"sha": "commit-sha-2"}),
        _FakeResponse(200, {}),
    ]
    queue = responses_first_pass + responses_second_pass

    def fake_request(method, url, **kwargs):
        nonlocal patch_calls
        if method == "PATCH":
            patch_calls += 1
        return queue.pop(0)

    monkeypatch.setattr(client._session, "request", fake_request)
    client.batch_write_files("run-1", {"a.txt": "hello"})
    assert patch_calls >= 2


def test_rate_limit_remaining_tracked(monkeypatch):
    client = _make_client()
    resp = _FakeResponse(200, {"default_branch": "main"})
    resp.headers["X-RateLimit-Remaining"] = "4999"
    resp2 = _FakeResponse(200, {"object": {"sha": "abc"}})
    resp3 = _FakeResponse(201, {})

    monkeypatch.setattr(client._session, "request", _make_queue(resp, resp2, resp3))
    client.create_run("run-1")
    assert client.rate_limit_remaining == 4999


def test_rate_limit_429_retries_then_raises(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)
    attempts = 0

    def fake_request(method, url, **kwargs):
        nonlocal attempts
        attempts += 1
        return _FakeResponse(429, {}, "Rate Limited")

    monkeypatch.setattr(client._session, "request", fake_request)

    from cursor_orch.api.repo_store import MAX_RETRIES_429

    with pytest.raises(RateLimitError):
        client.read_file("run-1", "file.txt")

    assert attempts == MAX_RETRIES_429 + 1


def test_retries_network_disconnect_then_succeeds(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)
    attempts = 0
    encoded = base64.b64encode(b"data").decode("ascii")

    def fake_request(method, url, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise requests.exceptions.ConnectionError("dropped")
        return _FakeResponse(200, {"content": encoded})

    monkeypatch.setattr(client._session, "request", fake_request)
    result = client.read_file("run-1", "file.txt")
    assert result == "data"
    assert attempts == 2


def test_raises_after_exhausting_network_retries(monkeypatch):
    client = _make_client()
    monkeypatch.setattr("cursor_orch.api.repo_store.time.sleep", lambda _: None)
    attempts = 0

    def fake_request(method, url, **kwargs):
        nonlocal attempts
        attempts += 1
        raise requests.exceptions.ConnectionError("dropped")

    monkeypatch.setattr(client._session, "request", fake_request)

    with pytest.raises(RepoStoreError, match="GitHub API network error after max retries"):
        client.read_file("run-1", "file.txt")

    assert attempts == MAX_RETRIES_NETWORK + 1
