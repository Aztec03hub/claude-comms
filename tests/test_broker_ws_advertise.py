"""Tests for robust broker-URL advertisement via /api/capabilities + banner.

Covers:
  - ``/api/capabilities`` always emits ``broker_ws_port`` + ``broker_ws_path``.
  - ``broker_ws_url`` is emitted ONLY when an explicit reachable host is
    configured (api_base / external CSP/CORS host / non-loopback ws_host).
  - ``broker_ws_url`` is OMITTED for loopback / bind-all hosts (the WSL2 case),
    so the client falls back to its own page-host.
  - CSP connect-src includes the advertised ws origin so the browser is
    allowed to connect to it.
  - The web-UI URL helper formats local + external URLs.
"""

from __future__ import annotations

from starlette.applications import Starlette
from starlette.testclient import TestClient

from claude_comms.cli import (
    _advertised_broker_ws,
    _external_reachable_host,
    _web_ui_urls,
    build_capabilities_route,
    build_csp,
)


def _caps(config: dict) -> dict:
    app = Starlette(routes=[build_capabilities_route(config)])
    client = TestClient(app)
    resp = client.get("/api/capabilities")
    assert resp.status_code == 200
    return resp.json()


# ── always-present port + path ────────────────────────────────────────────


def test_capabilities_always_has_port_and_path():
    body = _caps({"broker": {"ws_port": 9001}})
    assert body["broker_ws_port"] == 9001
    assert body["broker_ws_path"] == "/mqtt"


def test_capabilities_honors_custom_ws_port():
    body = _caps({"broker": {"ws_port": 8001}})
    assert body["broker_ws_port"] == 8001


# ── loopback / bind-all → URL OMITTED ─────────────────────────────────────


def test_loopback_ws_host_omits_url():
    body = _caps({"broker": {"ws_host": "127.0.0.1", "ws_port": 9001}})
    assert "broker_ws_url" not in body


def test_bind_all_ws_host_omits_url():
    # The classic WSL2 case: broker binds 0.0.0.0, no external host configured.
    body = _caps({"broker": {"ws_host": "0.0.0.0", "ws_port": 9001}})
    assert "broker_ws_url" not in body


def test_localhost_ws_host_omits_url():
    body = _caps({"broker": {"ws_host": "localhost", "ws_port": 9001}})
    assert "broker_ws_url" not in body


# ── explicit reachable host → URL EMITTED ─────────────────────────────────


def test_api_base_host_emitted():
    body = _caps(
        {
            "web": {"api_base": "https://host.tailnet.ts.net"},
            "broker": {"ws_host": "0.0.0.0", "ws_port": 9001},
        }
    )
    assert body["broker_ws_url"] == "ws://host.tailnet.ts.net:9001/mqtt"


def test_csp_extra_connect_src_host_emitted():
    body = _caps(
        {
            "web": {"csp_extra_connect_src": ["ws://my-pc.tailnet.ts.net:9001"]},
            "broker": {"ws_host": "0.0.0.0", "ws_port": 9001},
        }
    )
    assert body["broker_ws_url"] == "ws://my-pc.tailnet.ts.net:9001/mqtt"


def test_extra_cors_origins_host_emitted():
    body = _caps(
        {
            "web": {"extra_cors_origins": ["http://192.168.1.50:9921"]},
            "broker": {"ws_host": "0.0.0.0", "ws_port": 9001},
        }
    )
    assert body["broker_ws_url"] == "ws://192.168.1.50:9001/mqtt"


def test_explicit_non_loopback_ws_host_emitted():
    body = _caps({"broker": {"ws_host": "10.0.0.4", "ws_port": 9001}})
    assert body["broker_ws_url"] == "ws://10.0.0.4:9001/mqtt"


# ── _external_reachable_host / _advertised_broker_ws units ────────────────


def test_external_host_none_for_loopback():
    assert _external_reachable_host({"broker": {"ws_host": "127.0.0.1"}}) is None
    assert _external_reachable_host({"broker": {"ws_host": "0.0.0.0"}}) is None


def test_external_host_api_base_priority_over_ws_host():
    cfg = {
        "web": {"api_base": "http://tailnet-name:9921"},
        "broker": {"ws_host": "10.0.0.9"},
    }
    assert _external_reachable_host(cfg) == "tailnet-name"


def test_advertised_broker_ws_shape_when_omitted():
    out = _advertised_broker_ws({"broker": {"ws_host": "0.0.0.0", "ws_port": 9001}})
    assert out == {"broker_ws_port": 9001, "broker_ws_path": "/mqtt"}


# ── CSP allows the advertised origin ──────────────────────────────────────


def test_csp_includes_advertised_external_ws():
    cfg = {
        "web": {"extra_cors_origins": ["http://lanbox:9921"]},
        "broker": {"ws_host": "0.0.0.0", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
    }
    csp = build_csp(cfg)
    assert "ws://lanbox:9001" in csp
    # loopback aliases still present for same-machine access
    assert "ws://127.0.0.1:9001" in csp
    assert "ws://localhost:9001" in csp


def test_csp_default_has_no_external_ws():
    cfg = {
        "web": {},
        "broker": {"ws_host": "0.0.0.0", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
    }
    csp = build_csp(cfg)
    assert "ws://127.0.0.1:9001" in csp
    assert "ws://localhost:9001" in csp


def test_csp_always_allows_loopback_ws_even_in_reverse_proxy_mode():
    # Desktop localhost access (http://localhost:9921 → ws://localhost:9001)
    # must work even when api_base is set for remote access.
    cfg = {
        "web": {"api_base": "https://box.ts.net"},
        "broker": {"ws_host": "0.0.0.0", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
    }
    csp = build_csp(cfg)
    assert "ws://localhost:9001" in csp
    assert "ws://127.0.0.1:9001" in csp
    # and the reverse-proxy broker WS origin is present on the BROKER ws_port
    # (NOT the old api_base-port-derived ws://...:<api_port>/mqtt). #17 fix.
    assert "wss://box.ts.net:9001" in csp
    assert "ws://box.ts.net:9001" in csp


def test_csp_no_duplicate_loopback_ws():
    cfg = {
        "web": {},
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
    }
    csp = build_csp(cfg)
    assert csp.count("ws://localhost:9001") == 1


# ── _web_ui_urls banner formatting ────────────────────────────────────────


def test_web_ui_urls_local_only():
    local, external = _web_ui_urls(
        {"web": {"port": 9921}, "broker": {"ws_host": "0.0.0.0"}}
    )
    assert local == "http://localhost:9921"
    assert external is None


def test_web_ui_urls_external_from_host():
    local, external = _web_ui_urls(
        {
            "web": {"port": 9921, "extra_cors_origins": ["http://box.ts.net:9921"]},
            "broker": {"ws_host": "0.0.0.0"},
        }
    )
    assert local == "http://localhost:9921"
    assert external == "http://box.ts.net:9921"


def test_web_ui_urls_external_from_api_base():
    local, external = _web_ui_urls(
        {"web": {"port": 9921, "api_base": "https://funnel.ts.net/"}}
    )
    assert local == "http://localhost:9921"
    assert external == "https://funnel.ts.net"
