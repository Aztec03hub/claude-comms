"""CLI interface for Claude Comms.

Provides the main Typer app, conversation sub-group, and all top-level
commands: init, start, stop, send, status, tui, web, log.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
import warnings
import webbrowser
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import typer
from rich.console import Console
from rich.table import Table


if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from starlette.requests import Request
    from starlette.responses import Response
    from starlette.routing import Route, WebSocketRoute
    from starlette.websockets import WebSocket

from claude_comms import __version__
from claude_comms.config import (
    get_config_path,
    get_default_config,
    is_reverse_proxy_mode,
    load_config,
    save_config,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Module-level state for the daemon's HTTP server
#
# The bearer token is authoritative here in memory. It is generated fresh on
# every daemon start; the ``~/.claude-comms/web-token`` file is written with
# chmod 600 purely for operational visibility (so an operator can curl the
# API) but the server always compares against ``_WEB_TOKEN`` itself.
# ---------------------------------------------------------------------------

_WEB_TOKEN: str | None = None
_WEB_TOKEN_PATH = Path.home() / ".claude-comms" / "web-token"
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1"})
_SESSION_EXPIRED_MSG = "Session expired — reload the page"


def _generate_web_token() -> str:
    """Return a fresh 32-byte url-safe bearer token. Called on daemon start."""
    return secrets.token_urlsafe(32)


def _persist_web_token(token: str, path: Path = _WEB_TOKEN_PATH) -> None:
    """Write the bearer token to ``~/.claude-comms/web-token`` with chmod 600.

    Operational convenience only — the in-memory ``_WEB_TOKEN`` is the
    server-side source of truth.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text(token, encoding="utf-8")
        try:
            path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            warnings.warn(
                f"Could not set chmod 600 on {path}; bearer token may be world-readable.",
                stacklevel=2,
            )
    except OSError as exc:
        # Don't crash the daemon — the in-memory token is still authoritative.
        warnings.warn(f"Could not persist bearer token to {path}: {exc}", stacklevel=2)


def set_web_token(token: str | None) -> None:
    """Set the module-level bearer token. Used by daemon startup and tests."""
    global _WEB_TOKEN
    # _WEB_TOKEN is an intentionally mutable module-level token store; the
    # uppercase name predates this code and is load-bearing across the module,
    # so the reassignment here is by design rather than an accidental
    # constant overwrite.
    _WEB_TOKEN = token  # pyright: ignore[reportConstantRedefinition]


def get_web_token() -> str | None:
    """Return the current bearer token (or None before the daemon initialises)."""
    return _WEB_TOKEN


def _is_loopback(request: Any) -> bool:
    """Return True if the request came directly from the loopback interface.

    Reads ``request.client.host`` only — ``X-Forwarded-For`` / ``X-Real-IP``
    are never consulted because they are trivially spoofable. This is why
    the POST route is refused entirely in reverse-proxy mode.
    """
    client = getattr(request, "client", None)
    if client is None:
        return False
    return getattr(client, "host", None) in _LOOPBACK_HOSTS


def _resolve_cors_origin(request: Any, allow_list: list[str]) -> str | None:
    """Exact-match CORS origin check. Returns the origin on match, else None.

    R2-3 fix: the previous ``origin in allow_list_substring_match`` pattern
    was bypassable (``http://evil.com/http://127.0.0.1:9921`` passed because
    the allowed origin appeared as a substring of the attacker origin).

    When this returns None the caller MUST omit ``Access-Control-Allow-Origin``
    entirely — falling back to ``allow_list[0]`` (the old behavior) is wrong
    because it would echo a safe-looking origin even to a forged request.
    """
    origin = request.headers.get("origin", "")
    if not origin:
        return None
    return origin if origin in allow_list else None


def _resolve_cors_origin_legacy(request: Any, allow_list: list[str]) -> str | None:
    """Legacy substring-match CORS check, retained only for the rollback
    runbook escape hatch ``web.strict_cors: false``. Emits a deprecation
    warning every time it's invoked so operators notice they're on the
    insecure path.
    """
    origin = request.headers.get("origin", "")
    if not origin:
        return None
    for allowed in allow_list:
        if allowed and allowed in origin:
            logger.warning(
                "strict_cors=false: accepted origin %r via legacy substring "
                "match against %r. Set strict_cors=true to enforce exact match.",
                origin,
                allowed,
            )
            return allowed
    return None


def _cors_origin_for(
    request: Any, allow_list: list[str], *, strict: bool
) -> str | None:
    """Dispatch between exact-match and legacy substring CORS resolution."""
    if strict:
        return _resolve_cors_origin(request, allow_list)
    return _resolve_cors_origin_legacy(request, allow_list)


def _cors_headers(
    request: Any,
    allow_list: list[str],
    *,
    strict: bool,
    methods: str = "GET, OPTIONS",
    extra_headers: str = "Content-Type",
) -> dict[str, str]:
    """Build CORS response headers. Omits ``Access-Control-Allow-Origin`` when
    the origin is not in ``allow_list`` (per R2-3 fix)."""
    headers = {
        "Access-Control-Allow-Methods": methods,
        "Access-Control-Allow-Headers": extra_headers,
    }
    origin = _cors_origin_for(request, allow_list, strict=strict)
    if origin is not None:
        headers["Access-Control-Allow-Origin"] = origin
    return headers


_LOOPBACK_BIND_ADDRESSES = frozenset({"127.0.0.1", "localhost", "0.0.0.0", "::1"})


def _web_cors_allow_list(web_cfg: dict[str, Any]) -> list[str]:
    """Allowed CORS origins for the web UI calling the API cross-port.

    Base = loopback web origins (localhost/127.0.0.1 on the web port) + the vite
    dev ports. Plus ``api_base`` when set. Plus, when ``api_base`` is set, the web
    origin DERIVED from api_base's host on the web port — so a Tailscale/LAN
    deployment that points api_base at its external host also allows the matching
    web origin with no extra config. Plus any explicit ``web.extra_cors_origins``
    (escape hatch, mirrors ``web.csp_extra_connect_src`` for cross-network use).
    """
    web_port = web_cfg.get("port", 9921)
    allow = [
        f"http://localhost:{web_port}",
        f"http://127.0.0.1:{web_port}",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]
    api_base: str | None = web_cfg.get("api_base")
    if api_base:
        allow.append(api_base)
        from urllib.parse import urlsplit

        parts = urlsplit(api_base)
        if parts.scheme and parts.hostname:
            allow.append(f"{parts.scheme}://{parts.hostname}:{web_port}")
    extra_origins: list[str] = web_cfg.get("extra_cors_origins", []) or []
    for origin in extra_origins:
        if origin:
            allow.append(origin)
    return allow


def _external_reachable_host(config: dict[str, Any]) -> str | None:
    """Best-effort discovery of an explicit, browser-reachable host for the daemon.

    Returns a single hostname (no scheme/port) that every browser on the
    trusted network can use to reach this daemon, or ``None`` when only a
    loopback / bind-all address is configured.

    Priority (first non-loopback hit wins):
      1. ``web.api_base`` host (reverse-proxy / Tailscale Funnel deployments).
      2. The host of any ``web.csp_extra_connect_src`` entry that the operator
         added for a LAN IP / Tailscale magic-DNS name.
      3. The host of any ``web.extra_cors_origins`` entry.
      4. ``broker.ws_host`` when it is an explicit non-loopback bind.

    This reuses the same config the CORS allow-list / CSP already trust, so it
    introduces no new source of truth.
    """
    from urllib.parse import urlsplit

    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    broker_cfg: dict[str, Any] = config.get("broker", {}) or {}

    def _host_of(origin: str) -> str | None:
        if not origin:
            return None
        parts = urlsplit(origin if "://" in origin else f"//{origin}")
        host = parts.hostname
        if host and host not in _LOOPBACK_BIND_ADDRESSES:
            return host
        return None

    api_base: str | None = web_cfg.get("api_base")
    if api_base:
        host = _host_of(api_base)
        if host:
            return host

    csp_extra: list[str] = web_cfg.get("csp_extra_connect_src", []) or []
    for origin in csp_extra:
        host = _host_of(origin)
        if host:
            return host

    extra_cors: list[str] = web_cfg.get("extra_cors_origins", []) or []
    for origin in extra_cors:
        host = _host_of(origin)
        if host:
            return host

    ws_host = broker_cfg.get("ws_host", "127.0.0.1")
    if ws_host and ws_host not in _LOOPBACK_BIND_ADDRESSES:
        return ws_host

    return None


def _web_ui_urls(config: dict[str, Any]) -> tuple[str, str | None]:
    """Return ``(local_url, external_url_or_none)`` for the web UI.

    The local URL always uses ``localhost`` (terminals linkify it and it's
    correct on the daemon's own machine). The external URL is the same web
    port on whatever explicit reachable host the deployment advertises
    (api_base / Tailscale / LAN), reusing ``_external_reachable_host`` — the
    same source the CORS allow-list and broker-WS advertisement trust. It is
    ``None`` when only a loopback/bind-all host is configured.
    """
    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    web_port = web_cfg.get("port", 9921)
    local_url = f"http://localhost:{web_port}"

    external_url: str | None = None
    api_base: str | None = web_cfg.get("api_base")
    if api_base:
        external_url = api_base.rstrip("/")
    else:
        host = _external_reachable_host(config)
        if host:
            external_url = f"http://{host}:{web_port}"
    return local_url, external_url


def _advertised_broker_ws(config: dict[str, Any]) -> dict[str, Any]:
    """Compute the broker WebSocket coordinates the daemon advertises to the UI.

    Returns a dict with always-present ``broker_ws_port`` + ``broker_ws_path``
    and, ONLY when an explicit reachable host is configured, a fully-qualified
    ``broker_ws_url`` (``ws://<host>:<port><path>``).

    The URL is deliberately omitted when the broker is bound to a loopback /
    bind-all address with no external host configured: advertising
    ``ws://127.0.0.1`` or ``ws://0.0.0.0`` would be wrong for every browser
    that isn't on the daemon's own machine (the classic WSL2 case). In that
    case the client falls back to its own page-host, which is correct for
    localhost AND for a LAN/Tailscale name the user typed into the address bar.
    """
    broker_cfg: dict[str, Any] = config.get("broker", {}) or {}
    ws_port = broker_cfg.get("ws_port", 9001)
    ws_path = "/mqtt"
    # Single-origin Phase 2: the web app now bridges the embedded broker at
    # ``/mqtt`` on its OWN port (see ``build_mqtt_ws_route``), so the browser
    # reaches the broker on the same origin as the SPA. Advertise that so the
    # client connects to ``ws(s)://<page-host>/mqtt`` with NO port — correct for
    # http-localhost, http-LAN/Tailscale, AND https-tailscale-serve uniformly,
    # all covered by the existing ``connect-src 'self'`` CSP. The legacy
    # ``broker_ws_port`` / ``broker_ws_url`` fields stay for back-compat with
    # cached SPA bundles that still derive ``ws://host:9001/mqtt`` (the native
    # ``:9001`` listener is kept bound; CSP collapse is Phase 3).
    out: dict[str, Any] = {
        "broker_ws_same_origin": True,
        "broker_ws_port": ws_port,
        "broker_ws_path": ws_path,
    }

    host = _external_reachable_host(config)
    if host:
        out["broker_ws_url"] = f"ws://{host}:{ws_port}{ws_path}"
    return out


def _rest_origins_for_host(host: str, mcp_port: int) -> list[str]:
    """REST/MCP connect-src origins (http+https) for a single host.

    A host the page may be served from must be able to ``fetch`` the REST API
    on the MCP port. CSP ``connect-src`` governs whether the browser is even
    allowed to make the request, independent of the server's CORS response, so
    every reachable host needs its REST origin listed here.
    """
    return [f"http://{host}:{mcp_port}", f"https://{host}:{mcp_port}"]


def _broker_origins_for_host(host: str, ws_port: int) -> list[str]:
    """Broker WebSocket connect-src origins (ws+wss) for a single host.

    The broker listens on ``broker.ws_port`` (default 9001). Origins are
    ``scheme://host:port`` only — no ``/mqtt`` path, since CSP origins never
    include a path component.
    """
    return [f"ws://{host}:{ws_port}", f"wss://{host}:{ws_port}"]


def build_csp(config: dict[str, Any]) -> str:
    """Construct a Content-Security-Policy header value from config.

    Single-origin Phase 3: with the SPA, REST/MCP API, and broker WebSocket all
    served from the same web port (Phases 1+2), the browser only ever talks to
    its own origin. In that default case ``connect-src`` collapses to ``'self'``
    — which uniformly covers REST + MCP + the ``/mqtt`` broker bridge for
    localhost, LAN, Tailscale, and HTTPS with ZERO host knowledge. This ends the
    host-enumeration whack-a-mole that the legacy branch below fought.

    Two modes:

      * **Default (single-origin):** ``web.api_base`` is unset. ``connect-src``
        is just ``'self'`` (plus any ``web.csp_extra_connect_src`` escape-hatch
        entries). No REST/broker origin enumeration is needed or emitted.
      * **Legacy reverse-proxy compat:** ``web.api_base`` is set. The original
        COMPREHENSIVE enumeration is preserved — for every host the page may be
        served from it lists BOTH the REST origin (MCP port, default 9920) AND
        the broker WebSocket origin (ws_port, default 9001) in http(s) / ws(s)
        variants, plus the always-on loopback aliases. This keeps an operator
        who still pins ``web.api_base`` working until that knob is retired.

    ``web.csp_extra_connect_src`` is appended verbatim in BOTH modes as an
    operator escape hatch.

    Note: CORS (the server's response headers) and CSP ``connect-src`` (the
    browser's permission to send the request) are independent. A REST origin
    being in the CORS allow-list does NOT make the browser allow the fetch —
    the origin must also be in ``connect-src``. That is why the legacy branch
    lists every reachable host's REST origin explicitly. Same-origin requests
    skip CORS entirely, so ``'self'`` alone suffices in the default mode.
    """
    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    mcp_cfg: dict[str, Any] = config.get("mcp", {}) or {}
    broker_cfg: dict[str, Any] = config.get("broker", {}) or {}

    api_base: str | None = web_cfg.get("api_base")
    # mcp_port / ws_port only feed the LEGACY (api_base set) enumeration below;
    # the default single-origin branch needs no port knowledge at all.
    mcp_port = mcp_cfg.get("port", 9920)
    ws_port = broker_cfg.get("ws_port", 9001)

    connect_origins: list[str] = ["'self'"]

    if api_base:
        # ── LEGACY reverse-proxy compat (web.api_base set) ─────────────────
        # DEPRECATED under single-origin (see single-origin-design.md Phase 4);
        # kept functional for legacy reverse-proxy deployments; scheduled for
        # removal in a later pass.
        # Reverse-proxy mode: api_base is authoritative for the REST origin.
        connect_origins.append(api_base)
        ws_url = web_cfg.get("ws_url")
        if ws_url:
            # Operator pinned an explicit broker WS origin (e.g. a same-origin
            # tailscale-serve path). Trust it verbatim.
            connect_origins.append(ws_url)
        else:
            # Derive the external broker WS origin from the reachable host and
            # the BROKER ws_port — NOT the api_base REST port. The broker
            # listens on ws_port (default 9001), so an api_base-port-derived
            # origin (e.g. ws://host:9920/mqtt) is the wrong port and blocks
            # the real connection.
            external_host = _external_reachable_host(config)
            if external_host:
                connect_origins.extend(_broker_origins_for_host(external_host, ws_port))

        # ALWAYS allow the loopback broker WebSocket and REST/MCP API in the
        # legacy path. Desktop access via http://localhost:9921 must be able to
        # reach ws://localhost:9001 and http://localhost:9920 (and the 127.0.0.1
        # aliases) even when api_base / a reverse proxy is also configured for
        # remote access. Both alias forms are distinct browser origins.
        for h in ("localhost", "127.0.0.1"):
            connect_origins.extend(_broker_origins_for_host(h, ws_port))
            connect_origins.extend(_rest_origins_for_host(h, mcp_port))
    # ── DEFAULT single-origin: connect-src is just 'self' (+ escape hatch).
    # No REST/broker origin enumeration — same-origin covers everything.

    extra: list[Any] = web_cfg.get("csp_extra_connect_src") or []
    connect_origins.extend(extra)

    # Dedup while preserving first-seen order.
    seen: set[str] = set()
    deduped: list[str] = []
    for origin in connect_origins:
        if origin not in seen:
            seen.add(origin)
            deduped.append(origin)

    connect_src = " ".join(deduped)

    return (
        "default-src 'self'; "
        "script-src 'self'; "
        # MQTT.js spawns a Web Worker from a blob: URL to parse MQTT frames
        # off the main thread. CSP's worker-src falls back to script-src
        # when unset; script-src 'self' does not permit blob: URIs, so the
        # worker is blocked and MQTT message handling silently fails.
        # Explicit worker-src that allows blob: keeps script-src strict
        # while unblocking the legitimate library pattern. Same-origin by
        # spec, so attack surface is not meaningfully broadened.
        "worker-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "font-src 'self' data:; "
        f"connect-src {connect_src}; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )


def security_headers(config: dict[str, Any]) -> dict[str, str]:
    """Standard security headers injected on static-file responses."""
    return {
        "Content-Security-Policy": build_csp(config),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
    }


_META_TAG_RE = re.compile(
    r'<meta\s+name=["\']claude-comms-api-base["\']', re.IGNORECASE
)


def inject_api_base_meta(html: str, api_base: str) -> str:
    """Inject ``<meta name="claude-comms-api-base" content="{api_base}">``
    into the ``<head>`` of the served HTML.

    Idempotent: skips if the meta tag already exists. The daemon calls this
    only when ``config.web.api_base`` is set (reverse-proxy deployments).
    """
    if not api_base:
        return html
    if _META_TAG_RE.search(html):
        return html
    tag = f'<meta name="claude-comms-api-base" content="{api_base}">'
    # Insert right after <head> (case-insensitive). Fall back to prepending
    # if <head> is absent for some reason.
    new_html, count = re.subn(
        r"(<head[^>]*>)", r"\1" + tag, html, count=1, flags=re.IGNORECASE
    )
    if count == 0:
        return tag + html
    return new_html


# ---------------------------------------------------------------------------
# Route builders (extracted so tests can mount them without running the
# full daemon). Each helper returns a Starlette Route object or None.
# ---------------------------------------------------------------------------


def build_capabilities_route(config: dict[str, Any]) -> Route:
    """GET /api/capabilities — same-origin, no auth, cacheable 60s.

    Returns a Starlette ``Route`` describing the deployment's writable status
    and feature flags so the UI can gate its Edit button without relying on
    failed POST responses (R3-2 fix).
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def _handler(request: Request) -> JSONResponse:
        del request  # framework-required signature param, intentionally unused
        web_cfg: dict[str, Any] = config.get("web", {}) or {}
        allow_remote_edits = bool(web_cfg.get("allow_remote_edits", False))
        writable = allow_remote_edits and not is_reverse_proxy_mode(config)
        payload = {
            # Single source of truth: the running daemon's package version
            # (derived from ``pyproject.toml [project] version`` via
            # importlib.metadata). The web UI prefers this live value over
            # its build-time ``package.json`` so a stale bundle can't show a
            # wrong number.
            "version": __version__,
            "writable": writable,
            "features": {
                "markdown_render": bool(web_cfg.get("markdown_render_enabled", True)),
                "diff_view": True,
                "legacy_codeblock": bool(
                    web_cfg.get("use_legacy_codeblock_highlighter", False)
                ),
            },
            # Robust broker URL: tell the web client where to reach the broker
            # WebSocket so it never has to blindly guess from its page host.
            # ``broker_ws_url`` is present ONLY when an explicit reachable host
            # is configured (api_base / external host); when the broker is on a
            # loopback/bind-all address the URL is omitted and the client falls
            # back to its own page-host with the advertised port + path.
            **_advertised_broker_ws(config),
        }
        return JSONResponse(
            payload,
            headers={"Cache-Control": "max-age=60"},
        )

    return Route("/api/capabilities", _handler, methods=["GET"])


_NOTIF_KEY_RE = re.compile(r"^[0-9a-f]{8}$")


def _empty_cors_headers(*args: object) -> dict[str, str]:
    """Default no-op CORS-header provider for route builders under test.

    Accepts and discards the request argument so callers can invoke it like the
    real per-request CORS function while contributing no headers.
    """
    del args
    return {}


def build_notifications_route(
    _config: dict[str, Any] | None = None,
    cors: Callable[..., dict[str, str]] | None = None,
) -> Route:
    """GET /api/notifications/{key} — fetch-and-drain queued notification cues.

    Lets a REMOTE Claude Code host pull its pending cues over HTTP instead of
    reading ``~/.claude-comms/notifications/<key>.jsonl`` off the daemon's local
    disk (which only exists on the daemon's machine — the reason cross-machine
    setups delivered nothing). Each call:

    - Validates ``key`` against ``^[0-9a-f]{8}$`` (rejects path traversal /
      anything non-8-hex with 400).
    - Reads ``hook_installer._notification_dir() / f"{key}.jsonl"``, parsing each
      non-empty line as JSON (malformed lines are skipped, not fatal).
    - Returns ``{"cues": [...], "count": N}``.
    - DRAINS the file (truncates) so cues are delivered exactly once. A missing
      file yields ``{"cues": [], "count": 0}``.

    ``_config`` is accepted for signature parity with the other route builders
    (unused). ``cors`` is the per-request CORS-header function injected by
    ``_run``; defaults to a no-op so tests need no CORS wiring.
    """
    del _config
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    from claude_comms.hook_installer import _notification_dir

    cors_fn = cors or _empty_cors_headers

    async def _handler(request: Request) -> JSONResponse:
        key = request.path_params.get("key", "")
        if not _NOTIF_KEY_RE.match(key):
            return JSONResponse(
                {"error": "invalid key"},
                status_code=400,
                headers=cors_fn(request),
            )

        notif_file = _notification_dir() / f"{key}.jsonl"
        cues: list[Any] = []
        try:
            raw = notif_file.read_text(encoding="utf-8")
        except FileNotFoundError:
            return JSONResponse(
                {"cues": [], "count": 0},
                headers=cors_fn(request),
            )
        except OSError:
            return JSONResponse(
                {"cues": [], "count": 0},
                headers=cors_fn(request),
            )

        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                cues.append(json.loads(line))
            except (ValueError, TypeError):
                continue

        # Drain: deliver each cue at most once.
        try:
            _ = notif_file.write_text("", encoding="utf-8")
        except OSError:
            pass

        return JSONResponse(
            {"cues": cues, "count": len(cues)},
            headers=cors_fn(request),
        )

    return Route("/api/notifications/{key}", _handler, methods=["GET"])


def build_identity_route(
    config: dict[str, Any], cors: Callable[..., dict[str, str]] | None = None
) -> Route:
    """GET /api/identity — return the daemon's configured identity.

    Extracted from the ``_run()`` closure so it can be exercised via a
    Starlette TestClient. ``cors`` is the per-request CORS-header function
    (``_run`` injects its ``_cors``); it defaults to a no-op so tests need no
    CORS wiring.

    FUTURE/CLOUD (NOT PLANNED 2026-06-23, not a TODO): the web UI today adopts
    the daemon's SINGLE configured identity — every browser on this origin is
    "the daemon's owner". Public/multi-user hosting would need per-user login and
    a per-user identity (this endpoint would return the authenticated caller's
    identity, derived from a session, not a single static config value).
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    cors_fn = cors or _empty_cors_headers

    async def _handler(request: Request) -> JSONResponse:
        identity: dict[str, Any] = config.get("identity", {}) or {}
        return JSONResponse(
            {
                "key": identity.get("key", ""),
                "name": identity.get("name", ""),
                "type": identity.get("type", "human"),
            },
            headers=cors_fn(request),
        )

    return Route("/api/identity", _handler, methods=["GET"])


def build_identity_options_route(
    _config: dict[str, Any], cors: Callable[..., dict[str, str]] | None = None
) -> Route:
    """OPTIONS preflight for CORS on /api/identity."""
    del _config
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    cors_fn = cors or _empty_cors_headers

    async def _handler(request: Request) -> JSONResponse:
        return JSONResponse({}, headers=cors_fn(request))

    return Route("/api/identity", _handler, methods=["OPTIONS"])


def build_conversations_route(
    config: dict[str, Any],
    get_conversations: Callable[..., list[dict[str, Any]]],
    cors: Callable[..., dict[str, str]] | None = None,
) -> Route:
    """GET /api/conversations — the daemon's full known conversation set,
    visibility-filtered per the configured caller.

    Extracted from the ``_run()`` closure for TestClient coverage. The data
    source (mcp_server.get_all_conversations_full) is injected because it is
    imported lazily inside ``_run``; ``cors`` defaults to a no-op for tests.
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    cors_fn = cors or _empty_cors_headers

    async def _handler(request: Request) -> JSONResponse:
        # ``?all`` is accepted for back-compat but is a no-op — the endpoint
        # always returns the full known set (visibility-filtered per caller).
        _ = request.query_params.get("all", "false")
        identity: dict[str, Any] = config.get("identity", {}) or {}
        identity_key = identity.get("key", "")
        conversations = get_conversations(caller_key=identity_key)
        return JSONResponse(
            {"conversations": conversations, "count": len(conversations)},
            headers=cors_fn(request),
        )

    return Route("/api/conversations", _handler, methods=["GET"])


def build_conversations_options_route(
    _config: dict[str, Any], cors: Callable[..., dict[str, str]] | None = None
) -> Route:
    """OPTIONS preflight for CORS on /api/conversations."""
    del _config
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    cors_fn = cors or _empty_cors_headers

    async def _handler(request: Request) -> JSONResponse:
        return JSONResponse({}, headers=cors_fn(request))

    return Route("/api/conversations", _handler, methods=["OPTIONS"])


def build_reactions_route(
    get_conversation_reactions: Callable[[str], dict[str, dict[str, list[str]]]],
    cors: Callable[..., dict[str, str]] | None = None,
) -> Route:
    """GET /api/reactions/{conversation} — all reactions for a conversation.

    Returns ``{conversation, reactions: {message_id: {emoji: [actor_key,...]}}}``
    by wrapping ``mcp_server.get_conversation_reactions`` (which delegates to the
    conversation's ``ReactionsStore.get_all()``). The data source is injected
    because it is imported lazily inside ``_run``; ``cors`` defaults to a no-op
    for tests.

    Same trust boundary as ``/api/messages``: token-free same-origin GET, no
    broader auth. The web client already receives every message (incl. whispers)
    on this single-identity origin, so the "who reacted" set is strictly less
    sensitive than the message bodies it already displays. Registered on the
    same shared ``api_routes`` list so the REST and web ports never drift.
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    from claude_comms.message import validate_conv_id

    cors_fn = cors or _empty_cors_headers

    async def _handler(request: Request) -> JSONResponse:
        conversation = request.path_params["conversation"]
        if not validate_conv_id(conversation):
            return JSONResponse(
                {"error": "Invalid conversation ID"},
                status_code=400,
            )
        reactions = get_conversation_reactions(conversation)
        return JSONResponse(
            {"conversation": conversation, "reactions": reactions},
            headers=cors_fn(request),
        )

    return Route("/api/reactions/{conversation}", _handler, methods=["GET"])


def build_reactions_options_route(
    cors: Callable[..., dict[str, str]] | None = None,
) -> Route:
    """OPTIONS preflight for CORS on /api/reactions/{conversation}."""
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    cors_fn = cors or _empty_cors_headers

    async def _handler(request: Request) -> JSONResponse:
        return JSONResponse({}, headers=cors_fn(request))

    return Route("/api/reactions/{conversation}", _handler, methods=["OPTIONS"])


def build_web_token_route() -> Route:
    """GET /api/web-token — loopback-only. Returns the in-memory bearer token.

    R3-4 fix. Non-loopback requests are rejected with 403. ``X-Forwarded-For``
    is never consulted.
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def _handler(request: Request) -> JSONResponse:
        if not _is_loopback(request):
            return JSONResponse({"error": "loopback only"}, status_code=403)
        token = get_web_token()
        if token is None:
            return JSONResponse(
                {"error": "Bearer token not initialised"}, status_code=503
            )
        return JSONResponse({"token": token})

    return Route("/api/web-token", _handler, methods=["GET"])


# ---------------------------------------------------------------------------
# Single-origin Phase 2: in-process broker WebSocket bridge at /mqtt
#
# The browser reaches the embedded amqtt broker at ``ws(s)://<page-host>/mqtt``
# (same origin as the SPA on the web port) WITHOUT a second port or a socket
# proxy. A Starlette WebSocketRoute hands each accepted connection to amqtt's
# PUBLIC ``Broker.external_connected(reader, writer, listener_name)`` via a pair
# of adapters that implement amqtt's ``ReaderAdapter`` / ``WriterAdapter``
# interface, mirroring ``amqtt/adapters.py``'s ``WebSocketsReader`` /
# ``WebSocketsWriter`` exactly (BINARY frames only — a stray text frame would
# corrupt the MQTT byte stream). Bridged sessions join the same
# ``_sessions`` / ``_subscriptions`` as native TCP/WS clients, so TUI <-> web
# <-> MCP interop, retained messages, and LWT all work unchanged.
#
# ── FUTURE / CLOUD NOTE (NOT a TODO, NOT PLANNED as of 2026-06-23) ──
# This in-process bridge is ideal for personal/tailnet single-process use. For
# public/cloud HA you would instead run an EXTERNAL broker (EMQX / Mosquitto)
# plus a shared database, and point the web tier at it — the embedded amqtt
# broker + SQLite assume one trusted process. Not needed for personal use.
# ---------------------------------------------------------------------------


class _ASGIWebSocketReader:
    """amqtt ``ReaderAdapter`` over a Starlette ``WebSocket`` (binary frames).

    Mirrors ``amqtt.adapters.WebSocketsReader``: buffers received binary frames
    and reassembles partial reads in ``read(n)`` (one MQTT packet may arrive
    split across multiple WS frames, or several packets may arrive in one). On
    abrupt close Starlette raises ``WebSocketDisconnect``; we translate that to
    EOF (return whatever is buffered, ``b""`` once drained) the same way the
    native adapter suppresses ``websockets.ConnectionClosed`` — amqtt's reader
    loop treats the empty/short read as a clean disconnect.
    """

    def __init__(self, websocket: WebSocket) -> None:
        import io

        self._ws: WebSocket = websocket
        self._stream: io.BytesIO = io.BytesIO(b"")
        self._eof: bool = False

    async def read(self, n: int = -1) -> bytes | None:
        await self._feed_buffer(n)
        data = self._stream.read(n)
        if not data and self._eof:
            # Clean EOF with nothing buffered: return amqtt's no-data sentinel
            # (``None``), NOT ``b""``. amqtt's ``read_or_raise`` only treats
            # ``None`` (or IncompleteReadError/ConnectionReset/BrokenPipe) as a
            # disconnect; an empty ``bytes`` slips through to ``unpack("!B", b"")``
            # which raises ``struct.error``. That exception is caught by amqtt's
            # generic reader-loop handler (handler.py:540) instead of the clean
            # ``if not fixed_header: break`` EOF path, and the noisy teardown can
            # race the broker's message loop so the abnormal-disconnect will (LWT)
            # is silently dropped. The native ``StreamReaderAdapter`` avoids this
            # because ``readexactly`` raises ``IncompleteReadError`` on EOF, which
            # ``read_or_raise`` maps to ``None``. Returning ``None`` here puts the
            # WS bridge on that same deterministic EOF path so LWT fires reliably.
            return None
        return data

    async def _feed_buffer(self, n: int = 1) -> None:
        import io

        from starlette.websockets import WebSocketDisconnect, WebSocketState

        buffer = bytearray(self._stream.read())
        while not self._eof and len(buffer) < n:
            try:
                message = await self._ws.receive_bytes()
            except (WebSocketDisconnect, RuntimeError):
                # WebSocketDisconnect: peer closed. RuntimeError: Starlette
                # raises this if receive is called after a disconnect/close was
                # already observed. Either way → EOF (mirrors the native
                # adapter's ``suppress(ConnectionClosed)`` + break-on-None).
                self._eof = True
                break
            # Starlette types ``receive_bytes`` as returning ``bytes`` (never
            # None), so the type checker proves this guard dead — but it is an
            # intentional belt-and-braces check, kept as-is. The two ignores
            # below cover only that provably-dead defensive branch.
            if message is None:  # pyright: ignore[reportUnnecessaryComparison]
                self._eof = True
                break
            buffer.extend(message)
            if self._ws.application_state == WebSocketState.DISCONNECTED:
                self._eof = True
                break
        self._stream = io.BytesIO(buffer)

    def feed_eof(self) -> None:
        self._eof = True


class _ASGIWebSocketWriter:
    """amqtt ``WriterAdapter`` over a Starlette ``WebSocket`` (binary frames).

    Mirrors ``amqtt.adapters.WebSocketsWriter``: ``write`` buffers, ``drain``
    flushes the buffer as one binary WS frame (natural backpressure — uvicorn's
    ``send_bytes`` awaits the transport). ``get_peer_info`` comes from
    ``websocket.client``; ``get_ssl_info`` is ``None`` (TLS, if any, is
    terminated by the front proxy / uvicorn before this layer).
    """

    def __init__(self, websocket: WebSocket) -> None:
        import io

        self._ws: WebSocket = websocket
        self._stream: io.BytesIO = io.BytesIO(b"")
        self._closed: bool = False

    def write(self, data: bytes) -> None:
        _ = self._stream.write(data)

    async def drain(self) -> None:
        import io

        data = self._stream.getvalue()
        if data:
            from starlette.websockets import WebSocketDisconnect

            try:
                await self._ws.send_bytes(data)
            except (WebSocketDisconnect, RuntimeError):
                # Peer gone mid-write; mark closed so further drains are no-ops.
                self._closed = True
        self._stream = io.BytesIO(b"")

    def get_peer_info(self):  # type: ignore[no-untyped-def]
        client = getattr(self._ws, "client", None)
        if client is None:
            # No peer info (e.g. ASGI server without client tuple) → amqtt logs
            # a warning and aborts the session, which is correct here.
            return None
        return client.host, client.port

    def get_ssl_info(self):  # type: ignore[no-untyped-def]
        return None

    async def close(self) -> None:
        from starlette.websockets import WebSocketDisconnect, WebSocketState

        if self._closed:
            return
        self._closed = True
        try:
            if self._ws.application_state != WebSocketState.DISCONNECTED:
                await self._ws.close()
        except (WebSocketDisconnect, RuntimeError):
            pass


def build_mqtt_ws_route(
    broker_provider: Callable[[], Any] | None,
) -> WebSocketRoute:
    """Build the ``WebSocketRoute("/mqtt", ...)`` broker bridge.

    ``broker_provider`` is a zero-arg callable returning the live
    :class:`~claude_comms.broker.EmbeddedBroker` (the ``broker_holder[0]``
    pattern used in ``_run_daemon``), or ``None`` while the broker is
    mid-(re)start. The endpoint:

      1. ``accept(subprotocol="mqtt")`` — MQTT-over-WS REQUIRES the ``mqtt``
         subprotocol be echoed (mqtt.js sends it and rejects the socket
         otherwise; amqtt's native WS listener sets it too).
      2. wraps the socket in the amqtt reader/writer adapters above;
      3. hands it to ``amqtt_broker.external_connected(reader, writer,
         "ws-external")`` — which runs the full session until disconnect.

    If the broker (or its live amqtt instance) is unavailable, the WS is closed
    with code 1013 ("try again later") so the client retries.
    """
    from starlette.routing import WebSocketRoute
    from starlette.websockets import WebSocketDisconnect

    async def _endpoint(websocket: WebSocket) -> None:
        # Echo the mqtt subprotocol (REQUIRED for MQTT-over-WS clients).
        await websocket.accept(subprotocol="mqtt")

        broker = broker_provider() if broker_provider else None
        amqtt_broker = getattr(broker, "amqtt_broker", None) if broker else None
        if amqtt_broker is None:
            # Broker mid-restart / not started → 1013 Try Again Later.
            await websocket.close(code=1013)
            return

        reader = _ASGIWebSocketReader(websocket)
        writer = _ASGIWebSocketWriter(websocket)
        try:
            await amqtt_broker.external_connected(reader, writer, "ws-external")
        except WebSocketDisconnect:
            # Abrupt browser close mid-session; amqtt's session teardown (LWT,
            # subscription cleanup) runs in external_connected's finally.
            pass
        finally:
            await writer.close()

    return WebSocketRoute("/mqtt", endpoint=_endpoint)


def build_artifact_post_route(
    config: dict[str, Any],
    *,
    registry_provider: Callable[[], Any],
    publish_fn_provider: Callable[[], Any],
    data_dir_provider: Callable[[], Any],
) -> Route | None:
    """Conditional POST /api/artifacts/{conversation}/{name} (R1-1 + R2-1 + R2-2).

    The route is registered ONLY when
    ``config.web.allow_remote_edits and not is_reverse_proxy_mode(config)``.
    Callers that see ``None`` returned must not register the POST.

    Parameters
    ----------
    registry_provider, publish_fn_provider, data_dir_provider:
        Zero-arg callables returning the current registry / publish_fn /
        data_dir. Indirection (not direct values) lets tests and the daemon
        both point at live module state initialised later in startup.
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    allow_remote_edits = bool(web_cfg.get("allow_remote_edits", False))
    if not allow_remote_edits or is_reverse_proxy_mode(config):
        return None

    from claude_comms.mcp_tools import tool_comms_artifact_update
    from claude_comms.message import validate_conv_id

    async def _handler(request: Request) -> JSONResponse:
        # FUTURE/CLOUD (NOT PLANNED 2026-06-23, not a TODO): the write/admin gate
        # here is loopback-based — it assumes "on the same machine as the daemon"
        # equals "the trusted operator". For any public/multi-tenant hosting this
        # would need to become identity-based authorization (per-user login,
        # per-request authn → authz on the conversation), since a remote browser
        # is never loopback and many users would share one origin.
        # Defense 1: loopback only. X-Forwarded-For is NEVER consulted.
        if not _is_loopback(request):
            return JSONResponse({"error": "loopback only"}, status_code=403)

        # Defense 2: bearer token.
        auth_header = request.headers.get("authorization", "")
        expected_token = get_web_token()
        supplied: str | None = None
        if auth_header.lower().startswith("bearer "):
            supplied = auth_header.split(" ", 1)[1].strip() or None
        if (
            expected_token is None
            or supplied is None
            or not secrets.compare_digest(supplied, expected_token)
        ):
            return JSONResponse({"error": _SESSION_EXPIRED_MSG}, status_code=401)

        # Parse + validate path params.
        conversation = request.path_params.get("conversation", "")
        name = request.path_params.get("name", "")
        if not validate_conv_id(conversation):
            return JSONResponse({"error": "Invalid conversation ID"}, status_code=400)

        try:
            raw_body = await request.json()
        except Exception:
            return JSONResponse(
                {"error": "Request body must be valid JSON"},
                status_code=400,
            )
        if not isinstance(raw_body, dict):
            return JSONResponse(
                {"error": "Request body must be a JSON object"},
                status_code=400,
            )
        # Validated dict; its JSON values are dynamic (Any). ``cast`` is needed
        # because ``isinstance``-narrowing an ``Any`` yields
        # ``dict[Unknown, Unknown]`` that no annotation can refine in place
        # (a plain ``dict[str, Any]`` annotation gets re-narrowed by assignment).
        body = cast("dict[str, Any]", raw_body)

        key = body.get("key", "")
        content = body.get("content", "")
        summary = body.get("summary", "") or ""
        base_version = body.get("base_version")
        if base_version is not None:
            try:
                base_version = int(base_version)
            except (TypeError, ValueError):
                return JSONResponse(
                    {"error": "base_version must be an integer"},
                    status_code=400,
                )
        if not isinstance(key, str) or not key:
            return JSONResponse(
                {"error": "Missing 'key' in request body"},
                status_code=400,
            )
        if not isinstance(content, str):
            return JSONResponse(
                {"error": "'content' must be a string"},
                status_code=400,
            )

        # Defense 2 (authorization layer): the key must be registered AND
        # a member of the target conversation. This is enforced here
        # additionally so we return a clear 403 (not a generic tool error).
        registry = registry_provider()
        if registry is None:
            return JSONResponse(
                {"error": "Participant registry not initialised"},
                status_code=503,
            )
        participant = registry.get(key)
        if participant is None:
            return JSONResponse(
                {"error": f"Participant key {key!r} not registered"},
                status_code=403,
            )
        convs = registry.conversations_for(key)
        if conversation not in convs:
            return JSONResponse(
                {
                    "error": (
                        f"Participant {key!r} is not a member of "
                        f"conversation {conversation!r}"
                    )
                },
                status_code=403,
            )

        publish_fn = publish_fn_provider()
        data_dir = data_dir_provider()
        if publish_fn is None or data_dir is None:
            return JSONResponse(
                {"error": "Daemon not fully initialised"}, status_code=503
            )

        result = await tool_comms_artifact_update(
            registry,
            publish_fn,
            key=key,
            conversation=conversation,
            name=name,
            content=content,
            summary=summary,
            base_version=base_version,
            data_dir=data_dir,
        )

        if result.get("error"):
            msg = str(result.get("message", ""))
            if "conflict" in msg.lower():
                return JSONResponse(result, status_code=409)
            return JSONResponse(result, status_code=400)

        return JSONResponse(result, status_code=200)

    return Route(
        "/api/artifacts/{conversation}/{name}",
        _handler,
        methods=["POST"],
    )


def build_artifact_post_options_route(config: dict[str, Any]) -> Route:
    """OPTIONS preflight for POST /api/artifacts/{conv}/{name}.

    Registered alongside the POST route. Uses the same CORS policy as the
    other endpoints but advertises POST + Authorization.
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    strict = bool(web_cfg.get("strict_cors", True))
    allow_list = _web_cors_allow_list(web_cfg)

    async def _handler(request: Request) -> JSONResponse:
        return JSONResponse(
            {},
            headers=_cors_headers(
                request,
                allow_list,
                strict=strict,
                methods="POST, OPTIONS",
                extra_headers="Content-Type, Authorization",
            ),
        )

    return Route(
        "/api/artifacts/{conversation}/{name}",
        _handler,
        methods=["OPTIONS"],
    )


# ---------------------------------------------------------------------------
# v0.4.2 Step 3.4: POST /api/invite REST surface bridging ``comms_invite`` MCP
# tool. Same indirection-via-provider pattern as build_artifact_post_route so
# tests can mount with fake registries and the daemon binds the live ones.
#
# Caller-identity policy: the body does NOT carry a caller_key. The handler
# uses the daemon's configured ``identity.key`` as the inviter, matching the
# existing ``/api/conversations`` convention. Multi-tenant browser support
# is a follow-up (out of scope for Step 3.4). A request from a daemon whose
# configured identity is not a member of the target conversation returns 403.
# ---------------------------------------------------------------------------


def build_invite_post_route(
    config: dict[str, Any],
    *,
    registry_provider: Callable[[], Any],
    publish_fn_provider: Callable[[], Any],
    conv_data_dir_provider: Callable[[], Any],
) -> Route:
    """POST /api/invite — bridge to ``tool_comms_invite``.

    Body schema: ``{"conversation_id": str, "invitee_key": str, "note": str?}``.

    Returns ``{"invited": true, "invitee_key": ..., "conversation_id": ...}``
    on success. 403 when the caller (daemon identity) is not a member of the
    target conversation. 400 on malformed body / missing fields / unknown
    invitee key. 404 when the conversation does not exist. 409 when the
    invitee is already a member (idempotency contract: re-invite returns
    409 with ``{"invited": false, "reason": "already_member", ...}`` so the
    client can distinguish a fresh invite from a no-op).

    Side effects belong to ``tool_comms_invite`` itself (system message on
    ``claude-comms/conv/general/messages``). This handler is the REST
    surface only.
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    from claude_comms.mcp_tools import tool_comms_invite
    from claude_comms.message import validate_conv_id
    from claude_comms.participant import validate_key

    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    strict = bool(web_cfg.get("strict_cors", True))
    allow_list = _web_cors_allow_list(web_cfg)

    identity_cfg: dict[str, Any] = config.get("identity", {}) or {}
    caller_key_default = identity_cfg.get("key", "")

    def _cors(request: Request) -> dict[str, str]:
        return _cors_headers(
            request,
            allow_list,
            strict=strict,
            methods="POST, OPTIONS",
            extra_headers="Content-Type",
        )

    async def _handler(request: Request) -> JSONResponse:
        try:
            raw_body = await request.json()
        except Exception:
            return JSONResponse(
                {"error": "Request body must be valid JSON"},
                status_code=400,
                headers=_cors(request),
            )
        if not isinstance(raw_body, dict):
            return JSONResponse(
                {"error": "Request body must be a JSON object"},
                status_code=400,
                headers=_cors(request),
            )
        # Validated dict; cast to refine the isinstance-narrowed Unknown dict
        # (see artifact handler note).
        body = cast("dict[str, Any]", raw_body)

        conversation_id = body.get("conversation_id", "")
        invitee_key = body.get("invitee_key", "")
        note = body.get("note", "") or ""

        if not isinstance(conversation_id, str) or not conversation_id:
            return JSONResponse(
                {"error": "Missing required field 'conversation_id'"},
                status_code=400,
                headers=_cors(request),
            )
        if not isinstance(invitee_key, str) or not invitee_key:
            return JSONResponse(
                {"error": "Missing required field 'invitee_key'"},
                status_code=400,
                headers=_cors(request),
            )
        if not isinstance(note, str):
            return JSONResponse(
                {"error": "'note' must be a string"},
                status_code=400,
                headers=_cors(request),
            )
        if not validate_conv_id(conversation_id):
            return JSONResponse(
                {"error": "Invalid conversation_id"},
                status_code=400,
                headers=_cors(request),
            )
        if not validate_key(invitee_key):
            return JSONResponse(
                {
                    "error": (
                        f"Invalid invitee_key format: {invitee_key!r}. "
                        "Must be 8 lowercase hex chars."
                    )
                },
                status_code=400,
                headers=_cors(request),
            )

        registry = registry_provider()
        publish_fn = publish_fn_provider()
        conv_data_dir = conv_data_dir_provider()
        if registry is None or publish_fn is None or conv_data_dir is None:
            return JSONResponse(
                {"error": "Daemon not fully initialised"},
                status_code=503,
                headers=_cors(request),
            )

        # Authorization: the caller (daemon identity) must be a member.
        if not caller_key_default:
            return JSONResponse(
                {"error": "Daemon has no configured identity"},
                status_code=503,
                headers=_cors(request),
            )
        if conversation_id not in registry.conversations_for(caller_key_default):
            return JSONResponse(
                {
                    "error": (
                        f"Caller {caller_key_default!r} is not a member of "
                        f"conversation {conversation_id!r}"
                    )
                },
                status_code=403,
                headers=_cors(request),
            )

        # Resolve invitee key -> name (the MCP tool takes target_name).
        invitee = registry.get(invitee_key)
        if invitee is None:
            return JSONResponse(
                {"error": f"Unknown invitee_key {invitee_key!r}"},
                status_code=400,
                headers=_cors(request),
            )

        result = await tool_comms_invite(
            registry,
            publish_fn,
            key=caller_key_default,
            conversation=conversation_id,
            target_name=invitee.name,
            message=note,
            conv_data_dir=conv_data_dir,
        )

        # Tool error mapping. ``tool_comms_invite`` returns one of:
        #   {"status": "invited"}        -> 200 success
        #   {"status": "already_member"} -> 409 idempotency conflict
        #   _error(msg) with "not found" -> 404
        #   _error(msg) otherwise        -> 400
        if result.get("error"):
            msg = str(result.get("message", "")).lower()
            if "not found" in msg:
                status = 404
            else:
                status = 400
            return JSONResponse(
                {"error": result.get("message", "Invite failed")},
                status_code=status,
                headers=_cors(request),
            )

        if result.get("status") == "already_member":
            return JSONResponse(
                {
                    "invited": False,
                    "reason": "already_member",
                    "invitee_key": invitee_key,
                    "conversation_id": conversation_id,
                },
                status_code=409,
                headers=_cors(request),
            )

        return JSONResponse(
            {
                "invited": True,
                "invitee_key": invitee_key,
                "conversation_id": conversation_id,
            },
            status_code=200,
            headers=_cors(request),
        )

    return Route("/api/invite", _handler, methods=["POST"])


def build_invite_options_route(config: dict[str, Any]) -> Route:
    """OPTIONS preflight for POST /api/invite — matches the POST CORS policy."""
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    strict = bool(web_cfg.get("strict_cors", True))
    allow_list = _web_cors_allow_list(web_cfg)

    async def _handler(request: Request) -> JSONResponse:
        return JSONResponse(
            {},
            headers=_cors_headers(
                request,
                allow_list,
                strict=strict,
                methods="POST, OPTIONS",
                extra_headers="Content-Type",
            ),
        )

    return Route("/api/invite", _handler, methods=["OPTIONS"])


def _version_callback(value: bool) -> None:
    if value:
        from claude_comms import __version__

        typer.echo(f"claude-comms {__version__}")
        raise typer.Exit()


def _update_callback(value: bool) -> None:
    """Eager callback for the top-level ``--update`` convenience flag.

    Runs the same one-shot update as the ``update`` subcommand, then exits.
    ``_run_update`` is defined later in the module; it's resolved at call time,
    so the forward reference is fine.
    """
    if value:
        _run_update(web=True)
        raise typer.Exit()


app = typer.Typer(
    name="claude-comms",
    help="Distributed inter-Claude messaging platform.",
    no_args_is_help=True,
)


@app.callback()
def main(
    _version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="Show version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
    _update: bool = typer.Option(
        False,
        "--update",
        help=(
            "Update a source install (git pull + web build + reinstall-if-needed "
            "+ restart daemon) and exit. Same as the `update` subcommand."
        ),
        callback=_update_callback,
        is_eager=True,
    ),
) -> None:
    """Distributed inter-Claude messaging platform."""
    del _version
    del _update


conv_app = typer.Typer(help="Conversation management commands.")
app.add_typer(conv_app, name="conv")

hook_app = typer.Typer(
    help="PostToolUse notification hook (mid-turn message delivery)."
)
app.add_typer(hook_app, name="hook")


@hook_app.command("install")
def hook_install(
    key: str = typer.Option(
        "",
        "--key",
        help="Participant key to bake into the hook (default: identity key from config).",
    ),
    url: str = typer.Option(
        "http://localhost:9920",
        "--url",
        help=(
            "Base URL of the claude-comms daemon to fetch cues from. Point this "
            "at a REMOTE daemon (e.g. http://daemon-host:9920 or a Tailscale "
            "address) so cross-machine setups deliver messages."
        ),
    ),
) -> None:
    """Install the PostToolUse notification hook into ~/.claude/settings.json.

    The hook is GLOBAL (fires in every Claude Code session on this machine) and is
    baked with ONE participant key — it fetches new messages over HTTP from the
    daemon's `/api/notifications/<key>` endpoint (which drains them server-side)
    and injects them mid-turn. For a REMOTE daemon, pass `--url` so the hook
    pulls cues from the daemon's host instead of expecting a local file. Use the
    key you join the chat with. Run `claude-comms init` first if you have no
    identity key. `claude-comms hook uninstall` removes it.
    """
    from claude_comms.hook_installer import install_hook

    try:
        result = install_hook(participant_key=(key or None), base_url=url)
    except (ValueError, OSError) as exc:
        console.print(f"[red]Hook install failed:[/red] {exc}")
        raise typer.Exit(code=1) from exc
    if result.get("skipped"):
        console.print(f"[yellow]Skipped:[/yellow] {result.get('reason')}")
        return
    console.print(
        f"[green]Hook installed.[/green]\n"
        f"  script:   {result['script_path']}\n"
        f"  settings: {result['settings_path']}\n"
        f"[dim]Global hook — fires in every Claude Code session. "
        f"Run `claude-comms hook uninstall` to remove it.[/dim]"
    )


@hook_app.command("uninstall")
def hook_uninstall(
    key: str = typer.Option(
        "",
        "--key",
        help="Participant key whose hook to remove (default: identity key from config).",
    ),
) -> None:
    """Remove the claude-comms PostToolUse hook from ~/.claude/settings.json."""
    from claude_comms.hook_installer import uninstall_hook

    try:
        result = uninstall_hook(participant_key=(key or None))
    except (ValueError, OSError) as exc:
        console.print(f"[red]Hook uninstall failed:[/red] {exc}")
        raise typer.Exit(code=1) from exc
    console.print(
        f"[green]Hook removed.[/green] "
        f"script_removed={result.get('script_removed')} "
        f"settings_updated={result.get('settings_updated')}"
    )


console = Console()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DATA_DIR = Path.home() / ".claude-comms"
_PID_FILE = _DATA_DIR / "daemon.pid"


def _require_config() -> dict[str, Any]:
    """Load config, exiting with a helpful message if not initialised."""
    config_path = get_config_path()
    if not config_path.exists():
        console.print(
            "[red]Config not found.[/red] Run [bold]claude-comms init[/bold] first."
        )
        raise typer.Exit(1)
    return load_config(config_path)


def _warn_deprecated_cross_origin_config(config: dict[str, Any]) -> None:
    """Emit one-line deprecation warnings for legacy cross-origin config keys.

    Single-origin serving (see single-origin-design.md Phase 4) makes the
    cross-origin knobs below unnecessary. They are DEPRECATED but remain fully
    functional for legacy reverse-proxy deployments; removal is deferred to a
    later pass. Each warning fires once at daemon startup, and ONLY when the
    corresponding key is actually set / non-empty.
    """
    web_cfg: dict[str, Any] = config.get("web", {}) or {}

    if web_cfg.get("api_base"):
        logger.warning(
            "web.api_base is set — single-origin serving makes it unnecessary; "
            "it still works (legacy reverse-proxy mode) but will be removed in a "
            "future release. You can unset it unless you front the daemon with an "
            "external reverse proxy on a different origin."
        )

    if web_cfg.get("ws_url"):
        logger.warning(
            "web.ws_url is set — single-origin serving makes it unnecessary; it "
            "still works (legacy reverse-proxy mode) but will be removed in a "
            "future release. You can unset it unless you front the daemon with an "
            "external reverse proxy on a different origin."
        )

    if web_cfg.get("csp_extra_connect_src"):
        logger.warning(
            "web.csp_extra_connect_src is non-empty — usually unnecessary under "
            "single-origin (connect-src is 'self'); kept functional for legacy "
            "cross-origin deployments and scheduled for removal in a later pass."
        )


def _read_pid() -> int | None:
    """Read the daemon PID file; return PID or None."""
    from claude_comms.broker import EmbeddedBroker

    return EmbeddedBroker.read_pid(_PID_FILE)


def _is_daemon_running() -> bool:
    from claude_comms.broker import EmbeddedBroker

    return EmbeddedBroker.is_daemon_running(_PID_FILE)


@app.command()
def init(
    name: str = typer.Option("", help="Display name for this identity."),
    identity_type: str = typer.Option(
        "human",
        "--type",
        help='Identity type: "human" or "claude".',
    ),
    force: bool = typer.Option(
        False, "--force", "-f", help="Overwrite existing config."
    ),
) -> None:
    """Initialize Claude Comms configuration.

    Generates an identity key, creates ~/.claude-comms/config.yaml with
    sensible defaults, and sets file permissions to 600.
    """
    config_path = get_config_path()

    if config_path.exists() and not force:
        console.print(
            f"[yellow]Config already exists at {config_path}[/yellow]\n"
            "Use --force to overwrite."
        )
        raise typer.Exit(1)

    config = get_default_config()

    if name:
        config["identity"]["name"] = name
    # config already has a default name from get_default_config() (OS username)

    if identity_type in ("human", "claude"):
        config["identity"]["type"] = identity_type
    else:
        console.print(
            f'[red]Invalid identity type "{identity_type}". Must be "human" or "claude".[/red]'
        )
        raise typer.Exit(1)

    # Create logs directory
    logs_dir = Path(config["logging"]["dir"]).expanduser()
    logs_dir.mkdir(parents=True, exist_ok=True)

    saved_path = save_config(config, config_path)

    console.print(f"[green]Config created at {saved_path}[/green]")
    console.print(f"  Identity key: [bold]{config['identity']['key']}[/bold]")
    console.print(f"  Identity type: {config['identity']['type']}")
    console.print(f"  Name: {config['identity']['name']}")
    console.print(
        "\n[dim]Next: set CLAUDE_COMMS_PASSWORD env var or edit "
        f"{saved_path} to configure broker auth.[/dim]"
    )


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------


@app.command()
def start(
    background: bool = typer.Option(
        False, "--background", "-b", help="Run as a background daemon."
    ),
    web: bool = typer.Option(
        False, "--web", "-w", help="Also start the web UI server."
    ),
) -> None:
    """Start the claude-comms daemon (broker + MCP server).

    If broker.mode is "host", starts the embedded MQTT broker.
    Always starts the MCP server.  Optionally starts the web UI server
    when --web is passed or web.enabled is true in config.
    """
    config = _require_config()

    if _is_daemon_running():
        pid = _read_pid()
        console.print(f"[yellow]Daemon is already running (PID {pid}).[/yellow]")
        raise typer.Exit(1)

    broker_mode = config.get("broker", {}).get("mode", "host")
    web_enabled = web or config.get("web", {}).get("enabled", False)
    # FUTURE/CLOUD (NOT PLANNED 2026-06-23, not a TODO): web.host defaults to
    # loopback (secure by default); deployments opt into 0.0.0.0 for a trusted
    # tailnet/LAN. For public hosting you would NOT bind 0.0.0.0 in the open —
    # enforce broker auth (no anonymous MQTT), bind appropriately, and terminate
    # TLS at a load balancer / reverse proxy in front of this origin.
    web_host = config.get("web", {}).get("host", "127.0.0.1")
    web_port = config.get("web", {}).get("port", 9921)
    mcp_host = config.get("mcp", {}).get("host", "127.0.0.1")
    mcp_port = config.get("mcp", {}).get("port", 9920)

    if background:
        # Re-launch ourselves as a detached subprocess
        cmd = [sys.executable, "-m", "claude_comms", "start"]
        if web:
            cmd.append("--web")
        # Do NOT pass --background again — the child runs foreground
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        # Give the child a moment to write its PID file
        time.sleep(1)
        if proc.poll() is not None:
            console.print("[red]Daemon failed to start.[/red]")
            raise typer.Exit(1)
        console.print(f"[green]Daemon started in background (PID {proc.pid}).[/green]")
        return

    # Foreground mode — run the async event loop
    console.print("[bold]Starting claude-comms daemon...[/bold]")

    # Single-origin Phase 4: warn (once, at startup) about any legacy
    # cross-origin config keys that are set. Deprecation-only — the legacy
    # reverse-proxy path stays fully functional; removal is deferred.
    _warn_deprecated_cross_origin_config(config)

    async def _run_daemon() -> None:
        import logging as _logging

        _daemon_logger = _logging.getLogger("claude_comms.cli")

        from claude_comms.broker import EmbeddedBroker

        # Mutable holder so the broker reference survives the
        # ``create_task``/nested-coroutine boundary without ``nonlocal``.
        # Reading ``broker_holder[0]`` in the shutdown ``finally`` stays
        # ``EmbeddedBroker | None`` for the type checker (a plain local would be
        # narrowed to ``None`` and the shutdown body flagged unreachable).
        broker_holder: list[EmbeddedBroker | None] = [None]
        broker_task: asyncio.Task[None] | None = None
        loop = asyncio.get_running_loop()

        # Write PID immediately so `stop` can find us
        _PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        _ = _PID_FILE.write_text(str(os.getpid()), encoding="utf-8")

        shutdown_event = asyncio.Event()

        def _handle_signal() -> None:
            shutdown_event.set()

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, _handle_signal)

        async def _run_broker_with_retry(
            max_retries: int = 10,
        ) -> None:
            """Run the broker in a retry loop to survive transient crashes.

            Known amqtt bug: WebSocket clients that disconnect abruptly
            cause ``struct.error`` / ``ConnectionClosedOK`` exceptions
            that can propagate up and kill the broker.  This wrapper
            catches those, waits 2 seconds, and restarts.
            """
            retries = 0
            while retries < max_retries and not shutdown_event.is_set():
                try:
                    broker = EmbeddedBroker.from_config(config)
                    broker_holder[0] = broker
                    await broker.start()
                    console.print(
                        f"  [green]Broker[/green] listening on "
                        f"tcp://{broker.host}:{broker.port}, "
                        f"ws://{broker.ws_host}:{broker.ws_port}"
                    )
                    # Block until shutdown is requested
                    _ = await shutdown_event.wait()
                    break
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    retries += 1
                    _daemon_logger.error(
                        "Broker crashed (attempt %d/%d): %s", retries, max_retries, e
                    )
                    console.print(
                        f"  [red]Broker crashed[/red] (attempt {retries}/{max_retries}): {e}"
                    )
                    crashed = broker_holder[0]
                    if crashed is not None and crashed.is_running:
                        try:
                            await crashed.stop()
                        except Exception:
                            pass
                        broker_holder[0] = None
                    if retries < max_retries and not shutdown_event.is_set():
                        await asyncio.sleep(2)
                        _daemon_logger.info("Restarting broker...")
                        console.print("  [yellow]Restarting broker...[/yellow]")
                    else:
                        _daemon_logger.error("Broker exceeded max retries, giving up")
                        console.print(
                            "  [red]Broker exceeded max retries, giving up[/red]"
                        )
                        raise

        try:
            # 1) Start embedded broker if we are the host
            if broker_mode == "host":
                broker_task = asyncio.create_task(_run_broker_with_retry())
                # Give the broker a moment to start before proceeding
                await asyncio.sleep(0.5)
            else:
                remote = config.get("broker", {})
                console.print(
                    f"  [cyan]Broker[/cyan] connecting to "
                    f"{remote.get('remote_host', '?')}:{remote.get('remote_port', 1883)}"
                )

            # 2) MCP server
            from claude_comms.mcp_server import (
                create_server as _create_mcp_server,
                _mqtt_subscriber,
            )
            import claude_comms.mcp_server as _mcp_mod

            mcp = _create_mcp_server(config)
            starlette_app = mcp.streamable_http_app()

            # ── REST API: message history for the web UI ──
            from starlette.responses import JSONResponse
            from starlette.routing import Route
            from claude_comms.mcp_server import get_conversation_reactions

            # The remaining mcp_server REST accessors are annotated upstream with
            # bare ``list[dict]`` returns (partially-unknown to basedpyright) in a
            # module outside this file's edit scope. Bind them here with precise
            # callable types so every downstream use is fully typed.
            get_channel_messages: Callable[[str, int], list[dict[str, Any]]] = (
                _mcp_mod.get_channel_messages
            )
            get_channel_participants: Callable[[str], list[dict[str, Any]]] = (
                _mcp_mod.get_channel_participants
            )
            get_conversation_artifacts: Callable[[str], list[dict[str, Any]]] = (
                _mcp_mod.get_conversation_artifacts
            )
            get_artifact: Callable[..., dict[str, Any] | None] = _mcp_mod.get_artifact
            get_all_conversations_full: Callable[..., list[dict[str, Any]]] = (
                _mcp_mod.get_all_conversations_full
            )
            from claude_comms.message import validate_conv_id

            # Allow both localhost and 127.0.0.1, plus common Vite dev ports.
            # In reverse-proxy deployments, ``web.api_base`` is additionally
            # accepted as an origin (this does not weaken loopback/token
            # enforcement on the POST route — that is refused entirely when
            # ``is_reverse_proxy_mode`` is true).
            web_cfg: dict[str, Any] = config.get("web", {}) or {}
            cors_origins = _web_cors_allow_list(web_cfg)
            # R2-3 + R6-4: default to exact-match CORS. ``strict_cors=false``
            # re-enables the legacy (buggy) substring-match path with a
            # deprecation warning on every hit.
            _strict_cors = bool(web_cfg.get("strict_cors", True))

            def _cors(request: Request) -> dict[str, str]:
                return _cors_headers(
                    request,
                    cors_origins,
                    strict=_strict_cors,
                )

            async def _api_messages(request: Request) -> JSONResponse:
                """GET /api/messages/{channel}?count=50 — return recent history."""
                channel = request.path_params["channel"]
                if not validate_conv_id(channel):
                    return JSONResponse(
                        {"error": "Invalid channel ID"},
                        status_code=400,
                    )
                try:
                    count = int(request.query_params.get("count", "50"))
                except (ValueError, TypeError):
                    count = 50
                count = max(1, min(count, 500))
                msgs = get_channel_messages(channel, count)
                return JSONResponse(
                    {"channel": channel, "count": len(msgs), "messages": msgs},
                    headers=_cors(request),
                )

            async def _api_messages_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for CORS."""
                return JSONResponse(
                    {},
                    headers=_cors(request),
                )

            # /api/identity GET + OPTIONS are built by the module-level
            # build_identity_route / build_identity_options_route (extracted
            # for TestClient coverage); _cors is injected at registration.

            async def _api_participants(request: Request) -> JSONResponse:
                """GET /api/participants/{channel} — return participant list."""
                channel = request.path_params["channel"]
                if not validate_conv_id(channel):
                    return JSONResponse(
                        {"error": "Invalid channel ID"},
                        status_code=400,
                    )
                participants = get_channel_participants(channel)
                return JSONResponse(
                    {"version": 2, "channel": channel, "participants": participants},
                    headers=_cors(request),
                )

            async def _api_participants_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for CORS on /api/participants."""
                return JSONResponse(
                    {},
                    headers=_cors(request),
                )

            async def _api_artifacts_list(request: Request) -> JSONResponse:
                """GET /api/artifacts/{conversation} — list artifacts."""
                conversation = request.path_params["conversation"]
                if not validate_conv_id(conversation):
                    return JSONResponse(
                        {"error": "Invalid conversation ID"}, status_code=400
                    )
                artifacts = get_conversation_artifacts(conversation)
                return JSONResponse(
                    {
                        "conversation": conversation,
                        "artifacts": artifacts,
                        "count": len(artifacts),
                    },
                    headers=_cors(request),
                )

            async def _api_artifacts_get(request: Request) -> JSONResponse:
                """GET /api/artifacts/{conversation}/{name}?version=N — get artifact."""
                conversation = request.path_params["conversation"]
                name = request.path_params["name"]
                if not validate_conv_id(conversation):
                    return JSONResponse(
                        {"error": "Invalid conversation ID"}, status_code=400
                    )
                version_param = request.query_params.get("version")
                version = int(version_param) if version_param else None
                artifact = get_artifact(conversation, name, version=version)
                if artifact is None:
                    return JSONResponse(
                        {"error": "Artifact not found"}, status_code=404
                    )
                return JSONResponse(
                    artifact,
                    headers=_cors(request),
                )

            async def _api_artifacts_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for /api/artifacts/{conversation}."""
                return JSONResponse(
                    {},
                    headers=_cors(request),
                )

            async def _api_artifacts_name_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for /api/artifacts/{conversation}/{name}."""
                return JSONResponse(
                    {},
                    headers=_cors(request),
                )

            # /api/conversations GET + OPTIONS are built by the module-level
            # build_conversations_route / build_conversations_options_route
            # (extracted for TestClient coverage); get_all_conversations_full
            # and _cors are injected at registration.

            # ── NEW: capabilities + bearer token + conditional POST edit ──
            # Generate a fresh bearer token for this daemon run (R3-4).
            _web_token = _generate_web_token()
            set_web_token(_web_token)
            _persist_web_token(_web_token)

            # Single-origin Phase 1: assemble the full ordered REST route list
            # ONCE so the SAME Route objects back BOTH the :9920 MCP/REST server
            # and the web port (:9921). The web app reuses ``api_routes``
            # verbatim (see the "3) Web server" block below), so there is one
            # source of truth and the two surfaces can never drift. All the
            # closures/factories below close over the shared module-level
            # singletons (_mcp_mod._registry / _store / _publish_fn etc.), so
            # both apps read/write the same in-process state.
            #
            # Conditional POST /api/artifacts/{conv}/{name}. Returns None when
            # allow_remote_edits is false OR the daemon is in reverse-proxy
            # mode; in those cases we log a one-line warning so the operator
            # can see the feature is intentionally off.
            _post_route = build_artifact_post_route(
                config,
                registry_provider=lambda: _mcp_mod._registry,
                publish_fn_provider=lambda: _mcp_mod._publish_fn,
                data_dir_provider=lambda: _mcp_mod._data_dir,
            )

            api_routes: list[Route] = [
                Route("/api/messages/{channel}", _api_messages, methods=["GET"]),
                Route(
                    "/api/messages/{channel}",
                    _api_messages_options,
                    methods=["OPTIONS"],
                ),
                build_identity_route(config, cors=_cors),
                build_identity_options_route(config, cors=_cors),
                Route(
                    "/api/participants/{channel}", _api_participants, methods=["GET"]
                ),
                Route(
                    "/api/participants/{channel}",
                    _api_participants_options,
                    methods=["OPTIONS"],
                ),
                Route(
                    "/api/artifacts/{conversation}",
                    _api_artifacts_list,
                    methods=["GET"],
                ),
                Route(
                    "/api/artifacts/{conversation}",
                    _api_artifacts_options,
                    methods=["OPTIONS"],
                ),
                Route(
                    "/api/artifacts/{conversation}/{name}",
                    _api_artifacts_get,
                    methods=["GET"],
                ),
                Route(
                    "/api/artifacts/{conversation}/{name}",
                    _api_artifacts_name_options,
                    methods=["OPTIONS"],
                ),
                build_conversations_route(
                    config, get_all_conversations_full, cors=_cors
                ),
                build_conversations_options_route(config, cors=_cors),
                # Reactions hydration: batch who-reacted for a conversation.
                # Same trust boundary as /api/messages (token-free same-origin
                # GET, no broader auth). future: scope to the loaded message-id
                # window for very large conversations (get_all() is whole-conv).
                build_reactions_route(get_conversation_reactions, cors=_cors),
                build_reactions_options_route(cors=_cors),
                # ── v0.4.2 Step 3.4: POST /api/invite + preflight ──
                # Bridges to ``tool_comms_invite`` MCP tool. The provider
                # closures see the live module-level state on every request.
                build_invite_post_route(
                    config,
                    registry_provider=lambda: _mcp_mod._registry,
                    publish_fn_provider=lambda: _mcp_mod._publish_fn,
                    conv_data_dir_provider=lambda: _mcp_mod._conv_data_dir,
                ),
                build_invite_options_route(config),
                # Capabilities (same-origin, no auth, cacheable).
                build_capabilities_route(config),
                # Bearer-token endpoint (loopback-only).
                build_web_token_route(),
                # Notification cue fetch-and-drain (REMOTE hook delivery).
                build_notifications_route(config, cors=_cors),
            ]
            if _post_route is not None:
                api_routes.append(_post_route)
                api_routes.append(build_artifact_post_options_route(config))
                console.print(
                    "  [yellow]Artifact edit-in-place[/yellow] POST route registered"
                    " (allow_remote_edits=true, loopback-only, bearer-token auth)"
                )
            else:
                _daemon_logger.warning(
                    "Reverse-proxy mode OR allow_remote_edits=false: artifact "
                    "edit-in-place disabled."
                )
                console.print(
                    "  [dim]Artifact edit-in-place disabled[/dim] "
                    "(reverse-proxy mode or web.allow_remote_edits=false)"
                )

            # Prepend the REST routes onto the :9920 MCP app so they take
            # priority over the FastMCP catch-all at /mcp. Order is preserved
            # from ``api_routes`` (insert at ascending indices).
            for _idx, _route in enumerate(api_routes):
                starlette_app.routes.insert(_idx, _route)

            # v0.4.1 hotfix: wrap the MCP Starlette app in CORSMiddleware so
            # the browser-side /mcp calls from the web UI on :9921 (which the
            # daemon serves) survive the cross-origin check against :9920
            # (where MCP + REST live). The REST routes above add CORS headers
            # manually via _cors_headers(); /mcp inherited from FastMCP and
            # was missing them entirely. v0.3.3 Step 1.9 added the first
            # browser-side MCP call (SettingsPanel display-name); v0.4.0
            # expanded to most channel-lifecycle operations
            # (joinChannel/leaveChannel/setTopic/archive/delete via mcpCall),
            # making the gap user-facing. Wrap is applied AFTER all
            # `.routes.insert(...)` calls above because CORSMiddleware
            # returns an ASGI callable, not a Starlette instance.
            from starlette.middleware.cors import CORSMiddleware

            starlette_app = CORSMiddleware(
                starlette_app,
                allow_origins=cors_origins,
                allow_methods=["GET", "POST", "OPTIONS"],
                allow_headers=[
                    "Content-Type",
                    "Authorization",
                    "Mcp-Session-Id",
                    "Mcp-Protocol-Version",
                ],
                allow_credentials=False,
            )

            import uvicorn

            mcp_uvi_config = uvicorn.Config(
                starlette_app,
                host=mcp_host,
                port=mcp_port,
                log_level="warning",
            )
            mcp_uvi_server = uvicorn.Server(mcp_uvi_config)
            mcp_task = asyncio.create_task(mcp_uvi_server.serve())

            # Create LogExporter for persisting messages to disk
            from claude_comms.log_exporter import LogExporter

            # LogExporter gets its OWN deduplicator — NOT the shared one.
            # The subscriber deduplicates first (marking IDs as seen),
            # then passes to the exporter. If they share a deduplicator,
            # the exporter sees every message as a duplicate and skips it.
            _log_exporter = LogExporter.from_config(config)
            console.print(
                f"  [green]Log exporter[/green] writing to "
                f"{_log_exporter.log_dir} (format: {_log_exporter.fmt})"
            )

            # Notification cue writer so the PostToolUse hook can push mid-turn
            # messages. Registry global is reassigned during create_server, so
            # resolve it lazily via the provider (NOT captured at construction).
            from claude_comms.notifier import NotificationWriter

            _notifier = NotificationWriter.from_config(
                config, registry_provider=lambda: _mcp_mod._registry
            )

            # Start MQTT subscriber to feed messages into the MCP store + disk
            broker_cfg = config.get("broker", {})
            broker_host = broker_cfg.get("host", "127.0.0.1")
            broker_port = broker_cfg.get("port", 1883)
            assert _mcp_mod._store is not None, "MCP store not initialised"
            assert _mcp_mod._deduplicator is not None, (
                "MCP deduplicator not initialised"
            )
            assert _mcp_mod._registry is not None, "MCP registry not initialised"
            mqtt_sub_task = asyncio.create_task(
                _mqtt_subscriber(
                    broker_host,
                    broker_port,
                    _mcp_mod._store,
                    _mcp_mod._deduplicator,
                    log_exporter=_log_exporter,
                    notifier=_notifier,
                )
            )

            # Create persistent MQTT publish client for MCP tools.
            #
            # Wrapped in a ResilientPublisher: the bare long-lived client used
            # to publish with no timeout and no reconnect handling, so a stalled
            # qos=1 PUBACK (or a silently dropped connection to the embedded
            # broker) made ``await ...publish(...)`` hang forever -> the MCP
            # tool call (comms_send et al.) spun indefinitely and blocked the
            # orchestrator. ResilientPublisher bounds every publish and
            # reconnects+retries once on failure. See publisher.py.
            import aiomqtt
            from claude_comms.broker import generate_client_id
            from claude_comms.publisher import ResilientPublisher

            def _make_pub_client() -> aiomqtt.Client:
                # Fresh client id on every (re)connect avoids broker-side id
                # collisions when the previous connection is being torn down.
                return aiomqtt.Client(
                    hostname=broker_host,
                    port=broker_port,
                    identifier=generate_client_id("mcp-pub", "00000000"),
                )

            _publisher = ResilientPublisher(_make_pub_client)
            await _publisher.start()

            # ``retain`` widening (v0.4.2 Step 3.14) preserved: the
            # profile_status auto-expire + set/clear paths (and the long-standing
            # ``publish_mcp_presence_on_join`` + ``_publish_offline`` callers)
            # reach the broker with the retained-message flag intact. Default
            # False preserves every existing call-site where the kwarg was
            # previously omitted. Signature matches the former ``_do_publish``.
            _do_publish = _publisher.publish

            _mcp_mod._publish_fn = _do_publish

            # Start the presence manager now that the publish function is wired
            if _mcp_mod._presence is not None:
                _mcp_mod._presence.set_publish_fn(_do_publish)
                _mcp_mod._presence.start()
                console.print(
                    "  [green]Presence manager[/green] started (TTL cleanup active)"
                )

            # ── v0.4.2 Step 3.14, Wave A2 re-issue post-§I.18 rename ──
            # Attach the standalone profile_status auto-expire coroutine.
            # Standalone (not piggybacked into PresenceManager) because
            # presence.py is read-only for this step per the brief; piggyback
            # would require modifying ``_sweep_once`` in someone else's
            # source. See worklog §6 for the LOC-based decision basis.
            from claude_comms.mcp_tools import auto_expire_profile_statuses_loop

            _profile_status_expire_task = asyncio.create_task(
                auto_expire_profile_statuses_loop(
                    _mcp_mod._registry,
                    publish_fn_provider=lambda: _mcp_mod._publish_fn,
                )
            )
            # Keep a strong reference so the fire-and-forget task is not
            # garbage-collected mid-run (asyncio holds only a weak ref); the
            # name lives until the enclosing daemon scope exits at shutdown.
            _ = _profile_status_expire_task
            console.print(
                "  [green]Profile-status auto-expire[/green] sweep started (~60s tick)"
            )

            console.print(
                f"  [green]MCP server[/green] ready on http://{mcp_host}:{mcp_port}"
            )

            # 3) Web server
            web_task: asyncio.Task[None] | None = None
            web_uvi_server: uvicorn.Server | None = None
            if web_enabled:
                from starlette.applications import Starlette
                from starlette.middleware import Middleware
                from starlette.middleware.base import BaseHTTPMiddleware
                from starlette.responses import Response, StreamingResponse
                from starlette.routing import Mount
                from starlette.staticfiles import StaticFiles

                # Locate web/dist inside the installed package.
                # `importlib.resources.files()` is zip-safe and survives every
                # install layout (pip, pipx, editable, frozen). The wheel ships
                # ``claude_comms/web/dist/`` baked in (see hatch_build.py).
                import importlib.resources

                _web_dist = importlib.resources.files("claude_comms").joinpath(
                    "web", "dist"
                )

                # R3-3 + R1-8: CSP header + optional meta injection for
                # reverse-proxy deployments. Wraps StaticFiles output with
                # security headers; rewrites the HTML payload when it's
                # index.html and ``web.api_base`` is set.
                _security_headers_snapshot = security_headers(config)
                _meta_api_base: str = web_cfg.get("api_base") or ""

                class _StaticHardeningMiddleware(BaseHTTPMiddleware):
                    async def dispatch(
                        self,
                        request: Request,
                        call_next: Callable[[Request], Awaitable[Response]],
                    ) -> Response:
                        response = await call_next(request)
                        # Apply security headers to every response from the
                        # static file server.
                        for hname, hval in _security_headers_snapshot.items():
                            response.headers[hname] = hval
                        # If this is the index document AND a meta api_base
                        # injection is configured, rewrite the body.
                        ctype = response.headers.get("content-type", "")
                        if (
                            _meta_api_base
                            and ctype.startswith("text/html")
                            and isinstance(response, StreamingResponse)
                        ):
                            body = b""
                            async for chunk in response.body_iterator:
                                # StaticFiles streams ``bytes``; the ``str``
                                # branch is a type-safety fallback matching
                                # Starlette's default utf-8 body encoding, and
                                # ``memoryview``/buffer chunks are coerced too.
                                if isinstance(chunk, str):
                                    body += chunk.encode("utf-8")
                                else:
                                    body += bytes(chunk)
                            try:
                                html = body.decode("utf-8")
                            except UnicodeDecodeError:
                                return Response(
                                    content=body,
                                    status_code=response.status_code,
                                    headers=dict(response.headers),
                                )
                            rewritten = inject_api_base_meta(
                                html, _meta_api_base
                            ).encode("utf-8")
                            new_headers = dict(response.headers)
                            new_headers["content-length"] = str(len(rewritten))
                            return Response(
                                content=rewritten,
                                status_code=response.status_code,
                                headers=new_headers,
                                media_type=ctype,
                            )
                        return response

                if _web_dist.is_dir():
                    # Single-origin Phase 1: co-mount the full REST surface
                    # (the SAME ``api_routes`` Route objects that back :9920)
                    # plus the FastMCP streamable-HTTP handler at /mcp onto the
                    # web port, so the web origin serves SPA + REST + MCP from
                    # one port. The :9920 server stays up unchanged for compat
                    # (existing ``claude mcp add ... :9920/mcp`` registrations
                    # keep working).
                    #
                    # /mcp is registered as a ``Route("/mcp", endpoint=...)``
                    # wrapping the SAME ``StreamableHTTPASGIApp`` /
                    # ``_session_manager`` that the :9920 app uses — NOT a
                    # ``Mount("/mcp", app=mcp.streamable_http_app())``. A Mount
                    # would strip the ``/mcp`` prefix and re-add FastMCP's own
                    # internal ``/mcp`` route, making the real path ``/mcp/mcp``
                    # (clients POST to ``/mcp`` → 404/405). A Route at the exact
                    # path mirrors FastMCP's own wiring (streamable_http_app
                    # registers ``Route(streamable_http_path, streamable_app)``)
                    # so ``/mcp`` resolves correctly.
                    #
                    # FastMCP is stateless_http and its session manager is
                    # started exactly ONCE by the :9920 app's lifespan
                    # (``streamable_http_app()`` caches ``_session_manager`` on
                    # first call, so the second call for the web port reuses
                    # it). The web app has no MCP lifespan of its own (Starlette
                    # does not run a sub-app's lifespan, and a Route carries no
                    # lifespan), so there is no double-start; the web /mcp
                    # dispatches into the already-running shared manager.
                    #
                    # ORDERING IS CRITICAL: the /api/* Routes and the /mcp
                    # Route MUST precede the static /assets mount and the ``/``
                    # StaticFiles(html=True) catch-all, or the SPA fallback
                    # would swallow /api and /mcp requests.
                    #
                    # ── FUTURE / CLOUD NOTE (NOT a TODO, NOT PLANNED as of
                    #    2026-06-23) ──
                    # Single-origin serving also makes cloud/public hosting
                    # straightforward later: put the daemon behind one TLS
                    # domain on a load balancer / reverse proxy and CSP 'self'
                    # works the same as localhost — no per-host config.
                    # If you ever expand to public/cloud, the TRUST MODEL must
                    # change (today it assumes a trusted tailnet/loopback):
                    #   1. enforce broker auth (no anonymous);
                    #   2. replace the loopback-based write/admin gate with
                    #      identity-based authz;
                    #   3. add real per-user login + per-user identity (today
                    #      the web UI adopts the daemon's single identity);
                    #   4. for HA/scale swap the embedded amqtt broker + SQLite
                    #      for an external broker (EMQX/Mosquitto) + shared DB.
                    # None of this is needed for personal/tailnet use.
                    from mcp.server.fastmcp.server import StreamableHTTPASGIApp

                    # First call cached the session manager; reuse it so the
                    # web-port handler shares the running task group.
                    _mcp_session_mgr = mcp.session_manager
                    web_app = Starlette(
                        routes=[
                            *api_routes,
                            Route(
                                "/mcp",
                                endpoint=StreamableHTTPASGIApp(_mcp_session_mgr),
                            ),
                            # Single-origin Phase 2: bridge the embedded broker
                            # at /mqtt on the web port via amqtt's public
                            # external_connected. ``broker_holder[0]`` is the
                            # live EmbeddedBroker (None while mid-restart →
                            # endpoint closes the WS with 1013). Registered
                            # BEFORE the static catch-all so the SPA fallback
                            # cannot swallow it.
                            build_mqtt_ws_route(lambda: broker_holder[0]),
                            Mount(
                                "/assets",
                                app=StaticFiles(directory=str(_web_dist / "assets")),
                                name="assets",
                            ),
                            Mount(
                                "/",
                                app=StaticFiles(directory=str(_web_dist), html=True),
                                name="root",
                            ),
                        ],
                        middleware=[Middleware(_StaticHardeningMiddleware)],
                    )
                    web_uvi_config = uvicorn.Config(
                        web_app,
                        host=web_host,
                        port=web_port,
                        log_level="warning",
                    )
                    web_uvi_server = uvicorn.Server(web_uvi_config)
                    web_task = asyncio.create_task(web_uvi_server.serve())
                    _local_url, _external_url = _web_ui_urls(config)
                    console.print(f"  [green]Web UI[/green] available at {_local_url}")
                    if _external_url and _external_url != _local_url:
                        console.print(
                            f"  [green]Web UI[/green] (external) at {_external_url}"
                        )
                else:
                    console.print(
                        f"  [yellow]Web UI[/yellow] dist not found at {_web_dist} — skipping"
                    )

            console.print(
                "[bold green]Daemon running. Press Ctrl+C to stop.[/bold green]"
            )

            # Block until signalled
            _ = await shutdown_event.wait()

            # Graceful shutdown — suppress uvicorn's noisy CancelledError logs
            import logging as _logging

            _logging.getLogger("uvicorn.error").setLevel(_logging.CRITICAL)
            _logging.getLogger("uvicorn").setLevel(_logging.CRITICAL)

            mcp_uvi_server.should_exit = True
            # Flush last_activity timestamps before shutting down
            if (
                _mcp_mod._activity_tracker is not None
                and _mcp_mod._conv_data_dir is not None
            ):
                _mcp_mod._activity_tracker.flush_all(_mcp_mod._conv_data_dir)
            # Flush offline presence for all active connections, then stop the sweep.
            # Done BEFORE cancelling the MQTT subscriber so offline messages are observed.
            if _mcp_mod._presence is not None:
                try:
                    await _mcp_mod._presence.flush_all_offline()
                except Exception:
                    _daemon_logger.exception("Failed to flush offline presence")
                try:
                    await _mcp_mod._presence.stop()
                except Exception:
                    _daemon_logger.exception("Failed to stop presence manager")
            _ = mqtt_sub_task.cancel()
            await _publisher.stop()
            if web_task is not None and web_uvi_server is not None:
                web_uvi_server.should_exit = True
            # Wait for tasks to finish (broker_task unblocks via shutdown_event)
            for t in [mcp_task, mqtt_sub_task, web_task, broker_task]:
                if t is not None:
                    try:
                        await t
                    except (asyncio.CancelledError, Exception):
                        pass

        finally:
            console.print("\n[bold]Shutting down...[/bold]")
            # The broker is created inside the ``_run_broker_with_retry`` task
            # and stored in ``broker_holder`` so its reference survives the
            # nested-coroutine boundary for both the runtime and the type
            # checker. Stop it here if it is still running.
            broker = broker_holder[0]
            if broker is not None and broker.is_running:
                await broker.stop()
            # Remove PID file
            try:
                _PID_FILE.unlink(missing_ok=True)
            except OSError:
                pass
            console.print("[green]Daemon stopped.[/green]")

    try:
        asyncio.run(_run_daemon())
    except KeyboardInterrupt:
        pass  # already handled by signal handler


# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------


@app.command()
def stop() -> None:
    """Stop the running claude-comms daemon.

    Reads the PID file, sends SIGTERM, and waits up to 10 seconds for
    graceful shutdown before sending SIGKILL.
    """
    pid = _read_pid()
    if pid is None:
        console.print("[yellow]No daemon running.[/yellow]")
        raise typer.Exit(0)  # Exit 0 so && chains continue

    # Check process exists
    try:
        os.kill(pid, 0)
    except OSError:
        console.print(
            f"[yellow]PID {pid} is not running (stale PID file). Cleaning up.[/yellow]"
        )
        _PID_FILE.unlink(missing_ok=True)
        return

    console.print(f"Sending SIGTERM to daemon (PID {pid})...")
    os.kill(pid, signal.SIGTERM)

    # Wait for graceful shutdown (up to 10 seconds)
    timeout = 10
    for _ in range(timeout * 10):
        try:
            os.kill(pid, 0)
        except OSError:
            # Process is gone
            console.print("[green]Daemon stopped.[/green]")
            _PID_FILE.unlink(missing_ok=True)
            return
        time.sleep(0.1)

    # Still alive — force kill
    console.print(f"[red]Daemon did not stop after {timeout}s. Sending SIGKILL.[/red]")
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    _PID_FILE.unlink(missing_ok=True)
    console.print("[green]Daemon killed.[/green]")


# ---------------------------------------------------------------------------
# update — one-shot self-update for source / editable installs
# ---------------------------------------------------------------------------


class _UpdateStepError(RuntimeError):
    """A subprocess step in ``claude-comms update`` failed.

    Carries the command, return code, and captured stdout/stderr so the command
    can surface a clear, actionable error and abort the sequence on first
    failure.
    """

    def __init__(
        self, cmd: list[str], returncode: int, stdout: str, stderr: str
    ) -> None:
        self.cmd: list[str] = cmd
        self.returncode: int = returncode
        self.stdout: str = stdout
        self.stderr: str = stderr
        super().__init__(
            f"Command {' '.join(cmd)!r} failed with exit code {returncode}"
        )


def _find_source_repo_root(start: Path | None = None) -> Path | None:
    """Return the source-checkout root, or ``None`` for a non-git (wheel) install.

    Resolves the installed ``claude_comms`` package location and walks UP looking
    for a directory that contains BOTH ``.git`` and ``pyproject.toml`` (the
    source / editable-install checkout). A plain PyPI/wheel install lives in
    site-packages with no such ancestor, so this returns ``None`` — the signal
    ``update`` uses to refuse a git pull and point the user at ``pip install -U``.
    """
    if start is None:
        import claude_comms

        start = Path(claude_comms.__file__).resolve()
    for parent in (start, *start.parents):
        if (parent / ".git").exists() and (parent / "pyproject.toml").is_file():
            return parent
    return None


def _pyproject_project_version(repo_root: Path) -> str | None:
    """Parse ``[project] version`` from ``pyproject.toml``.

    Hand-rolled rather than ``tomllib`` because ``requires-python >= 3.10`` and
    ``tomllib`` only landed in 3.11. Only reads the ``version`` key inside the
    ``[project]`` table.
    """
    try:
        text = (repo_root / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return None
    in_project = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            in_project = line == "[project]"
            continue
        if in_project:
            m = re.match(r"""version\s*=\s*["']([^"']+)["']""", line)
            if m:
                return m.group(1)
    return None


def _installed_package_version() -> str | None:
    """Return the installed ``claude-comms`` metadata version, or ``None``."""
    from importlib.metadata import PackageNotFoundError
    from importlib.metadata import version as _meta_version

    try:
        return _meta_version("claude-comms")
    except PackageNotFoundError:
        return None


def _select_web_package_manager(
    web_dir: Path, which: Callable[[str], str | None] = shutil.which
) -> tuple[str, list[str], list[str]] | None:
    """Pick the JS package manager for rebuilding the web UI.

    Prefers ``pnpm`` (the repo ships ``pnpm-lock.yaml`` and the hatch build hook
    uses it): ``pnpm install --frozen-lockfile`` + ``pnpm build``. Falls back to
    ``npm`` when pnpm is absent — ``npm ci`` when a ``package-lock.json`` exists,
    else ``npm install`` (``npm ci`` requires a lockfile) — + ``npm run build``.
    Returns ``(name, install_cmd, build_cmd)``, or ``None`` when neither manager
    is on PATH. ``which`` is injectable for testing.
    """
    if which("pnpm"):
        return (
            "pnpm",
            ["pnpm", "install", "--frozen-lockfile"],
            ["pnpm", "build"],
        )
    if which("npm"):
        install_cmd = (
            ["npm", "ci"]
            if (web_dir / "package-lock.json").is_file()
            else ["npm", "install"]
        )
        return ("npm", install_cmd, ["npm", "run", "build"])
    return None


def _should_reinstall(
    old_version: str | None,
    new_version: str | None,
    pyproject_changed: bool,
) -> bool:
    """Decide whether an editable reinstall is needed after the pull.

    Reinstall when ``pyproject.toml`` changed in the pull (deps/metadata may have
    moved), when either version is unknown (be safe), or when the post-pull
    source version differs from the installed metadata version — the classic
    "metadata stuck at the old version" case this command exists to fix. An
    editable reinstall is cheap and idempotent, so erring toward reinstall is
    the robust choice.
    """
    if pyproject_changed:
        return True
    if old_version is None or new_version is None:
        return True
    return old_version != new_version


def _run_subprocess_step(
    cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Run a subprocess step capturing output; raise ``_UpdateStepError`` on failure."""
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise _UpdateStepError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


def _git_rev(repo_root: Path) -> str | None:
    """Return ``git rev-parse HEAD`` for ``repo_root``, or ``None`` on failure."""
    try:
        proc = _run_subprocess_step(["git", "rev-parse", "HEAD"], cwd=repo_root)
    except _UpdateStepError:
        return None
    return proc.stdout.strip()


def _git_changed_files(repo_root: Path, old_rev: str, new_rev: str) -> list[str]:
    """Return the files changed between two revs (empty if same / on error)."""
    if not old_rev or not new_rev or old_rev == new_rev:
        return []
    try:
        proc = _run_subprocess_step(
            ["git", "diff", "--name-only", old_rev, new_rev], cwd=repo_root
        )
    except _UpdateStepError:
        return []
    return [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]


def _run_update(web: bool = True) -> None:
    """Shared implementation for ``claude-comms update`` / ``--update``.

    Steps, aborting on the first failure: (1) locate the source checkout,
    (2) ``git pull --ff-only``, (3) rebuild the web UI, (4) reinstall the
    package when needed, then LAST (5) restart the daemon and (6) verify.
    Build/install run BEFORE the daemon is stopped, so a failed build leaves the
    running daemon untouched.
    """
    console.print("[bold]claude-comms update[/bold]\n")

    # ── 1. Locate the source checkout ─────────────────────────────────────
    repo_root = _find_source_repo_root()
    if repo_root is None:
        console.print(
            "[red]Not a source/editable install.[/red] This looks like a "
            "PyPI/wheel install (no .git checkout found above the package).\n"
            "Run [bold]pip install -U claude-comms[/bold] to update from PyPI."
        )
        raise typer.Exit(1)
    console.print(f"[green]✓[/green] Source checkout: {repo_root}")

    old_version = _installed_package_version()

    # ── 2. git pull --ff-only ─────────────────────────────────────────────
    old_rev = _git_rev(repo_root)
    console.print("[bold]→ git pull --ff-only[/bold]")
    try:
        pull = _run_subprocess_step(["git", "pull", "--ff-only"], cwd=repo_root)
    except _UpdateStepError as exc:
        console.print(
            "[red]git pull failed.[/red] The working tree may be dirty or the "
            "branch is not fast-forwardable. Resolve it and re-run."
        )
        if exc.stderr.strip():
            console.print(f"[dim]{exc.stderr.strip()}[/dim]")
        raise typer.Exit(1) from exc
    pull_msg = pull.stdout.strip() or pull.stderr.strip()
    if pull_msg:
        console.print(f"[dim]{pull_msg}[/dim]")
    new_rev = _git_rev(repo_root)

    changed = _git_changed_files(repo_root, old_rev or "", new_rev or "")
    pyproject_changed = "pyproject.toml" in changed
    new_version = _pyproject_project_version(repo_root)

    # ── 3. Rebuild the web UI ─────────────────────────────────────────────
    web_dir = repo_root / "web"
    pm = _select_web_package_manager(web_dir)
    if pm is None:
        console.print(
            "[red]No JS package manager found.[/red] Install pnpm (preferred) "
            "or npm to rebuild the web UI, then re-run."
        )
        raise typer.Exit(1)
    pm_name, install_cmd, build_cmd = pm
    env = os.environ.copy()
    env["CI"] = "true"
    console.print(f"[bold]→ Rebuild web UI ({pm_name})[/bold]")
    for step_cmd in (install_cmd, build_cmd):
        console.print(f"[dim]  $ {' '.join(step_cmd)}[/dim]")
        try:
            _run_subprocess_step(step_cmd, cwd=web_dir, env=env)
        except _UpdateStepError as exc:
            console.print(f"[red]Web build step failed:[/red] {' '.join(step_cmd)}")
            if exc.stderr.strip():
                console.print(f"[dim]{exc.stderr.strip()[-2000:]}[/dim]")
            console.print(
                "[yellow]Daemon left untouched (build failed before restart).[/yellow]"
            )
            raise typer.Exit(1) from exc
    console.print("[green]✓[/green] Web UI rebuilt")

    # ── 4. Reinstall if needed (metadata / version / deps) ────────────────
    if _should_reinstall(old_version, new_version, pyproject_changed):
        reason = (
            "pyproject.toml changed"
            if pyproject_changed
            else f"version {old_version} → {new_version}"
        )
        console.print(f"[bold]→ Reinstall editable package[/bold] ({reason})")
        reinstall_cmd = [sys.executable, "-m", "pip", "install", "-e", ".[all]"]
        console.print(f"[dim]  $ {' '.join(reinstall_cmd)}[/dim]")
        try:
            _run_subprocess_step(reinstall_cmd, cwd=repo_root, env=env)
        except _UpdateStepError as exc:
            console.print("[red]pip reinstall failed.[/red]")
            if exc.stderr.strip():
                console.print(f"[dim]{exc.stderr.strip()[-2000:]}[/dim]")
            console.print(
                "[yellow]Daemon left untouched (reinstall failed before "
                "restart).[/yellow]"
            )
            raise typer.Exit(1) from exc
        console.print("[green]✓[/green] Package reinstalled")
    else:
        console.print(
            "[dim]Skipping reinstall (version + pyproject.toml unchanged).[/dim]"
        )

    # ── 5. Restart the daemon (LAST, so a failed build never takes it down) ─
    console.print("[bold]→ Restart daemon (background, web UI)[/bold]")
    try:
        stop()
    except typer.Exit:
        # ``stop`` exits 0 when nothing is running — fine, we're about to start.
        pass
    try:
        start(background=True, web=web)
    except typer.Exit as exc:
        console.print(
            "[red]Daemon failed to restart.[/red] Run "
            "[bold]claude-comms start --web -b[/bold] manually."
        )
        raise typer.Exit(1) from exc

    # ── 6. Verify + report ────────────────────────────────────────────────
    running = _is_daemon_running()
    health = (
        f"[green]daemon up[/green] (PID {_read_pid()})"
        if running
        else "[red]daemon not detected[/red]"
    )
    shown_new = new_version or old_version or "unknown"
    console.print(
        f"\n[bold green]Updated to v{shown_new}, daemon restarted.[/bold green] "
        f"{health}"
    )
    if old_version and new_version and old_version != new_version:
        console.print(f"[dim]version: {old_version} → {new_version}[/dim]")
    if not running:
        raise typer.Exit(1)


@app.command()
def update(
    web: bool = typer.Option(
        True, "--web/--no-web", help="Restart with the web UI (default: yes)."
    ),
) -> None:
    """Update a source/editable install and redeploy in one shot.

    Pulls the latest source (``git pull --ff-only``), rebuilds the web UI,
    reinstalls the package when the version or ``pyproject.toml`` changed, then
    restarts the daemon (backgrounded, with the web UI). Refuses to run on a
    plain PyPI/wheel install — use ``pip install -U claude-comms`` there.
    """
    _run_update(web=web)


# ---------------------------------------------------------------------------
# send
# ---------------------------------------------------------------------------


@app.command()
def send(
    message: str = typer.Argument(..., help="Message body to send."),
    conversation: str = typer.Option(
        "",
        "-c",
        "--conversation",
        help="Target conversation (default from config).",
    ),
    to: str | None = typer.Option(
        None,
        "-t",
        "--to",
        help="Recipient name or key (for targeted messages).",
    ),
) -> None:
    """Send a quick message as the configured identity.

    Uses identity.key/name/type from config.yaml.  Sends to the default
    conversation unless -c is specified.  Auto-joins the conversation
    via a presence publish if not already a member.
    """
    config = _require_config()

    identity = config.get("identity", {})
    sender_key = identity.get("key", "")
    sender_name = identity.get("name", "") or f"user-{sender_key}"
    sender_type = identity.get("type", "human")

    if not sender_key:
        console.print(
            "[red]No identity key in config. Run [bold]claude-comms init[/bold].[/red]"
        )
        raise typer.Exit(1)

    if not _is_daemon_running():
        console.print(
            "[red]Daemon is not running.[/red] Start it with "
            "[bold]claude-comms start[/bold]."
        )
        raise typer.Exit(1)

    conv = conversation or config.get("default_conversation", "general")

    # Build recipients list
    recipients: list[str] | None = None
    if to:
        # Strip leading @ if present
        cleaned = to.lstrip("@")
        recipients = [cleaned]

    # Publish via a short-lived MQTT client
    from claude_comms.message import Message

    msg = Message.create(
        sender_key=sender_key,
        sender_name=sender_name,
        sender_type=sender_type,
        body=message,
        conv=conv,
        recipients=recipients,
    )

    broker_cfg = config.get("broker", {})
    host = broker_cfg.get("host", "127.0.0.1")
    port = broker_cfg.get("port", 1883)
    auth = broker_cfg.get("auth", {})

    async def _publish() -> None:
        import aiomqtt  # type: ignore[import-untyped]

        client_kwargs: dict[str, Any] = {
            "hostname": host,
            "port": port,
        }
        if auth.get("enabled") and auth.get("username") and auth.get("password"):
            client_kwargs["username"] = auth["username"]
            client_kwargs["password"] = auth["password"]

        async with aiomqtt.Client(**client_kwargs) as client:
            await client.publish(
                msg.topic,
                payload=msg.to_mqtt_payload().encode(),
                qos=1,
            )

    try:
        asyncio.run(_publish())
    except Exception as exc:
        console.print(f"[red]Failed to send message: {exc}[/red]")
        raise typer.Exit(1)

    target = f"[bold]{conv}[/bold]"
    if recipients:
        target += f" (to {', '.join(recipients)})"
    console.print(f"[green]Message sent to {target}.[/green]")


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------


def _doctor_emit(passed: bool, check: str, detail: str, fix: str | None = None) -> None:
    """Print one doctor check line: ``✓/✗ <check> — <detail> [Fix: <cmd>]``."""
    mark = "[green]✓[/green]" if passed else "[red]✗[/red]"
    line = f"{mark} {check} — {detail}"
    if not passed and fix:
        line += f" [yellow][Fix: {fix}][/yellow]"
    console.print(line)


def _port_owner(port: int) -> str | None:
    """Best-effort: return a short description of who owns ``:port``.

    Tries ``ss`` then ``lsof``; returns ``None`` if nothing is listening or no
    tool is available. Used only for human-readable diagnostics.
    """
    for cmd in (
        ["ss", "-tlnpH"],
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
    ):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        except (FileNotFoundError, subprocess.SubprocessError):
            continue
        for raw in out.splitlines():
            if (
                f":{port} " in raw
                or f":{port}\t" in raw
                or raw.rstrip().endswith(f":{port}")
            ):
                return raw.strip()[:120]
    return None


def _doctor_can_bind(port: int, host: str = "127.0.0.1") -> bool:
    """Return True if ``host:port`` can be bound (i.e. nothing is listening)."""
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


@app.command()
def doctor() -> None:
    """Self-check: print PASS/FAIL per check with an actionable fix.

    The in-CLI mirror of the web "Connection diagnostics" panel. Verifies the
    single-origin serving contract end-to-end: config + identity, the daemon,
    the web origin, and that REST, MCP, and the broker WebSocket are all
    reachable same-origin on the web port, plus the broker TCP socket, port
    conflicts, and CSP sanity. Exits non-zero if any critical check fails.
    """
    import urllib.error
    import urllib.request

    console.print("[bold]claude-comms doctor[/bold]\n")

    critical_failed = False

    # ── 1. Config present + parseable + identity key set ──────────────────
    config: dict[str, Any] | None = None
    config_path = get_config_path()
    if not config_path.exists():
        _doctor_emit(
            False, "Config", f"not found at {config_path}", "claude-comms init"
        )
        critical_failed = True
    else:
        try:
            config = load_config(config_path)
        except Exception as exc:
            _doctor_emit(
                False,
                "Config",
                f"failed to parse {config_path}: {exc}",
                "claude-comms init",
            )
            critical_failed = True
        else:
            identity: dict[str, Any] = config.get("identity", {}) or {}
            key = identity.get("key")
            if key:
                _doctor_emit(
                    True,
                    "Config",
                    f"loaded; identity {identity.get('name', '(unnamed)')} key={key}",
                )
            else:
                _doctor_emit(
                    False,
                    "Config",
                    "loaded but identity key is not set",
                    "claude-comms init",
                )
                critical_failed = True

    if config is None:
        # Nothing further can be probed without config.
        console.print("\n[red]Critical checks failed.[/red]")
        raise typer.Exit(1)

    web_cfg: dict[str, Any] = config.get("web", {}) or {}
    mcp_cfg: dict[str, Any] = config.get("mcp", {}) or {}
    broker_cfg: dict[str, Any] = config.get("broker", {}) or {}
    web_host = web_cfg.get("host", "127.0.0.1")
    web_port = web_cfg.get("port", 9921)
    # The probe must use a connectable host: a bind-all 0.0.0.0 means "reachable
    # on every interface", so probe via loopback.
    probe_host = "127.0.0.1" if web_host in ("0.0.0.0", "::", "") else web_host
    web_origin = f"http://{probe_host}:{web_port}"

    # ── 2. Daemon running ─────────────────────────────────────────────────
    daemon_running = _is_daemon_running()
    if daemon_running:
        _doctor_emit(True, "Daemon", f"running (PID {_read_pid()})")
    else:
        _doctor_emit(False, "Daemon", "not running", "claude-comms start --web")
        critical_failed = True

    def _http_get(url: str, timeout: float = 3.0) -> tuple[int, bytes]:
        """Return (status, body); status 0 on connection failure."""
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, b""
        except Exception:
            return 0, b""

    def _http_post(
        url: str, payload: dict[str, Any], timeout: float = 3.0
    ) -> tuple[int, bytes]:
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode(),
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, b""
        except Exception:
            return 0, b""

    # ── 3. Web origin reachable ───────────────────────────────────────────
    if web_cfg.get("enabled", False):
        status_code, _ = _http_get(f"{web_origin}/")
        if status_code == 200:
            _doctor_emit(True, "Web origin", f"GET {web_origin}/ → 200")
        else:
            _doctor_emit(
                False,
                "Web origin",
                f"GET {web_origin}/ → {status_code or 'no response'}",
                "claude-comms start --web",
            )
            critical_failed = True
    else:
        _doctor_emit(
            False,
            "Web origin",
            "web UI disabled in config (web.enabled=false)",
            "set web.enabled: true then claude-comms start --web",
        )
        critical_failed = True

    # ── 4. REST same-origin ───────────────────────────────────────────────
    status_code, body = _http_get(f"{web_origin}/api/capabilities")
    rest_ok = False
    if status_code == 200:
        try:
            json.loads(body)
            rest_ok = True
        except Exception:
            rest_ok = False
    if rest_ok:
        _doctor_emit(
            True,
            "REST same-origin",
            f"GET {web_origin}/api/capabilities → 200 JSON",
        )
    else:
        _doctor_emit(
            False,
            "REST same-origin",
            f"GET {web_origin}/api/capabilities → {status_code or 'no response'}",
            "ensure daemon started with --web (Phase 1 co-mount)",
        )
        critical_failed = True

    # ── 5. MCP same-origin ────────────────────────────────────────────────
    mcp_payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "claude-comms-doctor", "version": "1"},
        },
    }
    status_code, _ = _http_post(f"{web_origin}/mcp", mcp_payload)
    if status_code == 200:
        _doctor_emit(True, "MCP same-origin", f"POST {web_origin}/mcp → 200")
    else:
        _doctor_emit(
            False,
            "MCP same-origin",
            f"POST {web_origin}/mcp → {status_code or 'no response'}",
            "ensure daemon started with --web (Phase 1 co-mount)",
        )
        critical_failed = True

    # ── 6. Broker WS same-origin (/mqtt) ──────────────────────────────────
    async def _probe_ws() -> tuple[bool, str]:
        """Open a WS to <web_origin>/mqtt (subprotocol mqtt) + send CONNECT.

        Returns (ok, detail). ``ok`` means we got a CONNACK byte back.
        """
        try:
            import websockets
            from websockets import Subprotocol
        except Exception:
            return False, "websockets lib unavailable"
        ws_url = f"ws://{probe_host}:{web_port}/mqtt"
        # Minimal MQTT 3.1.1 CONNECT packet (clean session, keepalive 60s).
        client_id = b"cc-doctor"
        var_header = (
            b"\x00\x04MQTT"  # protocol name
            b"\x04"  # protocol level 4 (3.1.1)
            b"\x02"  # connect flags: clean session
            b"\x00\x3c"  # keepalive 60s
        )
        payload = len(client_id).to_bytes(2, "big") + client_id
        body = var_header + payload
        connect = b"\x10" + len(body).to_bytes(1, "big") + body
        try:
            async with websockets.connect(
                ws_url,
                subprotocols=[Subprotocol("mqtt")],
                open_timeout=3,
                close_timeout=2,
            ) as ws:
                await ws.send(connect)
                resp = await asyncio.wait_for(ws.recv(), timeout=3)
                if isinstance(resp, (bytes, bytearray)) and resp[:1] == b"\x20":
                    return True, "CONNACK received"
                return False, "no CONNACK (unexpected response)"
        except Exception as exc:
            return False, f"{type(exc).__name__}: {exc}"

    try:
        ws_ok, ws_detail = asyncio.run(_probe_ws())
    except Exception as exc:
        ws_ok, ws_detail = False, str(exc)
    ws_target = f"ws://{probe_host}:{web_port}/mqtt"
    if ws_ok:
        _doctor_emit(True, "Broker WS same-origin", f"{ws_target} — {ws_detail}")
    else:
        _doctor_emit(
            False,
            "Broker WS same-origin",
            f"{ws_target} — {ws_detail}",
            "broker not started / Phase 2 /mqtt bridge missing",
        )
        critical_failed = True

    # ── 7. Broker TCP ─────────────────────────────────────────────────────
    broker_host = broker_cfg.get("host", "127.0.0.1")
    broker_port = broker_cfg.get("port", 1883)
    broker_probe_host = (
        "127.0.0.1" if broker_host in ("0.0.0.0", "::", "") else broker_host
    )
    auth: dict[str, Any] = broker_cfg.get("auth", {}) or {}

    async def _probe_tcp() -> bool:
        try:
            import aiomqtt  # type: ignore[import-untyped]

            kw: dict[str, Any] = {"hostname": broker_probe_host, "port": broker_port}
            if auth.get("enabled") and auth.get("username") and auth.get("password"):
                kw["username"] = auth["username"]
                kw["password"] = auth["password"]
            async with aiomqtt.Client(**kw):
                return True
        except Exception:
            return False

    try:
        tcp_ok = asyncio.run(_probe_tcp())
    except Exception:
        tcp_ok = False
    if tcp_ok:
        _doctor_emit(True, "Broker TCP", f"connected {broker_probe_host}:{broker_port}")
    else:
        _doctor_emit(
            False,
            "Broker TCP",
            f"cannot connect {broker_probe_host}:{broker_port}",
            "broker crashed — check daemon log (claude-comms log)",
        )
        critical_failed = True

    # ── 8. Port conflicts ─────────────────────────────────────────────────
    # When the daemon is running, these ports SHOULD be busy (owned by us); a
    # conflict only matters when the daemon is NOT running but a port is taken.
    ws_port_cfg = broker_cfg.get("ws_port", 9001)
    mcp_port_cfg = mcp_cfg.get("port", 9920)
    port_specs = [
        ("web", web_port),
        ("mcp", mcp_port_cfg),
        ("broker TCP", broker_port),
        ("broker WS (:9001)", ws_port_cfg),
    ]
    if daemon_running:
        _doctor_emit(
            True,
            "Port conflicts",
            "daemon running — ports owned by claude-comms (skipped bind-test)",
        )
    else:
        conflicts: list[str] = []
        for label, port in port_specs:
            if not _doctor_can_bind(port):
                owner = _port_owner(port)
                conflicts.append(
                    f"{label} :{port} busy" + (f" ({owner})" if owner else "")
                )
        if conflicts:
            _doctor_emit(
                False,
                "Port conflicts",
                "; ".join(conflicts),
                "stop the conflicting process or change ports in config",
            )
            critical_failed = True
        else:
            _doctor_emit(True, "Port conflicts", "all configured ports are free")

    # ── 9. CSP sanity ─────────────────────────────────────────────────────
    csp = build_csp(config)
    connect_src = ""
    for directive in csp.split(";"):
        directive = directive.strip()
        if directive.startswith("connect-src"):
            connect_src = directive[len("connect-src") :].strip()
            break
    tokens = [t for t in connect_src.split() if t]
    extra_tokens = [t for t in tokens if t != "'self'"]
    if not extra_tokens:
        shown = connect_src or "'self'"
        _doctor_emit(True, "CSP sanity", f"connect-src {shown}")
    else:
        _doctor_emit(
            False,
            "CSP sanity",
            f"connect-src has non-'self' entries: {' '.join(extra_tokens)}",
            "remove web.api_base / web.csp_extra_connect_src for single-origin",
        )
        # CSP drift is a warning, not a hard failure — do not flip critical.

    console.print()
    if critical_failed:
        console.print("[red]One or more critical checks failed.[/red]")
        raise typer.Exit(1)
    console.print("[green]All checks passed.[/green]")


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


@app.command()
def status() -> None:
    """Show daemon status, broker connectivity, and configuration summary."""
    config = _require_config()

    daemon_running = _is_daemon_running()
    pid = _read_pid()

    # Daemon status
    if daemon_running:
        console.print(f"[green]Daemon:[/green] running (PID {pid})")
    else:
        console.print("[red]Daemon:[/red] not running")
        if pid is not None:
            console.print(f"  [dim](stale PID file references PID {pid})[/dim]")

    # Broker config
    broker_cfg = config.get("broker", {})
    mode = broker_cfg.get("mode", "host")
    if mode == "host":
        console.print(
            f"[cyan]Broker:[/cyan] embedded (host) on "
            f"{broker_cfg.get('host', '127.0.0.1')}:{broker_cfg.get('port', 1883)}"
        )
    else:
        console.print(
            f"[cyan]Broker:[/cyan] remote at "
            f"{broker_cfg.get('remote_host', '?')}:{broker_cfg.get('remote_port', 1883)}"
        )

    # MCP config
    mcp_cfg = config.get("mcp", {})
    console.print(
        f"[cyan]MCP:[/cyan] http://{mcp_cfg.get('host', '127.0.0.1')}"
        f":{mcp_cfg.get('port', 9920)}"
    )

    # Web config
    web_cfg = config.get("web", {})
    web_on = web_cfg.get("enabled", False)
    if web_on:
        local_url, external_url = _web_ui_urls(config)
        console.print(f"[cyan]Web UI:[/cyan] {local_url}")
        if external_url and external_url != local_url:
            console.print(f"[cyan]Web UI (external):[/cyan] {external_url}")
    else:
        console.print(
            f"[cyan]Web UI:[/cyan] disabled (port {web_cfg.get('port', 9921)})"
        )

    # Identity
    identity = config.get("identity", {})
    console.print(
        f"[cyan]Identity:[/cyan] {identity.get('name', '(unnamed)')} "
        f"({identity.get('type', '?')}) key={identity.get('key', '?')}"
    )

    # Default conversation
    console.print(
        f"[cyan]Default conversation:[/cyan] {config.get('default_conversation', 'general')}"
    )

    # Broker connectivity probe + participant count (only if daemon running)
    if daemon_running:
        host = broker_cfg.get("host", "127.0.0.1")
        port = broker_cfg.get("port", 1883)
        auth = broker_cfg.get("auth", {})

        async def _probe() -> tuple[bool, int]:
            """Return (connected, participant_count)."""
            participant_count = 0
            try:
                import aiomqtt  # type: ignore[import-untyped]

                kw: dict[str, Any] = {"hostname": host, "port": port}
                if (
                    auth.get("enabled")
                    and auth.get("username")
                    and auth.get("password")
                ):
                    kw["username"] = auth["username"]
                    kw["password"] = auth["password"]
                async with aiomqtt.Client(**kw) as _client:
                    # Try to get participant count from the REST API
                    try:
                        import urllib.request

                        mcp_host_val = mcp_cfg.get("host", "127.0.0.1")
                        mcp_port_val = mcp_cfg.get("port", 9920)
                        default_conv = config.get("default_conversation", "general")
                        url = f"http://{mcp_host_val}:{mcp_port_val}/api/participants/{default_conv}"
                        with urllib.request.urlopen(url, timeout=2) as resp:
                            data = json.loads(resp.read())
                            participant_count = len(data.get("participants", []))
                    except Exception:
                        pass
                    return True, participant_count
            except Exception:
                return False, 0

        try:
            connected, participant_count = asyncio.run(_probe())
        except Exception:
            connected = False
            participant_count = 0

        if connected:
            console.print("[green]Broker connectivity:[/green] OK")
        else:
            console.print("[red]Broker connectivity:[/red] FAILED")

        if participant_count > 0:
            console.print(f"[cyan]Participants:[/cyan] {participant_count} online")
        else:
            console.print("[cyan]Participants:[/cyan] 0 (or registry unavailable)")


# ---------------------------------------------------------------------------
# tui
# ---------------------------------------------------------------------------


@app.command()
def tui() -> None:
    """Launch the Textual TUI chat client."""
    _ = _require_config()

    if not _is_daemon_running():
        console.print(
            "[red]Daemon is not running.[/red] Start it with "
            "[bold]claude-comms start[/bold]."
        )
        raise typer.Exit(1)

    try:
        from claude_comms.tui.app import ClaudeCommsApp  # type: ignore[import-not-found]

        app_instance = ClaudeCommsApp()
        _ = app_instance.run()
    except ImportError:
        console.print(
            "[red]TUI module not available.[/red] Ensure the TUI package is installed."
        )
        raise typer.Exit(1)


# ---------------------------------------------------------------------------
# web
# ---------------------------------------------------------------------------


@app.command()
def web() -> None:
    """Open the web UI in the default browser."""
    config = _require_config()

    web_host = config.get("web", {}).get("host", "127.0.0.1")
    web_port = config.get("web", {}).get("port", 9921)
    url = f"http://{web_host}:{web_port}"

    if not _is_daemon_running():
        console.print(
            "[yellow]Warning: daemon is not running. The web UI may not work.[/yellow]"
        )

    console.print(f"Opening [bold]{url}[/bold] in your browser...")
    _ = webbrowser.open(url)


# ---------------------------------------------------------------------------
# log
# ---------------------------------------------------------------------------


@app.command()
def log(
    conversation: str = typer.Option(
        "",
        "-c",
        "--conversation",
        help="Conversation to tail (default from config).",
    ),
) -> None:
    """Tail a conversation log file in real-time."""
    config = _require_config()

    conv = conversation or config.get("default_conversation", "general")
    log_dir = Path(
        config.get("logging", {}).get("dir", "~/.claude-comms/logs")
    ).expanduser()
    log_file = log_dir / f"{conv}.log"

    if not log_file.exists():
        console.print(
            f"[yellow]Log file not found: {log_file}[/yellow]\n"
            f"No messages have been logged for conversation [bold]{conv}[/bold] yet."
        )
        raise typer.Exit(1)

    console.print(f"[dim]Tailing {log_file} (Ctrl+C to stop)...[/dim]\n")

    try:
        # Use tail -f for real-time following
        _ = subprocess.run(["tail", "-f", str(log_file)])
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped tailing.[/dim]")
    except FileNotFoundError:
        # tail not available — fallback to Python polling
        try:
            with open(log_file) as fh:
                # Seek to end
                _ = fh.seek(0, 2)
                while True:
                    line = fh.readline()
                    if line:
                        console.print(line, end="")
                    else:
                        time.sleep(0.3)
        except KeyboardInterrupt:
            console.print("\n[dim]Stopped tailing.[/dim]")


# ---------------------------------------------------------------------------
# conv subcommands
# ---------------------------------------------------------------------------


@conv_app.command("list")
def conv_list() -> None:
    """List all known conversations (from log files and config)."""
    config = _require_config()

    log_dir = Path(
        config.get("logging", {}).get("dir", "~/.claude-comms/logs")
    ).expanduser()
    auto_join = config.get("mcp", {}).get("auto_join", [])

    conversations: set[str] = set(auto_join)

    # Discover from log files
    if log_dir.is_dir():
        for f in log_dir.iterdir():
            if f.suffix == ".log" and f.stem:
                conversations.add(f.stem)
            elif f.suffix == ".jsonl" and f.stem:
                conversations.add(f.stem)

    if not conversations:
        console.print("[dim]No conversations found.[/dim]")
        return

    table = Table(title="Conversations")
    table.add_column("Name", style="bold")
    table.add_column("Log", style="dim")

    for name in sorted(conversations):
        log_exists = (log_dir / f"{name}.log").exists()
        table.add_row(name, "yes" if log_exists else "no")

    console.print(table)


@conv_app.command("create")
def conv_create(
    name: str = typer.Argument(..., help="Conversation name to create."),
) -> None:
    """Create a new conversation.

    Publishes conversation metadata to the MQTT broker so other
    participants can discover it.
    """
    from claude_comms.message import validate_conv_id

    config = _require_config()

    if not validate_conv_id(name):
        console.print(
            f"[red]Invalid conversation name:[/red] {name!r}\n"
            "Must be lowercase alphanumeric + hyphens, 1-64 chars, "
            "no leading/trailing hyphens."
        )
        raise typer.Exit(1)

    if not _is_daemon_running():
        console.print(
            "[red]Daemon is not running.[/red] Start it with "
            "[bold]claude-comms start[/bold]."
        )
        raise typer.Exit(1)

    broker_cfg = config.get("broker", {})
    host = broker_cfg.get("host", "127.0.0.1")
    port = broker_cfg.get("port", 1883)
    auth = broker_cfg.get("auth", {})
    identity = config.get("identity", {})

    meta = {
        "conv_id": name,
        "created_by": identity.get("key", ""),
        "created_at": __import__("datetime")
        .datetime.now(__import__("datetime").timezone.utc)
        .astimezone()
        .isoformat(),
        "topic": None,
    }

    async def _publish_meta() -> None:
        import aiomqtt  # type: ignore[import-untyped]

        kw: dict[str, Any] = {"hostname": host, "port": port}
        if auth.get("enabled") and auth.get("username") and auth.get("password"):
            kw["username"] = auth["username"]
            kw["password"] = auth["password"]

        async with aiomqtt.Client(**kw) as client:
            await client.publish(
                f"claude-comms/conv/{name}/meta",
                payload=json.dumps(meta).encode(),
                qos=1,
                retain=True,
            )

    try:
        asyncio.run(_publish_meta())
    except Exception as exc:
        console.print(f"[red]Failed to create conversation: {exc}[/red]")
        raise typer.Exit(1)

    console.print(f"[green]Conversation [bold]{name}[/bold] created.[/green]")


@conv_app.command("delete")
def conv_delete(
    name: str = typer.Argument(..., help="Conversation name to delete."),
    force: bool = typer.Option(
        False, "--force", "-f", help="Skip confirmation prompt."
    ),
) -> None:
    """Delete a conversation (clears retained metadata from broker)."""
    from claude_comms.message import validate_conv_id

    config = _require_config()

    if not validate_conv_id(name):
        console.print(f"[red]Invalid conversation name:[/red] {name!r}")
        raise typer.Exit(1)

    if not force:
        confirm = typer.confirm(
            f"Delete conversation '{name}'? This clears its broker metadata."
        )
        if not confirm:
            console.print("[dim]Aborted.[/dim]")
            return

    if not _is_daemon_running():
        console.print(
            "[red]Daemon is not running.[/red] Start it with "
            "[bold]claude-comms start[/bold]."
        )
        raise typer.Exit(1)

    broker_cfg = config.get("broker", {})
    host = broker_cfg.get("host", "127.0.0.1")
    port = broker_cfg.get("port", 1883)
    auth = broker_cfg.get("auth", {})

    async def _clear_meta() -> None:
        import aiomqtt  # type: ignore[import-untyped]

        kw: dict[str, Any] = {"hostname": host, "port": port}
        if auth.get("enabled") and auth.get("username") and auth.get("password"):
            kw["username"] = auth["username"]
            kw["password"] = auth["password"]

        async with aiomqtt.Client(**kw) as client:
            # Publish empty retained message to clear the topic
            await client.publish(
                f"claude-comms/conv/{name}/meta",
                payload=b"",
                qos=1,
                retain=True,
            )

    try:
        asyncio.run(_clear_meta())
    except Exception as exc:
        console.print(f"[red]Failed to delete conversation: {exc}[/red]")
        raise typer.Exit(1)

    console.print(f"[green]Conversation [bold]{name}[/bold] deleted.[/green]")
