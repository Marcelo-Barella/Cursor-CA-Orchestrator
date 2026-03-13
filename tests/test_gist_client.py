import requests
import pytest

from cursor_orch.api.gist_client import GistAPIError, GistClient, MAX_RETRIES_NETWORK


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text
        self.headers: dict[str, str] = {}

    def json(self) -> dict:
        return self._payload


def test_read_gist_retries_network_disconnect_then_succeeds(monkeypatch):
    client = GistClient("gh-token")
    attempts = 0

    def fake_request(method: str, url: str, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise requests.exceptions.ConnectionError("connection dropped")
        return _FakeResponse(
            200,
            {
                "id": "gist-123",
                "html_url": "https://gist.github.com/example/gist-123",
                "files": {},
            },
        )

    monkeypatch.setattr(client._session, "request", fake_request)
    monkeypatch.setattr("cursor_orch.api.gist_client.time.sleep", lambda _: None)

    gist = client.read_gist("gist-123")

    assert gist.id == "gist-123"
    assert attempts == 2


def test_read_gist_raises_after_exhausting_network_retries(monkeypatch):
    client = GistClient("gh-token")
    attempts = 0

    def fake_request(method: str, url: str, **kwargs):
        nonlocal attempts
        attempts += 1
        raise requests.exceptions.ConnectionError("connection dropped")

    monkeypatch.setattr(client._session, "request", fake_request)
    monkeypatch.setattr("cursor_orch.api.gist_client.time.sleep", lambda _: None)

    with pytest.raises(GistAPIError, match="GitHub API network error after max retries"):
        client.read_gist("gist-123")

    assert attempts == MAX_RETRIES_NETWORK + 1
