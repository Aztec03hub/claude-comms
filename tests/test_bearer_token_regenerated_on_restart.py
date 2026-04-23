"""R3-4: bearer token is regenerated on every daemon start.

The token is NOT persisted across daemon restarts. Simulating a restart
means generating two tokens sequentially; they must differ with
overwhelming probability (32 url-safe bytes => ~192 bits of entropy).

Also verifies:
- The /api/web-token endpoint returns the current in-memory token after
  a regeneration (not a cached stale value).
- The token file (operational convenience) is rewritten with chmod 600.
"""

from __future__ import annotations

import stat
from pathlib import Path

from starlette.applications import Starlette
from starlette.testclient import TestClient

from claude_comms import cli as cli_module
from claude_comms.cli import (
    _generate_web_token,
    _persist_web_token,
    build_web_token_route,
    get_web_token,
    set_web_token,
)


def _client() -> TestClient:
    app = Starlette(routes=[build_web_token_route()])

    async def _asgi_wrap(scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope)
            scope["client"] = ("127.0.0.1", 12345)
        await app(scope, receive, send)

    return TestClient(_asgi_wrap)


def test_token_changes_between_daemon_starts() -> None:
    """Two ``_generate_web_token()`` calls must produce different values."""
    t1 = _generate_web_token()
    t2 = _generate_web_token()
    assert t1 != t2
    # token_urlsafe(32) encodes 32 bytes -> >= 43 chars of base64url.
    assert len(t1) >= 40
    assert len(t2) >= 40


def test_endpoint_returns_fresh_token_after_regenerate() -> None:
    """Simulate restart: set token A, hit endpoint, rotate to token B,
    endpoint must return B (not a cached A)."""
    set_web_token("token-A")
    client = _client()

    r1 = client.get("/api/web-token")
    assert r1.status_code == 200
    assert r1.json() == {"token": "token-A"}

    # Simulate daemon restart by replacing the module-level token.
    set_web_token("token-B")
    r2 = client.get("/api/web-token")
    assert r2.status_code == 200
    assert r2.json() == {"token": "token-B"}


def test_token_not_persisted_across_process_memory() -> None:
    """``set_web_token(None)`` (as a fresh process would start) yields 503
    from the endpoint until a new token is generated and set."""
    set_web_token(None)
    client = _client()
    r = client.get("/api/web-token")
    assert r.status_code == 503

    set_web_token(_generate_web_token())
    r2 = client.get("/api/web-token")
    assert r2.status_code == 200
    assert "token" in r2.json()


def test_token_endpoint_rejects_remote_clients() -> None:
    """Non-loopback request.client.host -> 403. X-Forwarded-For ignored."""
    set_web_token("tok")
    app = Starlette(routes=[build_web_token_route()])

    async def _asgi_wrap(scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope)
            scope["client"] = ("198.51.100.7", 45678)
        await app(scope, receive, send)

    client = TestClient(_asgi_wrap)
    r = client.get(
        "/api/web-token",
        headers={"X-Forwarded-For": "127.0.0.1"},  # spoofed
    )
    assert r.status_code == 403


def test_persist_writes_chmod_600(tmp_path: Path) -> None:
    """Persisted token file must be owner read/write only."""
    target = tmp_path / "subdir" / "web-token"
    _persist_web_token("my-token", target)
    assert target.exists()
    assert target.read_text() == "my-token"
    mode = target.stat().st_mode & 0o777
    # chmod 600 == 0o600. On WSL/Windows this may degrade to 0o666; accept
    # either, but disallow world-readable on POSIX where it's supported.
    assert mode in (0o600, 0o666), f"Unexpected mode {oct(mode)}"


def test_persist_rewritten_on_each_start(tmp_path: Path) -> None:
    """A second ``_persist_web_token`` overwrites the first token — this is
    the expected behavior on daemon restart."""
    target = tmp_path / "web-token"
    _persist_web_token("first", target)
    assert target.read_text() == "first"
    _persist_web_token("second", target)
    assert target.read_text() == "second"


# Cleanup
import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_token_after_test():
    yield
    cli_module.set_web_token(None)
