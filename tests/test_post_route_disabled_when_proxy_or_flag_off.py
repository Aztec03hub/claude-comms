"""Route-presence matrix for POST /api/artifacts/{conv}/{name}.

The POST route is registered if and only if:
    ``web.allow_remote_edits is True`` AND NOT reverse-proxy mode

where reverse-proxy mode is triggered by either ``web.api_base`` being
truthy OR the ``REVERSE_PROXY=1`` env var.

This test runs the 2x2 presence matrix + env-var variant + the
capabilities endpoint's ``writable`` flag, verifying the UI's source of
truth always agrees with the server's routing decision.
"""

from __future__ import annotations

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from claude_comms.cli import (
    build_artifact_post_route,
    build_capabilities_route,
)


def _noop_provider():
    return None


def _make_config(*, allow: bool, api_base: str | None) -> dict:
    return {
        "web": {
            "allow_remote_edits": allow,
            "strict_cors": True,
            "port": 9921,
            "api_base": api_base,
        },
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }


def _build_post(config: dict):
    return build_artifact_post_route(
        config,
        registry_provider=_noop_provider,
        publish_fn_provider=_noop_provider,
        data_dir_provider=_noop_provider,
    )


def _capabilities_writable(config: dict) -> bool:
    app = Starlette(routes=[build_capabilities_route(config)])
    client = TestClient(app)
    r = client.get("/api/capabilities")
    assert r.status_code == 200
    return bool(r.json()["writable"])


@pytest.mark.parametrize(
    "allow,api_base,env,expect_route,expect_writable",
    [
        # (a) api_base=null, allow_remote_edits=false -> no POST, not writable
        (False, None, None, False, False),
        # (b) api_base=null, allow_remote_edits=true -> POST present, writable
        (True, None, None, True, True),
        # (c) api_base set, allow_remote_edits=true -> no POST (reverse-proxy wins)
        (True, "https://comms.example.com", None, False, False),
        # (d) REVERSE_PROXY env set, allow_remote_edits=true -> no POST
        (True, None, "1", False, False),
        # Extra: REVERSE_PROXY=0 is treated as false
        (True, None, "0", True, True),
        # Extra: api_base AND allow_remote_edits=false -> both signals disable
        (False, "https://comms.example.com", None, False, False),
    ],
    ids=[
        "proxy-false_flag-false",
        "proxy-false_flag-true",
        "api_base-set_flag-true",
        "env-1_flag-true",
        "env-0_flag-true",
        "api_base-set_flag-false",
    ],
)
def test_route_matrix(
    allow: bool,
    api_base: str | None,
    env: str | None,
    expect_route: bool,
    expect_writable: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if env is None:
        monkeypatch.delenv("REVERSE_PROXY", raising=False)
    else:
        monkeypatch.setenv("REVERSE_PROXY", env)

    config = _make_config(allow=allow, api_base=api_base)
    route = _build_post(config)

    if expect_route:
        assert route is not None, "Expected POST route to be registered"
    else:
        assert route is None, "Expected POST route to be absent"

    writable = _capabilities_writable(config)
    assert writable is expect_writable, (
        f"capabilities.writable must agree with route presence: "
        f"got writable={writable}, route={'present' if route else 'absent'}"
    )
