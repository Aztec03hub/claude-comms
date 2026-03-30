"""CLI interface for Claude Comms.

Provides the main Typer app, conversation sub-group, and all top-level
commands: init, start, stop, send, status, tui, web, log.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any, Optional

import typer
from rich.console import Console
from rich.table import Table

from claude_comms.config import (
    get_config_path,
    get_default_config,
    load_config,
    save_config,
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
            )
            from claude_comms.message import validate_conv_id

            # Allow both localhost and 127.0.0.1, plus common Vite dev ports
            cors_origins = [
                f"http://localhost:{web_port}",
                f"http://127.0.0.1:{web_port}",
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "http://localhost:5174",
                "http://127.0.0.1:5174",
            ]

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
                    headers={
                        "Access-Control-Allow-Origin": next((o for o in cors_origins if o in request.headers.get("origin", "")), cors_origins[0]),
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
                )

            async def _api_messages_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for CORS."""
                return JSONResponse(
                    {},
                    headers={
                        "Access-Control-Allow-Origin": next((o for o in cors_origins if o in request.headers.get("origin", "")), cors_origins[0]),
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
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
                    headers={
                        "Access-Control-Allow-Origin": next((o for o in cors_origins if o in request.headers.get("origin", "")), cors_origins[0]),
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
                )

            async def _api_identity_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for CORS on /api/identity."""
                return JSONResponse(
                    {},
                    headers={
                        "Access-Control-Allow-Origin": next((o for o in cors_origins if o in request.headers.get("origin", "")), cors_origins[0]),
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
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
                    headers={
                        "Access-Control-Allow-Origin": next((o for o in cors_origins if o in request.headers.get("origin", "")), cors_origins[0]),
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
                )

            async def _api_participants_options(request: Request) -> JSONResponse:
                """OPTIONS preflight for CORS on /api/participants."""
                return JSONResponse(
                    {},
                    headers={
                        "Access-Control-Allow-Origin": next((o for o in cors_origins if o in request.headers.get("origin", "")), cors_origins[0]),
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
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

            console.print(
                f"  [green]MCP server[/green] ready on http://{mcp_host}:{mcp_port}"
            )

            # 3) Web server
            web_task: asyncio.Task | None = None
            web_uvi_server: uvicorn.Server | None = None
            if web_enabled:
                from starlette.applications import Starlette
                from starlette.routing import Mount
                from starlette.staticfiles import StaticFiles

                # Locate web/dist relative to the package
                _pkg_dir = Path(__file__).resolve().parent
                _web_dist = (_pkg_dir / "../../web/dist").resolve()

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
        console.print(
            "[yellow]No daemon running.[/yellow]"
        )
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
