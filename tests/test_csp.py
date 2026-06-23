"""
Regression tests for ``build_csp`` and ``_expand_loopback_aliases``.

Single-origin Phase 3 collapsed the default CSP to ``connect-src 'self'``.
With the SPA, REST/MCP API, and the broker ``/mqtt`` WS bridge all served from
the same web port (Phases 1+2), the browser only talks to its own origin, so
``'self'`` uniformly covers REST + broker for localhost, LAN, Tailscale, and
HTTPS with ZERO host enumeration. This ends the alias-enumeration whack-a-mole
that earlier releases fought.

The legacy enumerated ``connect-src`` is preserved ONLY when ``web.api_base`` is
set (reverse-proxy compat), and the parametrized cases below pin that contract.

History: 0.2.0 through 0.2.2 shipped a CSP that only allowed
``ws://127.0.0.1:9001`` in ``connect-src``; loading via ``http://localhost:9921``
built a broker URL of ``ws://localhost:9001`` which CSP blocked, hanging the UI
on "Reconnecting to broker...". 0.2.3 fixed it by enumerating loopback aliases.
Single-origin makes that whole class of bug impossible by serving everything
same-origin.
"""

from __future__ import annotations

import pytest

from claude_comms.cli import _expand_loopback_aliases, build_csp


# --------------------------------------------------------------------------
# _expand_loopback_aliases (still used by the legacy api_base branch)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "0.0.0.0", "::1"])
def test_expand_loopback_returns_both_aliases(host: str) -> None:
    """Every loopback bind alias must expand to {127.0.0.1, localhost}."""
    aliases = _expand_loopback_aliases(host)
    assert "127.0.0.1" in aliases
    assert "localhost" in aliases


def test_expand_non_loopback_passes_through() -> None:
    """A LAN IP / Tailscale name is returned unchanged."""
    assert _expand_loopback_aliases("10.0.0.5") == ["10.0.0.5"]
    assert _expand_loopback_aliases("my-laptop.tailnet.ts.net") == [
        "my-laptop.tailnet.ts.net"
    ]


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


@pytest.fixture
def default_config() -> dict:
    """The default single-origin config: web.api_base UNSET."""
    return {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"host": "127.0.0.1", "port": 9921},
    }


def _connect_directive(csp: str) -> str:
    """Extract the connect-src directive substring for targeted assertions."""
    return next(d for d in csp.split("; ") if d.startswith("connect-src "))


# --------------------------------------------------------------------------
# build_csp — DEFAULT single-origin: connect-src collapses to 'self'
# --------------------------------------------------------------------------


def test_csp_default_connect_src_is_self_only(default_config: dict) -> None:
    """The single-origin payoff: connect-src is exactly ``'self'``."""
    connect = _connect_directive(build_csp(default_config))
    assert connect == "connect-src 'self'"


def test_csp_default_has_no_host_enumeration(default_config: dict) -> None:
    """No REST/broker origin enumeration under single-origin — same-origin
    'self' covers localhost, LAN, Tailscale, and HTTPS with zero host knowledge.
    """
    csp = build_csp(default_config)
    # None of the old enumerated forms should appear anywhere in the policy.
    assert "http://localhost:9920" not in csp
    assert "http://127.0.0.1:9920" not in csp
    assert "https://localhost:9920" not in csp
    assert "https://127.0.0.1:9920" not in csp
    assert "ws://localhost:9001" not in csp
    assert "ws://127.0.0.1:9001" not in csp
    assert "wss://localhost:9001" not in csp
    assert "wss://127.0.0.1:9001" not in csp
    assert ":9920" not in csp
    assert ":9001" not in csp


@pytest.mark.parametrize(
    "ws_host,mcp_host,web_host",
    [
        ("127.0.0.1", "127.0.0.1", "127.0.0.1"),
        ("0.0.0.0", "0.0.0.0", "0.0.0.0"),
        ("10.0.0.5", "10.0.0.5", "10.0.0.5"),
        (
            "phil-desktop.tail6c27f6.ts.net",
            "127.0.0.1",
            "127.0.0.1",
        ),
    ],
)
def test_csp_default_is_self_regardless_of_bind(
    ws_host: str, mcp_host: str, web_host: str
) -> None:
    """The single-origin collapse is independent of bind host: loopback, LAN,
    0.0.0.0, and a Tailscale ws_host all produce ``connect-src 'self'`` because
    nothing is cross-origin anymore (no api_base set).
    """
    cfg = {
        "broker": {"ws_host": ws_host, "ws_port": 9001},
        "mcp": {"host": mcp_host, "port": 9920},
        "web": {"host": web_host, "port": 9921},
    }
    connect = _connect_directive(build_csp(cfg))
    assert connect == "connect-src 'self'"


def test_csp_default_extra_connect_src_still_appended(default_config: dict) -> None:
    """The ``csp_extra_connect_src`` escape hatch is honored even in the
    collapsed default mode (appended verbatim to 'self').
    """
    cfg = dict(default_config)
    cfg["web"] = {
        **default_config["web"],
        "csp_extra_connect_src": ["https://telemetry.example.com"],
    }
    connect = _connect_directive(build_csp(cfg))
    assert connect == "connect-src 'self' https://telemetry.example.com"


# --------------------------------------------------------------------------
# build_csp — directives unchanged by the collapse
# --------------------------------------------------------------------------


def test_csp_has_font_src_directive(default_config: dict) -> None:
    """0.2.3 bundles Inter via @fontsource so font-src can stay self-hosted."""
    csp = build_csp(default_config)
    assert "font-src 'self' data:" in csp


def test_csp_script_src_is_strict(default_config: dict) -> None:
    """script-src must NOT include unsafe-inline or unsafe-eval (XSS path)."""
    csp = build_csp(default_config)
    script_directive = next(d for d in csp.split("; ") if d.startswith("script-src "))
    assert "'unsafe-inline'" not in script_directive
    assert "'unsafe-eval'" not in script_directive


def test_csp_worker_src_allows_blob(default_config: dict) -> None:
    """MQTT.js spawns a Web Worker from a blob: URL; CSP must explicitly
    allow it. Without ``worker-src 'self' blob:`` the directive falls back
    to script-src which blocks blob: and breaks MQTT message handling.
    """
    csp = build_csp(default_config)
    worker_directive = next(
        (d for d in csp.split("; ") if d.startswith("worker-src ")), None
    )
    assert worker_directive is not None, "worker-src directive missing"
    assert "'self'" in worker_directive
    assert "blob:" in worker_directive


def test_csp_has_hardening_directives(default_config: dict) -> None:
    """frame-ancestors / base-uri / form-action stay pinned."""
    csp = build_csp(default_config)
    assert "frame-ancestors 'none'" in csp
    assert "base-uri 'self'" in csp
    assert "form-action 'self'" in csp


def test_csp_no_wildcards(default_config: dict) -> None:
    """No source list should contain a bare ``*`` (defeats CSP)."""
    csp = build_csp(default_config)
    for directive in csp.split("; "):
        tokens = directive.split()
        assert "*" not in tokens, f"Wildcard in directive: {directive!r}"


# --------------------------------------------------------------------------
# build_csp — LEGACY reverse-proxy / Tailscale-Funnel compat (api_base set)
#
# When an operator still pins ``web.api_base`` the enumerated connect-src is
# preserved: api_base REST origin + ws_port broker origins + always-on loopback.
# --------------------------------------------------------------------------


_TS_HOST = "phil-desktop.tail6c27f6.ts.net"


def test_csp_legacy_api_base_uses_external_origin() -> None:
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": "https://comms.example.com"},
    }
    csp = build_csp(cfg)
    assert "https://comms.example.com" in csp
    # Broker WS origin uses the BROKER ws_port, NOT the api_base REST port, and
    # is an origin (scheme://host:port) — no /mqtt path.
    assert "wss://comms.example.com:9001" in csp
    assert "ws://comms.example.com:9001" in csp
    assert "/mqtt" not in csp


def test_csp_legacy_api_base_broker_uses_ws_port_not_api_port() -> None:
    """#17 regression: api_base on the REST port (9920) must NOT leak into the
    broker WS origin. The broker lives on broker.ws_port (9001).
    """
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": "https://phil-desktop.tail16c27f6.ts.net:9920"},
    }
    csp = build_csp(cfg)
    host = "phil-desktop.tail16c27f6.ts.net"
    assert f"ws://{host}:9001" in csp
    assert f"wss://{host}:9001" in csp
    assert "https://phil-desktop.tail16c27f6.ts.net:9920" in csp
    # Loopback REST + broker always present in the legacy branch.
    assert "http://localhost:9920" in csp
    assert "ws://localhost:9001" in csp
    # The bogus api-port-derived broker origin must be gone.
    assert f"ws://{host}:9920/mqtt" not in csp
    assert f"wss://{host}:9920/mqtt" not in csp


def test_csp_legacy_api_base_still_allows_loopback_rest_and_broker() -> None:
    """Reverse-proxy mode must NOT drop loopback origins."""
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": "https://phil-desktop.example.ts.net:9920"},
    }
    csp = build_csp(cfg)
    assert "https://phil-desktop.example.ts.net:9920" in csp
    assert "http://localhost:9920" in csp
    assert "http://127.0.0.1:9920" in csp
    assert "ws://localhost:9001" in csp


def test_csp_legacy_api_base_explicit_ws_url_honored() -> None:
    """``web.ws_url`` pins an explicit broker WS origin verbatim in legacy mode."""
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {
            "api_base": "https://comms.example.com",
            "ws_url": "wss://comms.example.com/mqtt",
        },
    }
    csp = build_csp(cfg)
    assert "wss://comms.example.com/mqtt" in csp


def test_csp_legacy_api_base_full_matrix_no_bogus_mqtt() -> None:
    """Reverse-proxy mode — api_base REST + ws_port broker + loopback REST +
    loopback broker, and NO bogus ``:9920/mqtt`` origin.
    """
    api_base = f"https://{_TS_HOST}:9920"
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": api_base},
    }
    csp = build_csp(cfg)
    assert api_base in csp
    assert f"ws://{_TS_HOST}:9001" in csp
    assert f"wss://{_TS_HOST}:9001" in csp
    assert "http://localhost:9920" in csp
    assert "http://127.0.0.1:9920" in csp
    assert "ws://localhost:9001" in csp
    assert "ws://127.0.0.1:9001" in csp
    assert "/mqtt" not in csp
    assert f"ws://{_TS_HOST}:9920" not in csp


def test_csp_extra_connect_src_escape_hatch_legacy() -> None:
    """``web.csp_extra_connect_src`` is appended to connect-src verbatim in the
    legacy (api_base set) branch too.
    """
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {
            "api_base": "https://comms.example.com",
            "csp_extra_connect_src": [
                "ws://my-laptop.tailnet.ts.net:9001",
                "http://my-laptop.tailnet.ts.net:9920",
            ],
        },
    }
    csp = build_csp(cfg)
    assert "ws://my-laptop.tailnet.ts.net:9001" in csp
    assert "http://my-laptop.tailnet.ts.net:9920" in csp


def test_csp_legacy_connect_src_origins_are_deduped() -> None:
    """connect-src must not contain duplicate origins in the legacy branch."""
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {
            "api_base": "https://comms.example.com",
            "csp_extra_connect_src": ["wss://comms.example.com:9001"],
        },
    }
    connect = _connect_directive(build_csp(cfg))
    tokens = connect[len("connect-src ") :].split()
    assert len(tokens) == len(set(tokens)), f"duplicate origins: {tokens}"
