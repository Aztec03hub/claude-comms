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
    # The loopback REST/MCP AND broker WS origins are ALWAYS allowed now so
    # desktop localhost access (http://localhost:9921 -> http://localhost:9920
    # and ws://localhost:9001) works regardless of the configured bind.
    assert "http://localhost:9920" in csp
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
    # Broker WS origin uses the BROKER ws_port, NOT the api_base REST port, and
    # is an origin (scheme://host:port) — no /mqtt path. (#17 regression: the
    # old code derived ws from the api_base port + /mqtt, the wrong port.)
    assert "wss://comms.example.com:9001" in csp
    assert "ws://comms.example.com:9001" in csp
    # And it must NOT emit the old api_base-port-derived /mqtt broker origin.
    assert "/mqtt" not in csp


def test_csp_api_base_broker_uses_ws_port_not_api_port() -> None:
    """#17 regression: api_base on the REST port (9920) must NOT leak into the
    broker WS origin. The broker lives on broker.ws_port (9001) — the CSP must
    allow ws://<host>:9001 and wss://<host>:9001, never ws://<host>:9920/mqtt.
    """
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": "https://phil-desktop.tail16c27f6.ts.net:9920"},
    }
    csp = build_csp(cfg)
    host = "phil-desktop.tail16c27f6.ts.net"
    # Broker WS on the correct port.
    assert f"ws://{host}:9001" in csp
    assert f"wss://{host}:9001" in csp
    # REST origin on the api port (the api_base itself).
    assert "https://phil-desktop.tail16c27f6.ts.net:9920" in csp
    # Loopback REST + broker always present.
    assert "http://localhost:9920" in csp
    assert "ws://localhost:9001" in csp
    # The bogus api-port-derived broker origin must be gone.
    assert f"ws://{host}:9920/mqtt" not in csp
    assert f"wss://{host}:9920/mqtt" not in csp


def test_csp_for_api_base_still_allows_loopback_rest_and_broker() -> None:
    """Reverse-proxy mode must NOT drop loopback origins. A desktop page at
    http://localhost:9921 still reaches http://localhost:9920 (REST) and
    ws://localhost:9001 (broker) directly, even when api_base routes the
    laptop/Tailscale path through a non-loopback origin.
    """
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": "https://phil-desktop.example.ts.net:9920"},
    }
    csp = build_csp(cfg)
    # api_base path stays intact for the remote/laptop case.
    assert "https://phil-desktop.example.ts.net:9920" in csp
    # Loopback REST/MCP always present so desktop localhost isn't CSP-blocked.
    assert "http://localhost:9920" in csp
    assert "http://127.0.0.1:9920" in csp
    # Loopback broker WS always present too.
    assert "ws://localhost:9001" in csp


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


# --------------------------------------------------------------------------
# build_csp — comprehensive connect-src matrix
#
# Contract: for EVERY host the page may be served from, connect-src must list
# BOTH the REST origin (mcp_port, default 9920) AND the broker WS origin
# (ws_port, default 9001), for loopback AND the external/advertised host.
#
# History: a page served from the Tailscale host with web.api_base UNSET ran
# the direct-mode branch, which added the external broker WS but NOT its REST
# origin, so fetch http://<tailscale-host>:9920/api/* was CSP-blocked. The old
# code carried a comment claiming the REST origin was "already covered by the
# CORS allow-list" — false: CORS governs the server's response, connect-src
# governs whether the browser may make the request at all.
# --------------------------------------------------------------------------


_TS_HOST = "phil-desktop.tail6c27f6.ts.net"


def _no_connect_directive(csp: str) -> str:
    """Extract the connect-src directive substring for targeted assertions."""
    return next(d for d in csp.split("; ") if d.startswith("connect-src "))


def test_csp_direct_mode_external_via_ws_host_covers_rest_and_broker() -> None:
    """Case 1: direct mode, external host present via a non-loopback ws_host.

    The external host must get BOTH its REST origin (http/https on 9920) AND
    its broker WS origin (ws/wss on 9001), alongside the always-on loopback
    REST + broker.
    """
    cfg = {
        "broker": {"ws_host": _TS_HOST, "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"host": "127.0.0.1", "port": 9921},
    }
    csp = build_csp(cfg)
    # External host: REST (this is the formerly-missing class) + broker.
    assert f"http://{_TS_HOST}:9920" in csp
    assert f"https://{_TS_HOST}:9920" in csp
    assert f"ws://{_TS_HOST}:9001" in csp
    assert f"wss://{_TS_HOST}:9001" in csp
    # Loopback REST + broker always present.
    assert "http://localhost:9920" in csp
    assert "http://127.0.0.1:9920" in csp
    assert "ws://localhost:9001" in csp
    assert "ws://127.0.0.1:9001" in csp


def test_csp_direct_mode_external_rest_not_assumed_covered_by_cors() -> None:
    """The bogus "REST covered by CORS" assumption is gone: in direct mode the
    external host's REST origin is actually present in connect-src.
    """
    cfg = {
        "broker": {"ws_host": _TS_HOST, "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"host": "127.0.0.1", "port": 9921},
    }
    connect = _no_connect_directive(build_csp(cfg))
    assert f"http://{_TS_HOST}:9920" in connect


def test_csp_direct_mode_external_via_csp_extra_also_gets_rest() -> None:
    """Case 2: external host present ONLY via csp_extra_connect_src.

    An operator who adds just ``ws://<host>:9001`` to csp_extra should still
    end up with that host's REST origin allowed — _external_reachable_host
    derives the host from the csp_extra entry, and direct mode then adds BOTH
    REST and broker for it. So operators no longer need to also hand-add the
    REST entry.
    """
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {
            "csp_extra_connect_src": [f"ws://{_TS_HOST}:9001"],
        },
    }
    csp = build_csp(cfg)
    # The verbatim extra entry is present.
    assert f"ws://{_TS_HOST}:9001" in csp
    # And the REST origin for that host is derived automatically.
    assert f"http://{_TS_HOST}:9920" in csp
    assert f"https://{_TS_HOST}:9920" in csp
    # Broker wss variant too.
    assert f"wss://{_TS_HOST}:9001" in csp
    # Loopback still intact.
    assert "http://localhost:9920" in csp
    assert "ws://localhost:9001" in csp


def test_csp_api_base_mode_full_matrix_no_bogus_mqtt() -> None:
    """Case 3: reverse-proxy mode — api_base REST + ws_port broker + loopback
    REST + loopback broker, and NO bogus ``:9920/mqtt`` origin.
    """
    api_base = f"https://{_TS_HOST}:9920"
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"api_base": api_base},
    }
    csp = build_csp(cfg)
    # api_base is the authoritative REST origin.
    assert api_base in csp
    # Broker WS on the correct port (9001), not the api port.
    assert f"ws://{_TS_HOST}:9001" in csp
    assert f"wss://{_TS_HOST}:9001" in csp
    # Loopback REST + broker always present.
    assert "http://localhost:9920" in csp
    assert "http://127.0.0.1:9920" in csp
    assert "ws://localhost:9001" in csp
    assert "ws://127.0.0.1:9001" in csp
    # No bogus api-port-derived /mqtt origin.
    assert "/mqtt" not in csp
    assert f"ws://{_TS_HOST}:9920" not in csp


def test_csp_loopback_only_config_has_no_external() -> None:
    """Case 4: plain loopback-only config — loopback REST + broker, no external.

    No non-loopback host should leak into connect-src.
    """
    cfg = {
        "broker": {"ws_host": "127.0.0.1", "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {"host": "127.0.0.1", "port": 9921},
    }
    csp = build_csp(cfg)
    # Loopback REST + broker, both aliases, both scheme variants.
    assert "http://localhost:9920" in csp
    assert "https://localhost:9920" in csp
    assert "http://127.0.0.1:9920" in csp
    assert "https://127.0.0.1:9920" in csp
    assert "ws://localhost:9001" in csp
    assert "wss://localhost:9001" in csp
    assert "ws://127.0.0.1:9001" in csp
    assert "wss://127.0.0.1:9001" in csp
    # No external host present.
    assert ".ts.net" not in csp
    assert "10.0.0" not in csp


def test_csp_connect_src_origins_are_deduped() -> None:
    """connect-src must not contain duplicate origins even when the external
    host derivation overlaps with loopback/extra entries.
    """
    cfg = {
        "broker": {"ws_host": _TS_HOST, "ws_port": 9001},
        "mcp": {"host": "127.0.0.1", "port": 9920},
        "web": {
            "csp_extra_connect_src": [f"ws://{_TS_HOST}:9001"],
        },
    }
    connect = _no_connect_directive(build_csp(cfg))
    # Strip the "connect-src " prefix, split into origin tokens.
    tokens = connect[len("connect-src ") :].split()
    assert len(tokens) == len(set(tokens)), f"duplicate origins: {tokens}"
