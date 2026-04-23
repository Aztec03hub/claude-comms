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
import signal
import stat
import subprocess
import sys
import time
import warnings
import webbrowser
from pathlib import Path
from typing import Any, Optional

import typer
from rich.console import Console
from rich.table import Table

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
        path.write_text(token, encoding="utf-8")
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
    _WEB_TOKEN = token


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


def _resolve_cors_origin_legacy(
    request: Any, allow_list: list[str]
) -> str | None:
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


def build_csp(config: dict) -> str:
    """Construct a Content-Security-Policy header value from config.

    ``connect-src`` is derived dynamically from ``web.api_base`` (if set)
    plus the daemon's MCP / broker ports. ``web.csp_extra_connect_src``
    is merged in as a rollback escape hatch.
    """
    web_cfg = config.get("web", {}) or {}
    api_base = web_cfg.get("api_base")
    mcp_port = config.get("mcp", {}).get("port", 9920)
    ws_port = config.get("broker", {}).get("ws_port", 9001)

    api_origin = api_base or f"http://127.0.0.1:{mcp_port}"

    ws_url = web_cfg.get("ws_url")
    if ws_url:
        ws_origin = ws_url
    elif api_base:
        # Replace only the scheme prefix, not any 'http' substring elsewhere.
        if api_origin.startswith("https://"):
            ws_origin = "wss://" + api_origin[len("https://"):] + "/mqtt"
        elif api_origin.startswith("http://"):
            ws_origin = "ws://" + api_origin[len("http://"):] + "/mqtt"
        else:
            ws_origin = f"ws://127.0.0.1:{ws_port}"
    else:
        ws_origin = f"ws://127.0.0.1:{ws_port}"

    extra = " ".join(web_cfg.get("csp_extra_connect_src") or [])
    connect_src = f"'self' {api_origin} {ws_origin}".strip()
    if extra:
        connect_src = f"{connect_src} {extra}"
    return (
        f"default-src 'self'; "
        f"script-src 'self'; "
        f"style-src 'self' 'unsafe-inline'; "
        f"img-src 'self' data:; "
        f"connect-src {connect_src}; "
        f"frame-ancestors 'none'; "
        f"base-uri 'self'; "
        f"form-action 'self'"
    )


def security_headers(config: dict) -> dict[str, str]:
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


def build_capabilities_route(config: dict):
    """GET /api/capabilities — same-origin, no auth, cacheable 60s.

    Returns a Starlette ``Route`` describing the deployment's writable status
    and feature flags so the UI can gate its Edit button without relying on
    failed POST responses (R3-2 fix).
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def _handler(request):  # type: ignore[no-untyped-def]
        web_cfg = config.get("web", {}) or {}
        allow_remote_edits = bool(web_cfg.get("allow_remote_edits", False))
        writable = allow_remote_edits and not is_reverse_proxy_mode(config)
        payload = {
            "writable": writable,
            "features": {
                "markdown_render": bool(
                    web_cfg.get("markdown_render_enabled", True)
                ),
                "diff_view": True,
                "legacy_codeblock": bool(
                    web_cfg.get("use_legacy_codeblock_highlighter", False)
                ),
            },
        }
        return JSONResponse(
            payload,
            headers={"Cache-Control": "max-age=60"},
        )

    return Route("/api/capabilities", _handler, methods=["GET"])


def build_web_token_route():
    """GET /api/web-token — loopback-only. Returns the in-memory bearer token.

    R3-4 fix. Non-loopback requests are rejected with 403. ``X-Forwarded-For``
    is never consulted.
    """
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def _handler(request):  # type: ignore[no-untyped-def]
        if not _is_loopback(request):
            return JSONResponse(
                {"error": "loopback only"}, status_code=403
            )
        token = get_web_token()
        if token is None:
            return JSONResponse(
                {"error": "Bearer token not initialised"}, status_code=503
            )
        return JSONResponse({"token": token})

    return Route("/api/web-token", _handler, methods=["GET"])


def build_artifact_post_route(
    config: dict,
    *,
    registry_provider,
    publish_fn_provider,
    data_dir_provider,
):
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
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    web_cfg = config.get("web", {}) or {}
    allow_remote_edits = bool(web_cfg.get("allow_remote_edits", False))
    if not allow_remote_edits or is_reverse_proxy_mode(config):
        return None

    from claude_comms.mcp_tools import tool_comms_artifact_update
    from claude_comms.message import validate_conv_id

    async def _handler(request: Request) -> JSONResponse:
        # Defense 1: loopback only. X-Forwarded-For is NEVER consulted.
        if not _is_loopback(request):
            return JSONResponse(
                {"error": "loopback only"}, status_code=403
            )

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
            return JSONResponse(
                {"error": _SESSION_EXPIRED_MSG}, status_code=401
            )

        # Parse + validate path params.
        conversation = request.path_params.get("conversation", "")
        name = request.path_params.get("name", "")
        if not validate_conv_id(conversation):
            return JSONResponse(
                {"error": "Invalid conversation ID"}, status_code=400
            )

        try:
            body = await request.json()
        except Exception:
            return JSONResponse(
                {"error": "Request body must be valid JSON"},
                status_code=400,
            )
        if not isinstance(body, dict):
            return JSONResponse(
                {"error": "Request body must be a JSON object"},
                status_code=400,
            )

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


def build_artifact_post_options_route(config: dict):
    """OPTIONS preflight for POST /api/artifacts/{conv}/{name}.

    Registered alongside the POST route. Uses the same CORS policy as the
    other endpoints but advertises POST + Authorization.
    """
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    web_cfg = config.get("web", {}) or {}
    strict = bool(web_cfg.get("strict_cors", True))
    web_port = web_cfg.get("port", 9921)
    allow_list = [
        f"http://localhost:{web_port}",
        f"http://127.0.0.1:{web_port}",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]
    api_base = web_cfg.get("api_base")
    if api_base:
        allow_list.append(api_base)

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


def _version_callback(value: bool) -> None:
    if value:
        from claude_comms import __version__

        typer.echo(f"claude-comms {__version__}")
        raise typer.Exit()


app = typer.Typer(
    name="claude-comms",
    help="Distributed inter-Claude messaging platform.",
    no_args_is_help=True,
)


@app.callback()
def _main(
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="Show version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """Distributed inter-Claude messaging platform."""


conv_app = typer.Typer(help="Conversation management commands.")
app.add_typer(conv_app, name="conv")

console = Console()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DATA_DIR = Path.home() / ".claude-comms"
_PID_FILE = _DATA_DIR / "daemon.pid"
_LOG_DIR = _DATA_DIR / "logs"


def _require_config() -> dict[str, Any]:
    """Load config, exiting with a helpful message if not initialised."""
    config_path = get_config_path()
    if not config_path.exists():
        console.print(
            "[red]Config not found.[/red] Run [bold]claude-comms init[/bold] first."
        )
        raise typer.Exit(1)
    return load_config(config_path)


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

    async def _run_daemon() -> None:
        import logging as _logging

        _daemon_logger = _logging.getLogger("claude_comms.cli")

        from claude_comms.broker import EmbeddedBroker

        broker_instance: EmbeddedBroker | None = None
        broker_task: asyncio.Task | None = None
        loop = asyncio.get_running_loop()

        # Write PID immediately so `stop` can find us
        _PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        _PID_FILE.write_text(str(os.getpid()), encoding="utf-8")

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
            nonlocal broker_instance
            retries = 0
            while retries < max_retries and not shutdown_event.is_set():
                try:
                    broker_instance = EmbeddedBroker.from_config(config)
                    await broker_instance.start()
                    console.print(
                        f"  [green]Broker[/green] listening on "
                        f"tcp://{broker_instance.host}:{broker_instance.port}, "
                        f"ws://{broker_instance.ws_host}:{broker_instance.ws_port}"
                    )
                    # Block until shutdown is requested
                    await shutdown_event.wait()
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
                    if broker_instance is not None and broker_instance.is_running:
                        try:
                            await broker_instance.stop()
                        except Exception:
                            pass
                        broker_instance = None
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
            from starlette.requests import Request
            from starlette.responses import JSONResponse
            from starlette.routing import Route
            from claude_comms.mcp_server import (
                get_channel_messages,
                get_channel_participants,
                get_conversation_artifacts,
                get_artifact,
                get_all_conversations,
            )
            from claude_comms.message import validate_conv_id

            # Allow both localhost and 127.0.0.1, plus common Vite dev ports.
            # In reverse-proxy deployments, ``web.api_base`` is additionally
            # accepted as an origin (this does not weaken loopback/token
            # enforcement on the POST route — that is refused entirely when
            # ``is_reverse_proxy_mode`` is true).
            web_cfg = config.get("web", {}) or {}
            cors_origins = [
                f"http://localhost:{web_port}",
                f"http://127.0.0.1:{web_port}",
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "http://localhost:5174",
                "http://127.0.0.1:5174",
            ]
            _api_base_origin = web_cfg.get("api_base")
            if _api_base_origin:
                cors_origins.append(_api_base_origin)
            # R2-3 + R6-4: default to exact-match CORS. ``strict_cors=false``
            # re-enables the legacy (buggy) substring-match path with a
            # deprecation warning on every hit.
            _strict_cors = bool(web_cfg.get("strict_cors", True))

            def _cors(request: Request) -> dict[str, str]:
                return _cors_headers(
                    request, cors_origins, strict=_strict_cors,
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

            async def _api_identity(request: Request) -> JSONResponse:
                """GET /api/identity — return the daemon's configured identity."""
                identity = config.get("identity", {})
                return JSONResponse(
                    {
                        "key": identity.get("key", ""),
                        "name": identity.get("name", ""),
                        "type": identity.get("type", "human"),
                    },
                    headers=_cors(request),
                )

            async def _api_identity_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for CORS on /api/identity."""
                return JSONResponse(
                    {},
                    headers=_cors(request),
                )

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
                    return JSONResponse({"error": "Invalid conversation ID"}, status_code=400)
                artifacts = get_conversation_artifacts(conversation)
                return JSONResponse(
                    {"conversation": conversation, "artifacts": artifacts, "count": len(artifacts)},
                    headers=_cors(request),
                )

            async def _api_artifacts_get(request: Request) -> JSONResponse:
                """GET /api/artifacts/{conversation}/{name}?version=N — get artifact."""
                conversation = request.path_params["conversation"]
                name = request.path_params["name"]
                if not validate_conv_id(conversation):
                    return JSONResponse({"error": "Invalid conversation ID"}, status_code=400)
                version_param = request.query_params.get("version")
                version = int(version_param) if version_param else None
                artifact = get_artifact(conversation, name, version=version)
                if artifact is None:
                    return JSONResponse({"error": "Artifact not found"}, status_code=404)
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

            async def _api_conversations(request: Request) -> JSONResponse:
                """GET /api/conversations?all=true — list conversations."""
                all_param = request.query_params.get("all", "false").lower() in ("true", "1", "yes")
                # Get identity key for "joined" status
                identity = config.get("identity", {})
                identity_key = identity.get("key", "")
                if all_param:
                    conversations = get_all_conversations(key=identity_key)
                else:
                    conversations = get_all_conversations(key=identity_key)  # REST always returns all for now
                return JSONResponse(
                    {"conversations": conversations, "count": len(conversations)},
                    headers=_cors(request),
                )

            async def _api_conversations_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for /api/conversations."""
                return JSONResponse(
                    {},
                    headers=_cors(request),
                )

            # Prepend API routes so they take priority over MCP catch-all
            starlette_app.routes.insert(
                0, Route("/api/messages/{channel}", _api_messages, methods=["GET"])
            )
            starlette_app.routes.insert(
                1,
                Route(
                    "/api/messages/{channel}",
                    _api_messages_options,
                    methods=["OPTIONS"],
                ),
            )
            starlette_app.routes.insert(
                2, Route("/api/identity", _api_identity, methods=["GET"])
            )
            starlette_app.routes.insert(
                3, Route("/api/identity", _api_identity_options, methods=["OPTIONS"])
            )
            starlette_app.routes.insert(
                4,
                Route(
                    "/api/participants/{channel}", _api_participants, methods=["GET"]
                ),
            )
            starlette_app.routes.insert(
                5,
                Route(
                    "/api/participants/{channel}",
                    _api_participants_options,
                    methods=["OPTIONS"],
                ),
            )
            starlette_app.routes.insert(
                6, Route("/api/artifacts/{conversation}", _api_artifacts_list, methods=["GET"])
            )
            starlette_app.routes.insert(
                7, Route("/api/artifacts/{conversation}", _api_artifacts_options, methods=["OPTIONS"])
            )
            starlette_app.routes.insert(
                8, Route("/api/artifacts/{conversation}/{name}", _api_artifacts_get, methods=["GET"])
            )
            starlette_app.routes.insert(
                9, Route("/api/artifacts/{conversation}/{name}", _api_artifacts_name_options, methods=["OPTIONS"])
            )
            starlette_app.routes.insert(
                10, Route("/api/conversations", _api_conversations, methods=["GET"])
            )
            starlette_app.routes.insert(
                11, Route("/api/conversations", _api_conversations_options, methods=["OPTIONS"])
            )

            # ── NEW: capabilities + bearer token + conditional POST edit ──
            # Generate a fresh bearer token for this daemon run (R3-4).
            _web_token = _generate_web_token()
            set_web_token(_web_token)
            _persist_web_token(_web_token)

            # Capabilities (same-origin, no auth, cacheable).
            starlette_app.routes.insert(12, build_capabilities_route(config))
            # Bearer-token endpoint (loopback-only).
            starlette_app.routes.insert(13, build_web_token_route())

            # Conditional POST /api/artifacts/{conv}/{name}. Returns None
            # when allow_remote_edits is false OR the daemon is in
            # reverse-proxy mode; in those cases we log a one-line warning
            # so the operator can see the feature is intentionally off.
            _post_route = build_artifact_post_route(
                config,
                registry_provider=lambda: _mcp_mod._registry,
                publish_fn_provider=lambda: _mcp_mod._publish_fn,
                data_dir_provider=lambda: _mcp_mod._data_dir,
            )
            if _post_route is not None:
                starlette_app.routes.insert(14, _post_route)
                starlette_app.routes.insert(
                    15, build_artifact_post_options_route(config)
                )
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

            # Start MQTT subscriber to feed messages into the MCP store + disk
            broker_cfg = config.get("broker", {})
            broker_host = broker_cfg.get("host", "127.0.0.1")
            broker_port = broker_cfg.get("port", 1883)
            assert _mcp_mod._store is not None, "MCP store not initialised"
            assert _mcp_mod._deduplicator is not None, (
                "MCP deduplicator not initialised"
            )
            mqtt_sub_task = asyncio.create_task(
                _mqtt_subscriber(
                    broker_host,
                    broker_port,
                    _mcp_mod._store,
                    _mcp_mod._deduplicator,
                    log_exporter=_log_exporter,
                )
            )

            # Create persistent MQTT publish client for MCP tools
            import aiomqtt
            from claude_comms.broker import generate_client_id

            pub_client_id = generate_client_id("mcp-pub", "00000000")
            pub_client = aiomqtt.Client(
                hostname=broker_host,
                port=broker_port,
                identifier=pub_client_id,
            )
            await pub_client.__aenter__()

            async def _do_publish(topic: str, payload: bytes) -> None:
                await pub_client.publish(topic, payload, qos=1)

            _mcp_mod._publish_fn = _do_publish

            # Start the presence manager now that the publish function is wired
            if _mcp_mod._presence is not None:
                _mcp_mod._presence.set_publish_fn(_do_publish)
                _mcp_mod._presence.start()
                console.print("  [green]Presence manager[/green] started (TTL cleanup active)")

            console.print(
                f"  [green]MCP server[/green] ready on http://{mcp_host}:{mcp_port}"
            )

            # 3) Web server
            web_task: asyncio.Task | None = None
            web_uvi_server: uvicorn.Server | None = None
            if web_enabled:
                from starlette.applications import Starlette
                from starlette.middleware import Middleware
                from starlette.middleware.base import BaseHTTPMiddleware
                from starlette.responses import Response
                from starlette.routing import Mount
                from starlette.staticfiles import StaticFiles

                # Locate web/dist relative to the package
                _pkg_dir = Path(__file__).resolve().parent
                _web_dist = (_pkg_dir / "../../web/dist").resolve()

                # R3-3 + R1-8: CSP header + optional meta injection for
                # reverse-proxy deployments. Wraps StaticFiles output with
                # security headers; rewrites the HTML payload when it's
                # index.html and ``web.api_base`` is set.
                _security_headers_snapshot = security_headers(config)
                _meta_api_base = (config.get("web", {}) or {}).get("api_base") or ""

                class _StaticHardeningMiddleware(BaseHTTPMiddleware):
                    async def dispatch(self, request, call_next):  # type: ignore[no-untyped-def]
                        response = await call_next(request)
                        # Apply security headers to every response from the
                        # static file server.
                        for hname, hval in _security_headers_snapshot.items():
                            response.headers[hname] = hval
                        # If this is the index document AND a meta api_base
                        # injection is configured, rewrite the body.
                        ctype = response.headers.get("content-type", "")
                        if _meta_api_base and ctype.startswith("text/html"):
                            body = b""
                            async for chunk in response.body_iterator:
                                body += chunk
                            try:
                                html = body.decode("utf-8")
                            except UnicodeDecodeError:
                                return Response(
                                    content=body,
                                    status_code=response.status_code,
                                    headers=dict(response.headers),
                                )
                            rewritten = inject_api_base_meta(html, _meta_api_base).encode("utf-8")
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
                    web_app = Starlette(
                        routes=[
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
                    console.print(
                        f"  [green]Web UI[/green] available at "
                        f"http://{web_host}:{web_port}"
                    )
                else:
                    console.print(
                        f"  [yellow]Web UI[/yellow] dist not found at {_web_dist} — skipping"
                    )

            console.print(
                "[bold green]Daemon running. Press Ctrl+C to stop.[/bold green]"
            )

            # Block until signalled
            await shutdown_event.wait()

            # Graceful shutdown — suppress uvicorn's noisy CancelledError logs
            import logging as _logging

            _logging.getLogger("uvicorn.error").setLevel(_logging.CRITICAL)
            _logging.getLogger("uvicorn").setLevel(_logging.CRITICAL)

            mcp_uvi_server.should_exit = True
            # Flush last_activity timestamps before shutting down
            if _mcp_mod._activity_tracker is not None and _mcp_mod._conv_data_dir is not None:
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
            mqtt_sub_task.cancel()
            await pub_client.__aexit__(None, None, None)
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
            if broker_instance is not None and broker_instance.is_running:
                await broker_instance.stop()
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
    to: Optional[str] = typer.Option(
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

        client_kwargs: dict = {
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
    console.print(
        f"[cyan]Web UI:[/cyan] {'enabled' if web_on else 'disabled'}"
        f" (port {web_cfg.get('port', 9921)})"
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

                kw: dict = {"hostname": host, "port": port}
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
    _require_config()

    if not _is_daemon_running():
        console.print(
            "[red]Daemon is not running.[/red] Start it with "
            "[bold]claude-comms start[/bold]."
        )
        raise typer.Exit(1)

    try:
        from claude_comms.tui.app import ClaudeCommsApp  # type: ignore[import-not-found]

        app_instance = ClaudeCommsApp()
        app_instance.run()
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
    webbrowser.open(url)


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
        subprocess.run(["tail", "-f", str(log_file)])
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped tailing.[/dim]")
    except FileNotFoundError:
        # tail not available — fallback to Python polling
        try:
            with open(log_file) as fh:
                # Seek to end
                fh.seek(0, 2)
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

        kw: dict = {"hostname": host, "port": port}
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

        kw: dict = {"hostname": host, "port": port}
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
