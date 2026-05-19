"""Tests for the v0.4.2 Step 3.4 POST /api/invite REST endpoint.

Covers the full request lifecycle for the REST surface that bridges to
the ``comms_invite`` MCP tool:

- Happy path: caller is a member + invitee is registered + conversation
  exists -> 200 with ``{"invited": true, ...}`` shape.
- 403 when the caller (daemon identity) is not a member of the target
  conversation.
- 400 when the invitee_key is well-formed but not a registered participant.
- 404 when the conversation does not exist (meta.json absent).
- 400 on malformed JSON body.
- 400 on missing required fields (conversation_id, invitee_key).
- 400 on invalid invitee_key format (not 8 lowercase hex).
- 400 on invalid conversation_id format.
- 409 idempotency: re-inviting an already-member returns 409 with
  ``{"invited": false, "reason": "already_member", ...}``.
- CORS preflight: OPTIONS returns the matching CORS headers when origin
  is in the allow-list, and omits Allow-Origin when not.
- Optional ``note`` field is propagated into the system message.

Drives the route via Starlette ``TestClient`` so the full body parsing,
validation, and JSONResponse path is exercised end-to-end, mirroring the
test_artifact_post_endpoint.py harness pattern.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from claude_comms.cli import build_invite_options_route, build_invite_post_route
from claude_comms.conversation import ConversationMeta, save_meta
from claude_comms.mcp_tools import ParticipantRegistry

from conftest import PublishSpy


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


CALLER_KEY = "aabbccdd"
INVITEE_KEY = "11223344"


def _base_config(
    *,
    caller_key: str = CALLER_KEY,
    api_base: str | None = None,
    strict_cors: bool = True,
) -> dict[str, Any]:
    return {
        "web": {
            "port": 9921,
            "strict_cors": strict_cors,
            "api_base": api_base,
        },
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
        "identity": {"key": caller_key, "name": "caller", "type": "human"},
    }


def _seed_registry(
    *,
    caller_in_conv: bool = True,
    invitee_registered: bool = True,
    invitee_already_member: bool = False,
    conversation: str = "general",
) -> ParticipantRegistry:
    """Build a registry with deterministic keys for the inviter and invitee.

    Phil's pattern from test_api_conversations.py: ``ParticipantRegistry.join``
    accepts an explicit ``key=`` so tests don't depend on UUID randomness.
    """
    reg = ParticipantRegistry()
    if caller_in_conv:
        reg.join(
            "caller", conversation, participant_type="human", key=CALLER_KEY
        )
    else:
        # Register the caller under a *different* conversation so the
        # 403 path is exercised by membership absence — not by unknown key.
        reg.join("caller", "other", participant_type="human", key=CALLER_KEY)

    if invitee_registered:
        if invitee_already_member:
            reg.join(
                "invitee", conversation, participant_type="claude", key=INVITEE_KEY
            )
        else:
            reg.join(
                "invitee", "elsewhere", participant_type="claude", key=INVITEE_KEY
            )
    return reg


def _seed_conv_meta(data_dir: Path, name: str = "general") -> None:
    save_meta(
        ConversationMeta(
            name=name,
            topic="",
            created_by="caller",
            created_at="2026-05-18T00:00:00Z",
            last_activity="2026-05-18T00:00:00Z",
        ),
        data_dir,
    )


def _client(
    config: dict[str, Any],
    registry: ParticipantRegistry,
    publish_fn: PublishSpy,
    conv_data_dir: Path,
) -> TestClient:
    post_route = build_invite_post_route(
        config,
        registry_provider=lambda: registry,
        publish_fn_provider=lambda: publish_fn,
        conv_data_dir_provider=lambda: conv_data_dir,
    )
    options_route = build_invite_options_route(config)
    app = Starlette(routes=[post_route, options_route])
    return TestClient(app)


# ---------------------------------------------------------------------------
# 1. Happy path
# ---------------------------------------------------------------------------


def test_invite_happy_path(tmp_path: Path) -> None:
    """Caller is a member + invitee registered + conv exists -> 200."""
    config = _base_config()
    registry = _seed_registry()
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={"conversation_id": "general", "invitee_key": INVITEE_KEY},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "invited": True,
        "invitee_key": INVITEE_KEY,
        "conversation_id": "general",
    }
    # tool_comms_invite published a system message on the general topic.
    assert spy.call_count == 1
    topic, payload, retain = spy.last_call  # type: ignore[misc]
    assert topic == "claude-comms/conv/general/messages"
    assert b"invited" in payload


def test_invite_happy_path_propagates_note(tmp_path: Path) -> None:
    """Optional ``note`` ends up in the system message body."""
    config = _base_config()
    registry = _seed_registry()
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={
            "conversation_id": "general",
            "invitee_key": INVITEE_KEY,
            "note": "welcome aboard",
        },
    )
    assert r.status_code == 200, r.text
    assert spy.call_count == 1
    _, payload, _ = spy.last_call  # type: ignore[misc]
    assert b"welcome aboard" in payload


# ---------------------------------------------------------------------------
# 2. Authorization: 403 when caller not a member
# ---------------------------------------------------------------------------


def test_invite_403_when_caller_not_member(tmp_path: Path) -> None:
    """Caller's daemon identity is not a member of the target conv."""
    config = _base_config()
    registry = _seed_registry(caller_in_conv=False)
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={"conversation_id": "general", "invitee_key": INVITEE_KEY},
    )
    assert r.status_code == 403
    body = r.json()
    assert "not a member" in body["error"].lower()
    # No publish should have fired — auth check is gate-first.
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 3. Invalid invitee
# ---------------------------------------------------------------------------


def test_invite_400_when_invitee_key_unknown(tmp_path: Path) -> None:
    """invitee_key is hex8-valid but not a registered participant -> 400."""
    config = _base_config()
    registry = _seed_registry(invitee_registered=False)
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={"conversation_id": "general", "invitee_key": "deadbeef"},
    )
    assert r.status_code == 400
    assert "unknown" in r.json()["error"].lower()
    assert spy.call_count == 0


def test_invite_400_when_invitee_key_malformed(tmp_path: Path) -> None:
    """invitee_key is not 8 lowercase hex chars -> 400 with format hint."""
    config = _base_config()
    registry = _seed_registry()
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={
            "conversation_id": "general",
            "invitee_key": "NOT-HEX-AT-ALL",
        },
    )
    assert r.status_code == 400
    assert "invalid invitee_key" in r.json()["error"].lower()
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 4. Conversation-not-found
# ---------------------------------------------------------------------------


def test_invite_404_when_conversation_missing(tmp_path: Path) -> None:
    """No meta.json for the conv -> 404 (tool_comms_invite "not found" path).

    We still need the caller to be a member at the registry level, otherwise
    the 403 gate fires first. We seed membership without writing meta.json
    so the tool's ``load_meta`` returns None.
    """
    config = _base_config()
    registry = _seed_registry()
    # IMPORTANT: do NOT call _seed_conv_meta(tmp_path, "general") here.
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={"conversation_id": "general", "invitee_key": INVITEE_KEY},
    )
    assert r.status_code == 404
    assert "not found" in r.json()["error"].lower()
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 5. Body validation
# ---------------------------------------------------------------------------


def test_invite_400_on_malformed_json(tmp_path: Path) -> None:
    """Non-JSON body -> 400 with explicit hint."""
    config = _base_config()
    registry = _seed_registry()
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        content=b"this is not json {",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert "valid json" in r.json()["error"].lower()


def test_invite_400_on_missing_conversation_id(tmp_path: Path) -> None:
    config = _base_config()
    registry = _seed_registry()
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={"invitee_key": INVITEE_KEY},
    )
    assert r.status_code == 400
    assert "conversation_id" in r.json()["error"]


def test_invite_400_on_missing_invitee_key(tmp_path: Path) -> None:
    config = _base_config()
    registry = _seed_registry()
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={"conversation_id": "general"},
    )
    assert r.status_code == 400
    assert "invitee_key" in r.json()["error"]


def test_invite_400_on_invalid_conversation_id_format(tmp_path: Path) -> None:
    """conversation_id fails ``validate_conv_id`` (uppercase / spaces / etc.)."""
    config = _base_config()
    registry = _seed_registry()
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={
            "conversation_id": "UPPERCASE BAD",
            "invitee_key": INVITEE_KEY,
        },
    )
    assert r.status_code == 400
    assert "invalid conversation_id" in r.json()["error"].lower()


# ---------------------------------------------------------------------------
# 6. Idempotency: 409 when invitee is already a member
# ---------------------------------------------------------------------------


def test_invite_409_when_invitee_already_member(tmp_path: Path) -> None:
    """Re-inviting an existing member returns 409 with reason=already_member."""
    config = _base_config()
    registry = _seed_registry(invitee_already_member=True)
    _seed_conv_meta(tmp_path, "general")
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.post(
        "/api/invite",
        json={"conversation_id": "general", "invitee_key": INVITEE_KEY},
    )
    assert r.status_code == 409
    body = r.json()
    assert body == {
        "invited": False,
        "reason": "already_member",
        "invitee_key": INVITEE_KEY,
        "conversation_id": "general",
    }
    # No system message published on the no-op path.
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 7. CORS preflight
# ---------------------------------------------------------------------------


def test_invite_options_preflight_allowed_origin(tmp_path: Path) -> None:
    """OPTIONS returns Allow-Origin matching the allow-list, plus POST in
    Allow-Methods and Content-Type in Allow-Headers."""
    config = _base_config()
    registry = _seed_registry()
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.options(
        "/api/invite",
        headers={
            "Origin": "http://127.0.0.1:9921",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "http://127.0.0.1:9921"
    assert "POST" in r.headers.get("access-control-allow-methods", "")
    assert "OPTIONS" in r.headers.get("access-control-allow-methods", "")
    assert "Content-Type" in r.headers.get("access-control-allow-headers", "")


def test_invite_options_preflight_disallowed_origin(tmp_path: Path) -> None:
    """OPTIONS from an off-allow-list origin gets the methods/headers but
    NOT Access-Control-Allow-Origin (R2-3 contract)."""
    config = _base_config()
    registry = _seed_registry()
    spy = PublishSpy()
    client = _client(config, registry, spy, tmp_path)

    r = client.options(
        "/api/invite",
        headers={
            "Origin": "http://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r.status_code == 200
    # The browser will refuse to use the preflight without Allow-Origin.
    assert "access-control-allow-origin" not in {
        k.lower() for k in r.headers.keys()
    }


# ---------------------------------------------------------------------------
# 8. Route presence: invite route is unconditionally built (unlike artifact
#    POST which is gated by web.allow_remote_edits + reverse-proxy mode).
# ---------------------------------------------------------------------------


def test_invite_route_built_unconditionally() -> None:
    """``build_invite_post_route`` should never return None — invite is a
    first-class REST endpoint, not feature-flagged."""
    config = _base_config()
    route = build_invite_post_route(
        config,
        registry_provider=lambda: ParticipantRegistry(),
        publish_fn_provider=lambda: PublishSpy(),
        conv_data_dir_provider=lambda: Path("/tmp"),
    )
    assert route is not None


@pytest.mark.parametrize(
    "config_overrides",
    [
        {"api_base": "https://comms.example.com"},  # reverse-proxy mode
        {"strict_cors": False},  # legacy CORS mode
    ],
)
def test_invite_route_built_in_proxy_and_legacy_modes(
    config_overrides: dict[str, Any],
) -> None:
    """Reverse-proxy mode and legacy strict_cors=false don't disable the
    invite route — both surface paths still need it."""
    config = _base_config(**config_overrides)
    route = build_invite_post_route(
        config,
        registry_provider=lambda: ParticipantRegistry(),
        publish_fn_provider=lambda: PublishSpy(),
        conv_data_dir_provider=lambda: Path("/tmp"),
    )
    assert route is not None
