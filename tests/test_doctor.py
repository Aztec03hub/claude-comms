"""Tests for the ``claude-comms doctor`` self-check command.

``doctor`` (single-origin design §6) prints PASS/FAIL per check with an
actionable fix and exits non-zero if any critical check fails. It mirrors the
in-UI "Connection diagnostics" panel.

Coverage:

- The pure formatting/probe helpers (``_doctor_emit``, ``_doctor_can_bind``,
  ``_port_owner``).
- The CSP-sanity parsing branch (clean ``'self'`` vs a legacy ``api_base``
  enumeration that should be flagged).
- The no-config short-circuit (exit 1, "Fix: claude-comms init").
- The daemon-not-running path (criticals fail, exit 1).
- A full end-to-end GREEN run: a real uvicorn server bound on ephemeral
  loopback ports serves the same-origin web app (``/api/capabilities`` + ``/mcp``
  + the ``/mqtt`` broker bridge + a static ``/``) backed by a real embedded
  broker, and ``doctor`` reports every check ✓ and exits 0.
"""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import pytest
from typer.testing import CliRunner

from claude_comms.cli import (
    _doctor_can_bind,
    _doctor_emit,
    _port_owner,
    app,
    build_csp,
)


runner = CliRunner()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------
class TestDoctorHelpers:
    def test_emit_pass_no_fix(self, capsys) -> None:
        _doctor_emit(True, "Widget", "all good", fix="should-not-show")
        out = capsys.readouterr().out
        assert "Widget" in out
        assert "all good" in out
        # On pass, the fix hint is suppressed.
        assert "should-not-show" not in out

    def test_emit_fail_shows_fix(self, capsys) -> None:
        _doctor_emit(False, "Widget", "broken", fix="do-the-thing")
        out = capsys.readouterr().out
        assert "broken" in out
        assert "do-the-thing" in out

    def test_can_bind_free_port(self) -> None:
        assert _doctor_can_bind(_free_port()) is True

    def test_can_bind_busy_port(self) -> None:
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        busy = s.getsockname()[1]
        try:
            assert _doctor_can_bind(busy) is False
        finally:
            s.close()

    def test_port_owner_returns_none_for_free_port(self) -> None:
        # Nothing is listening, so no owner string should match.
        assert _port_owner(_free_port()) is None


# ---------------------------------------------------------------------------
# CSP sanity logic (mirrors the doctor branch's parsing)
# ---------------------------------------------------------------------------
def _connect_src_tokens(config: dict) -> list[str]:
    csp = build_csp(config)
    for directive in csp.split(";"):
        directive = directive.strip()
        if directive.startswith("connect-src"):
            return directive[len("connect-src") :].split()
    return []


class TestCspSanity:
    def test_single_origin_is_just_self(self) -> None:
        config = {"web": {"port": 9921}, "mcp": {"port": 9920}, "broker": {}}
        tokens = _connect_src_tokens(config)
        assert tokens == ["'self'"]

    def test_legacy_api_base_adds_extra_tokens(self) -> None:
        config = {
            "web": {"port": 9921, "api_base": "https://proxy.example"},
            "mcp": {"port": 9920},
            "broker": {"ws_port": 9001},
        }
        tokens = _connect_src_tokens(config)
        extra = [t for t in tokens if t != "'self'"]
        assert extra, "legacy api_base should add non-'self' connect-src entries"


# ---------------------------------------------------------------------------
# Command-level behaviour without a live server
# ---------------------------------------------------------------------------
class TestDoctorCommand:
    def test_no_config_exits_one(self, tmp_path: Path, monkeypatch) -> None:
        missing = tmp_path / "nope" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: missing)
        result = runner.invoke(app, ["doctor"])
        assert result.exit_code == 1
        assert "claude-comms init" in result.output

    def test_daemon_down_reports_failures(self, tmp_path: Path, monkeypatch) -> None:
        config_path = _write_config(tmp_path, web_port=_free_port())
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        result = runner.invoke(app, ["doctor"])
        assert result.exit_code == 1
        # Config check passes (identity key present); daemon check fails.
        assert "Config" in result.output
        assert "Daemon" in result.output
        assert "claude-comms start --web" in result.output


# ---------------------------------------------------------------------------
# Full end-to-end GREEN run against a real bound server + broker
# ---------------------------------------------------------------------------
def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _write_config(
    tmp_path: Path,
    *,
    web_port: int,
    mcp_port: int = 0,
    broker_port: int = 0,
    ws_port: int = 0,
) -> Path:
    import yaml

    config_path = tmp_path / "config.yaml"
    config = {
        "identity": {"key": "abcd1234", "name": "phil", "type": "human"},
        "web": {"enabled": True, "host": "127.0.0.1", "port": web_port},
        "mcp": {"host": "127.0.0.1", "port": mcp_port or _free_port()},
        "broker": {
            "mode": "host",
            "host": "127.0.0.1",
            "port": broker_port or _free_port(),
            "ws_host": "127.0.0.1",
            "ws_port": ws_port or _free_port(),
            "auth": {"enabled": False},
        },
        "default_conversation": "general",
    }
    config_path.write_text(yaml.safe_dump(config))
    return config_path


@pytest.fixture
def live_server(tmp_path: Path):
    """Run a real uvicorn web app + embedded broker on ephemeral ports.

    Yields ``(config_path, web_port)``. The web app mirrors the single-origin
    daemon: ``/api/capabilities`` + ``/mcp`` + the ``/mqtt`` broker bridge +
    a static ``/`` index, backed by a real :class:`EmbeddedBroker` started in
    the server's own event loop via the app lifespan.
    """
    import contextlib

    import uvicorn
    from mcp.server.fastmcp.server import StreamableHTTPASGIApp
    from starlette.applications import Starlette
    from starlette.routing import Mount, Route
    from starlette.staticfiles import StaticFiles

    import claude_comms.mcp_server as mcp_mod
    from claude_comms.broker import EmbeddedBroker, MessageStore
    from claude_comms.cli import build_capabilities_route, build_mqtt_ws_route
    from claude_comms.mcp_server import create_server
    from claude_comms.mcp_tools import ParticipantRegistry

    web_port = _free_port()
    tcp_port = _free_port()
    ws_port = _free_port()
    config_path = _write_config(
        tmp_path, web_port=web_port, broker_port=tcp_port, ws_port=ws_port
    )

    import yaml

    config = yaml.safe_load(config_path.read_text())

    # Build the MCP server + session manager (mirrors the daemon: calling
    # streamable_http_app() lazily creates the session manager that the /mcp
    # Route reuses).
    mcp = create_server(config)
    mcp.streamable_http_app()
    mcp_mod._store = MessageStore()
    mcp_mod._registry = ParticipantRegistry()
    mcp_mod._conv_data_dir = tmp_path / "conv_data"
    (tmp_path / "conv_data").mkdir(exist_ok=True)

    # Static dist with an index.html sentinel.
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><html>SPA</html>")
    (dist / "assets").mkdir()

    broker_holder: list[EmbeddedBroker | None] = [None]

    @contextlib.asynccontextmanager
    async def _lifespan(_app):  # type: ignore[no-untyped-def]
        broker = EmbeddedBroker(
            host="127.0.0.1",
            port=tcp_port,
            ws_host="127.0.0.1",
            ws_port=ws_port,
            pid_file=tmp_path / "broker.pid",
            log_dir=tmp_path / "logs",
        )
        await broker.start()
        broker_holder[0] = broker
        # The /mcp Route reuses this manager; run it for the app's lifetime.
        async with mcp.session_manager.run():
            try:
                yield
            finally:
                with contextlib.suppress(Exception):
                    await broker.stop()
                broker_holder[0] = None

    web_app = Starlette(
        routes=[
            build_capabilities_route(config),
            Route("/mcp", endpoint=StreamableHTTPASGIApp(mcp.session_manager)),
            build_mqtt_ws_route(lambda: broker_holder[0]),
            Mount("/", app=StaticFiles(directory=str(dist), html=True), name="root"),
        ],
        lifespan=_lifespan,
    )

    uvi_config = uvicorn.Config(
        web_app, host="127.0.0.1", port=web_port, log_level="warning"
    )
    server = uvicorn.Server(uvi_config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Wait for the server to bind.
    deadline = time.time() + 15
    while time.time() < deadline:
        if getattr(server, "started", False):
            break
        time.sleep(0.05)
    assert getattr(server, "started", False), "uvicorn did not start"

    try:
        yield config_path, web_port
    finally:
        server.should_exit = True
        thread.join(timeout=10)


class TestDoctorGreen:
    def test_all_checks_pass(self, live_server, monkeypatch) -> None:
        config_path, _web_port = live_server
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)
        # The daemon-running probe checks a PID file; pretend it is up so the
        # port-conflict check takes the "owned by us" branch.
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: 1234)

        result = runner.invoke(app, ["doctor"])

        assert result.exit_code == 0, result.output
        assert "All checks passed." in result.output
        # Every critical leg should report a check (✓) line.
        for check in (
            "Config",
            "Daemon",
            "Web origin",
            "REST same-origin",
            "MCP same-origin",
            "Broker WS same-origin",
            "Broker TCP",
            "CSP sanity",
        ):
            assert check in result.output, f"{check} missing from output"
        # No FAIL marker should appear.
        assert "✗" not in result.output
