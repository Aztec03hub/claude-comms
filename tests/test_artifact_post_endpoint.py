"""Tests for POST /api/artifacts/{conv}/{name} (R1-1 + R2-1 + R2-2).

Covers the full auth/auth flow:

- Happy path: loopback + valid bearer + registered key in conversation -> 200
- 401 on invalid/missing bearer with "Session expired" message copy
- 403 when key is not in participant registry
- 403 when key is registered but not a member of the conversation
- Loopback-only enforcement:
    - request.client.host != 127.0.0.1/::1 -> 403
    - X-Forwarded-For header must NEVER grant access (spoofing defense)
- Route is NOT registered when web.allow_remote_edits is false
- Route is NOT registered in reverse-proxy mode (web.api_base set)
- Route is NOT registered when REVERSE_PROXY env var is set
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from claude_comms import cli as cli_module
from claude_comms.cli import (
    build_artifact_post_options_route,
    build_artifact_post_route,
    set_web_token,
)
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_artifact_create,
    tool_comms_join,
)

from conftest import PublishSpy


async def _fresh_registry_with_member(conv: str = "general") -> tuple[ParticipantRegistry, str]:
    registry = ParticipantRegistry()
    result = await tool_comms_join(registry, name="poster", conversation=conv)
    return registry, result["key"]


async def _seed_artifact(
    registry: ParticipantRegistry,
    key: str,
    data_dir: Path,
    conv: str = "general",
    name: str = "doc",
) -> None:
    spy = PublishSpy()
    await tool_comms_artifact_create(
        registry,
        spy,
        key=key,
        conversation=conv,
        name=name,
        title="Seed",
        type="doc",
        content="v1",
        data_dir=data_dir,
    )


def _mount(
    config: dict,
    registry: ParticipantRegistry,
    data_dir: Path,
    *,
    loopback: bool = True,
) -> TestClient:
    """Construct a minimal Starlette app with just the POST route attached.

    ``loopback`` toggles whether the TestClient ``client.host`` is advertised
    as 127.0.0.1. The flag is simulated by setting the ASGI scope ``client``
    tuple at request time via ``base_url`` (TestClient always reports
    ``testclient``-style hosts; we use ``raw_path`` hooks through a tiny
    ASGI wrapper when needed).
    """
    from starlette.routing import Route

    spy = PublishSpy()

    post_route = build_artifact_post_route(
        config,
        registry_provider=lambda: registry,
        publish_fn_provider=lambda: spy,
        data_dir_provider=lambda: data_dir,
    )
    if post_route is None:
        raise RuntimeError("POST route was not built — allow_remote_edits/proxy mode mismatch")

    app = Starlette(routes=[post_route, build_artifact_post_options_route(config)])

    # Wrap the app so we can force ``scope['client']`` to 127.0.0.1 or a
    # spoofed non-loopback address, depending on the test.
    async def _asgi_wrap(scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            scope = dict(scope)
            scope["client"] = ("127.0.0.1", 54321) if loopback else ("203.0.113.5", 54321)
        await app(scope, receive, send)

    return TestClient(_asgi_wrap)


# ---------------------------------------------------------------------------
# Happy path + auth failures
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_happy_path(tmp_path: Path) -> None:
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    registry, key = await _fresh_registry_with_member()
    await _seed_artifact(registry, key, tmp_path)

    set_web_token("test-token-happy")
    client = _mount(config, registry, tmp_path)

    r = client.post(
        "/api/artifacts/general/doc",
        json={"key": key, "content": "v2 content", "base_version": 1},
        headers={"Authorization": "Bearer test-token-happy"},
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["status"] == "updated"
    assert payload["version"] == 2


@pytest.mark.asyncio
async def test_post_401_on_missing_token(tmp_path: Path) -> None:
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    registry, key = await _fresh_registry_with_member()
    await _seed_artifact(registry, key, tmp_path)

    set_web_token("real-token")
    client = _mount(config, registry, tmp_path)

    r = client.post(
        "/api/artifacts/general/doc",
        json={"key": key, "content": "x"},
        # no Authorization header
    )
    assert r.status_code == 401
    assert "Session expired" in r.json()["error"]


@pytest.mark.asyncio
async def test_post_401_on_wrong_token(tmp_path: Path) -> None:
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    registry, key = await _fresh_registry_with_member()
    await _seed_artifact(registry, key, tmp_path)

    set_web_token("real-token")
    client = _mount(config, registry, tmp_path)

    r = client.post(
        "/api/artifacts/general/doc",
        json={"key": key, "content": "x"},
        headers={"Authorization": "Bearer nope"},
    )
    assert r.status_code == 401
    assert "Session expired" in r.json()["error"]


@pytest.mark.asyncio
async def test_post_403_when_key_not_registered(tmp_path: Path) -> None:
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    registry, key = await _fresh_registry_with_member()
    await _seed_artifact(registry, key, tmp_path)

    set_web_token("tok")
    client = _mount(config, registry, tmp_path)

    r = client.post(
        "/api/artifacts/general/doc",
        json={"key": "deadbeef", "content": "x"},  # valid format, not registered
        headers={"Authorization": "Bearer tok"},
    )
    assert r.status_code == 403
    assert "not registered" in r.json()["error"]


@pytest.mark.asyncio
async def test_post_403_when_key_not_member_of_conv(tmp_path: Path) -> None:
    """Valid token + registered key, but key did not join the target conversation."""
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    registry, key = await _fresh_registry_with_member(conv="general")
    await _seed_artifact(registry, key, tmp_path, conv="general")

    # Register a second participant only to "other" channel
    other_result = await tool_comms_join(registry, name="intruder", conversation="other")
    other_key = other_result["key"]

    set_web_token("tok")
    client = _mount(config, registry, tmp_path)

    r = client.post(
        "/api/artifacts/general/doc",
        json={"key": other_key, "content": "x"},
        headers={"Authorization": "Bearer tok"},
    )
    assert r.status_code == 403
    assert "not a member" in r.json()["error"]


# ---------------------------------------------------------------------------
# Loopback enforcement & forwarded-header spoofing defense
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_403_when_client_is_remote(tmp_path: Path) -> None:
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    registry, key = await _fresh_registry_with_member()
    await _seed_artifact(registry, key, tmp_path)

    set_web_token("tok")
    client = _mount(config, registry, tmp_path, loopback=False)

    r = client.post(
        "/api/artifacts/general/doc",
        json={"key": key, "content": "x"},
        headers={"Authorization": "Bearer tok"},
    )
    assert r.status_code == 403
    assert "loopback" in r.json()["error"].lower()


@pytest.mark.asyncio
async def test_post_xff_spoof_does_not_bypass_loopback(tmp_path: Path) -> None:
    """Spoofed X-Forwarded-For MUST NOT bypass the loopback check."""
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    registry, key = await _fresh_registry_with_member()
    await _seed_artifact(registry, key, tmp_path)

    set_web_token("tok")
    client = _mount(config, registry, tmp_path, loopback=False)

    r = client.post(
        "/api/artifacts/general/doc",
        json={"key": key, "content": "x"},
        headers={
            "Authorization": "Bearer tok",
            "X-Forwarded-For": "127.0.0.1",
            "X-Real-IP": "127.0.0.1",
        },
    )
    assert r.status_code == 403, (
        "Spoofed X-Forwarded-For must not be trusted; this is the R2-1 defense."
    )


# ---------------------------------------------------------------------------
# Route presence matrix
# ---------------------------------------------------------------------------


def test_route_not_built_when_allow_remote_edits_false() -> None:
    config = {
        "web": {"allow_remote_edits": False, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    route = build_artifact_post_route(
        config,
        registry_provider=lambda: None,
        publish_fn_provider=lambda: None,
        data_dir_provider=lambda: None,
    )
    assert route is None


def test_route_not_built_when_api_base_set() -> None:
    """Reverse-proxy mode wins even when allow_remote_edits is true."""
    config = {
        "web": {
            "allow_remote_edits": True,
            "strict_cors": True,
            "port": 9921,
            "api_base": "https://comms.example.com",
        },
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    route = build_artifact_post_route(
        config,
        registry_provider=lambda: None,
        publish_fn_provider=lambda: None,
        data_dir_provider=lambda: None,
    )
    assert route is None


def test_route_not_built_when_reverse_proxy_env_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REVERSE_PROXY", "1")
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    route = build_artifact_post_route(
        config,
        registry_provider=lambda: None,
        publish_fn_provider=lambda: None,
        data_dir_provider=lambda: None,
    )
    assert route is None


def test_route_built_when_allow_remote_edits_true_and_no_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("REVERSE_PROXY", raising=False)
    config = {
        "web": {"allow_remote_edits": True, "strict_cors": True, "port": 9921, "api_base": None},
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }
    route = build_artifact_post_route(
        config,
        registry_provider=lambda: None,
        publish_fn_provider=lambda: None,
        data_dir_provider=lambda: None,
    )
    assert route is not None


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_token_after_test():
    yield
    cli_module.set_web_token(None)
