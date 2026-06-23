"""
Regression tests for ``build_csp`` and ``_expand_loopback_aliases``.

History: 0.2.0 through 0.2.2 shipped a CSP that only allowed
``ws://127.0.0.1:9001`` in ``connect-src``. The web UI builds its broker
URL from ``window.location.hostname``, so loading the page via
``http://localhost:9921`` produced a broker URL of
``ws://localhost:9001`` — which CSP then blocked. The banner stayed
on "Reconnecting to broker..." indefinitely. Fixed in 0.2.3 by
expanding loopback bind hosts to include both ``localhost`` and
``127.0.0.1`` aliases.

These tests pin the contract: a stricter future refactor will trip
them if it accidentally drops one of the aliases or weakens a
``-src`` directive.
"""

from __future__ import annotations

import pytest

from claude_comms.cli import _expand_loopback_aliases, build_csp


# --------------------------------------------------------------------------
# _expand_loopback_aliases
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
# build_csp — default config
# --------------------------------------------------------------------------


@pytest.fixture
def default_config() -> dict:
    return {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"host": "127.0.0.1", "port": 9921},
    }


def test_csp_allows_localhost_websocket(default_config: dict) -> None:
    """The 0.2.0-0.2.2 bug: ws://localhost:9001 was blocked."""
    csp = build_csp(default_config)
    assert "ws://localhost:9001" in csp


def test_csp_allows_127_websocket(default_config: dict) -> None:
    csp = build_csp(default_config)
    assert "ws://127.0.0.1:9001" in csp


def test_csp_allows_localhost_rest(default_config: dict) -> None:
    csp = build_csp(default_config)
    assert "http://localhost:9920" in csp


def test_csp_allows_127_rest(default_config: dict) -> None:
    csp = build_csp(default_config)
    assert "http://127.0.0.1:9920" in csp


def test_csp_includes_https_variants_for_future_tls(default_config: dict) -> None:
    csp = build_csp(default_config)
    assert "https://127.0.0.1:9920" in csp
    assert "https://localhost:9920" in csp
    assert "wss://127.0.0.1:9001" in csp
    assert "wss://localhost:9001" in csp


def test_csp_has_font_src_directive(default_config: dict) -> None:
    """0.2.3 bundles Inter via @fontsource so font-src can stay self-hosted."""
    csp = build_csp(default_config)
    assert "font-src 'self' data:" in csp


def test_csp_script_src_is_strict(default_config: dict) -> None:
    """script-src must NOT include unsafe-inline or unsafe-eval (XSS path)."""
    csp = build_csp(default_config)
    # The directive is "script-src 'self';" — extract it cleanly.
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


def test_csp_no_wildcards(default_config: dict) -> None:
    """No source list should contain a bare ``*`` (defeats CSP)."""
    csp = build_csp(default_config)
    # Strip the legitimate uses: 'self', 'unsafe-inline', 'none', data:.
    for directive in csp.split("; "):
        # A bare ``*`` would appear as a standalone token.
        tokens = directive.split()
        assert "*" not in tokens, f"Wildcard in directive: {directive!r}"


# --------------------------------------------------------------------------
# build_csp — alternate bind addresses
# --------------------------------------------------------------------------


def test_csp_for_lan_bind_expands_specific_host() -> None:
    """When the daemon binds a specific LAN IP, that IP shows up in CSP."""
    cfg = {
        "broker": {"ws_host": "10.0.0.5", "ws_port": 9001},
        "mcp": {"host": "10.0.0.5", "port": 9920},
        "web": {"host": "10.0.0.5", "port": 9921},
    }
    csp = build_csp(cfg)
    assert "http://10.0.0.5:9920" in csp
    assert "ws://10.0.0.5:9001" in csp
    # Loopback REST alias not added for LAN binds — the user typed the LAN IP.
    assert "http://localhost:9920" not in csp
    # The broker loopback WS IS always allowed now so desktop localhost access
    # (http://localhost:9921 -> ws://localhost:9001) works regardless of bind.
    assert "ws://localhost:9001" in csp


def test_csp_for_zero_zero_zero_zero_bind_still_includes_loopback() -> None:
    """``0.0.0.0`` bind binds ALL interfaces, including loopback."""
    cfg = {
        "broker": {"ws_host": "0.0.0.0", "ws_port": 9001},
        "mcp": {"host": "0.0.0.0", "port": 9920},
        "web": {"host": "0.0.0.0", "port": 9921},
    }
    csp = build_csp(cfg)
    assert "ws://localhost:9001" in csp
    assert "ws://127.0.0.1:9001" in csp
    assert "http://localhost:9920" in csp
    assert "http://127.0.0.1:9920" in csp


# --------------------------------------------------------------------------
# build_csp — reverse-proxy / Tailscale-Funnel mode (api_base set)
# --------------------------------------------------------------------------


def test_csp_for_api_base_uses_external_origin() -> None:
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": "https://comms.example.com"},
    }
    csp = build_csp(cfg)
    assert "https://comms.example.com" in csp
    # ws derived from api_base scheme
    assert "wss://comms.example.com/mqtt" in csp


def test_csp_extra_connect_src_escape_hatch() -> None:
    """``web.csp_extra_connect_src`` is appended to connect-src verbatim."""
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {
            "csp_extra_connect_src": [
                "ws://my-laptop.tailnet.ts.net:9001",
                "http://my-laptop.tailnet.ts.net:9920",
            ],
        },
    }
    csp = build_csp(cfg)
    assert "ws://my-laptop.tailnet.ts.net:9001" in csp
    assert "http://my-laptop.tailnet.ts.net:9920" in csp
