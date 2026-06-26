"""Single-origin Phase 1: REST + MCP co-mounted on the web port.

Phase 1 of the single-origin architecture (see
``.worklogs/harness-fixes/single-origin-design.md`` §2.1 / §5 / §7) co-mounts
the full ``/api/*`` REST surface AND the FastMCP streamable-HTTP handler at
``/mcp`` onto the WEB server app (the one that serves the SPA on ``:9921``),
in addition to the unchanged ``:9920`` MCP/REST server.

These tests assemble a web app the SAME way ``cli._run_daemon`` does — the
ordered ``api_routes`` list (built from the real public ``build_*_route``
factories plus the inline message route), then the ``/mcp`` ``Route`` wrapping
the shared ``StreamableHTTPASGIApp``, then the static ``/assets`` mount and the
``/`` ``StaticFiles(html=True)`` catch-all — and assert via Starlette
``TestClient`` that:

- ``/api/capabilities``, ``/api/identity``, ``/api/conversations``,
  ``/api/messages/{channel}`` are reachable (correct status) on the web app;
- ``/mcp`` is reachable (a real MCP ``initialize`` round-trips to 200), sharing
  the session manager started by the base ``:9920`` app's lifespan;
- the static ``/`` still serves ``index.html`` and does NOT shadow ``/api`` or
  ``/mcp`` (the ordering regression guard — if the catch-all came first it
  would return the SPA HTML for those paths instead of the API/MCP response).

NOTE on construction: production registers ``/mcp`` as
``Route("/mcp", endpoint=StreamableHTTPASGIApp(mcp.session_manager))``, NOT
``Mount("/mcp", app=mcp.streamable_http_app())``. A Mount strips the ``/mcp``
prefix and re-adds FastMCP's own internal ``/mcp`` route, making the real path
``/mcp/mcp`` (clients POST to ``/mcp`` → 404/405). The Route mirrors FastMCP's
own wiring so ``/mcp`` resolves correctly. These tests pin that contract.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.testclient import TestClient

import claude_comms.mcp_server as mcp_mod
from claude_comms.broker import MessageStore
from claude_comms.cli import (
    build_capabilities_route,
    build_conversations_route,
    build_identity_route,
)
from claude_comms.mcp_server import (
    create_server,
    get_all_conversations_full,
    get_channel_messages,
)
from claude_comms.mcp_tools import ParticipantRegistry


# Valid Host header so FastMCP's transport-security DNS-rebinding guard does
# not reject the request (it rejects the default TestClient ``testserver``).
_BASE_URL = "http://127.0.0.1:9921"
_HOST = "127.0.0.1:9921"


def _config() -> dict:
    return {
        "identity": {"key": "abcd1234", "name": "phil", "type": "human"},
        "web": {
            "allow_remote_edits": False,
            "strict_cors": True,
            "port": 9921,
        },
        "mcp": {"port": 9920},
        "broker": {"ws_port": 9001},
    }


@pytest.fixture
def web_setup(tmp_path: Path):
    """Build the base (:9920) MCP app + the single-origin web app.

    Yields ``(base_app, web_app, config)``. The base app is the FastMCP
    streamable app whose lifespan starts the shared session manager; the web
    app reuses that SAME session manager via a ``/mcp`` Route, mirroring
    ``cli._run_daemon``. Tests run both under ``with TestClient(...)`` so the
    base lifespan initialises the manager before the web ``/mcp`` is hit.
    """
    from mcp.server.fastmcp.server import StreamableHTTPASGIApp

    config = _config()

    orig_store = mcp_mod._store
    orig_reg = mcp_mod._registry
    orig_conv = mcp_mod._conv_data_dir
    orig_tracker = mcp_mod._activity_tracker

    # create_server resets mcp_mod._store / _registry etc., so build the server
    # FIRST, then overwrite the module-level singletons the REST handlers read
    # with our seeded test state (mirrors the daemon order: server built, then
    # the MQTT subscriber/registry wire up the live singletons).
    mcp = create_server(config)
    base_app = mcp.streamable_http_app()  # its lifespan runs session_manager

    store = MessageStore()
    store.add(
        "swo-test",
        {
            "id": "m1",
            "conv": "swo-test",
            "body": "hello",
            "ts": "2026-01-01T00:00:00Z",
        },
    )
    reg = ParticipantRegistry()
    reg.join("phil", "swo-test", participant_type="human", key="abcd1234")

    # conv data dir so get_all_conversations_full has something to scan
    conv_dir = tmp_path / "conv_data"
    conv_dir.mkdir()

    mcp_mod._store = store
    mcp_mod._registry = reg
    mcp_mod._conv_data_dir = conv_dir
    mcp_mod._activity_tracker = None

    # Inline message route mirrors the daemon's _api_messages closure.
    async def _api_messages(request: Request) -> JSONResponse:
        channel = request.path_params["channel"]
        msgs = get_channel_messages(channel, 50)
        return JSONResponse({"channel": channel, "count": len(msgs), "messages": msgs})

    api_routes: list[Route] = [
        Route("/api/messages/{channel}", _api_messages, methods=["GET"]),
        build_identity_route(config),
        build_conversations_route(config, get_all_conversations_full),
        build_capabilities_route(config),
    ]

    # Static dist with an index.html sentinel + an assets dir.
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><html>SPA-INDEX</html>")
    (dist / "assets").mkdir()
    (dist / "assets" / "app.js").write_text("// app bundle")

    web_app = Starlette(
        routes=[
            *api_routes,
            Route("/mcp", endpoint=StreamableHTTPASGIApp(mcp.session_manager)),
            Mount(
                "/assets",
                app=StaticFiles(directory=str(dist / "assets")),
                name="assets",
            ),
            Mount("/", app=StaticFiles(directory=str(dist), html=True), name="root"),
        ],
    )

    try:
        yield base_app, web_app, config
    finally:
        mcp_mod._store = orig_store
        mcp_mod._registry = orig_reg
        mcp_mod._conv_data_dir = orig_conv
        mcp_mod._activity_tracker = orig_tracker


class TestRestSurfaceOnWebApp:
    """The /api/* surface is reachable on the web app's route list."""

    def test_capabilities_reachable(self, web_setup):
        _, web_app, _ = web_setup
        with TestClient(web_app, base_url=_BASE_URL) as c:
            r = c.get("/api/capabilities")
        assert r.status_code == 200
        body = r.json()
        assert "writable" in body and "features" in body

    def test_identity_reachable(self, web_setup):
        _, web_app, _ = web_setup
        with TestClient(web_app, base_url=_BASE_URL) as c:
            r = c.get("/api/identity")
        assert r.status_code == 200
        assert r.json() == {"key": "abcd1234", "name": "phil", "type": "human"}

    def test_conversations_reachable(self, web_setup):
        _, web_app, _ = web_setup
        with TestClient(web_app, base_url=_BASE_URL) as c:
            r = c.get("/api/conversations")
        assert r.status_code == 200
        body = r.json()
        assert "conversations" in body and "count" in body

    def test_messages_reachable(self, web_setup):
        _, web_app, _ = web_setup
        with TestClient(web_app, base_url=_BASE_URL) as c:
            r = c.get("/api/messages/swo-test")
        assert r.status_code == 200
        body = r.json()
        assert body["channel"] == "swo-test"
        assert body["count"] == 1
        assert body["messages"][0]["body"] == "hello"


class TestMcpSurfaceOnWebApp:
    """The /mcp streamable handler is reachable on the web app, sharing the
    session manager started by the base (:9920) app's lifespan."""

    def test_mcp_initialize_round_trips(self, web_setup):
        base_app, web_app, _ = web_setup
        init = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        }
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2025-03-26",
            "Host": _HOST,
        }
        # The base app's lifespan must be active so session_manager.run() has
        # started the shared task group before the web /mcp dispatches into it.
        with TestClient(base_app, base_url=_BASE_URL):
            with TestClient(web_app, base_url=_BASE_URL) as wc:
                r = wc.post("/mcp", json=init, headers=headers)
        assert r.status_code == 200
        payload = r.json()
        assert payload["jsonrpc"] == "2.0"
        assert payload["result"]["serverInfo"]["name"] == "claude-comms"


class TestStaticOrderingRegressionGuard:
    """The static catch-all serves the SPA at ``/`` but MUST NOT shadow the
    ``/api`` or ``/mcp`` routes that precede it in the route list."""

    def test_root_serves_index_html(self, web_setup):
        _, web_app, _ = web_setup
        with TestClient(web_app, base_url=_BASE_URL) as c:
            r = c.get("/")
        assert r.status_code == 200
        assert "SPA-INDEX" in r.text

    def test_api_not_shadowed_by_spa_fallback(self, web_setup):
        """/api/capabilities returns JSON, not the SPA index HTML."""
        _, web_app, _ = web_setup
        with TestClient(web_app, base_url=_BASE_URL) as c:
            r = c.get("/api/capabilities")
        assert r.status_code == 200
        assert "SPA-INDEX" not in r.text
        # Genuinely the JSON handler, not StaticFiles serving index.
        assert r.headers["content-type"].startswith("application/json")

    def test_mcp_not_shadowed_by_spa_fallback(self, web_setup):
        """A GET to /mcp hits the MCP handler (which rejects the method),
        NOT the SPA catch-all (which would 200 with index.html)."""
        base_app, web_app, _ = web_setup
        with TestClient(base_app, base_url=_BASE_URL):
            with TestClient(web_app, base_url=_BASE_URL) as wc:
                r = wc.get("/mcp", headers={"Host": _HOST})
        # The MCP streamable handler owns /mcp; a bare GET is not a valid
        # streamable request, so it returns a non-200 from the MCP transport
        # rather than the 200 SPA HTML the static fallback would produce.
        assert r.status_code != 200
        assert "SPA-INDEX" not in r.text


# ===================================================================
# build_artifact_get_route — version query guard (PY-A LOW)
# ===================================================================


class TestArtifactGetRoute:
    """GET /api/artifacts/{conv}/{name}?version=N. A non-numeric ?version
    must return a clean 400, not crash to 500 (parity with /api/messages)."""

    @staticmethod
    def _client() -> TestClient:
        from claude_comms.cli import build_artifact_get_route

        def _get_artifact(conv: str, name: str, version=None):
            if name == "missing":
                return None
            return {"conversation": conv, "name": name, "version": version}

        app = Starlette(routes=[build_artifact_get_route(_get_artifact)])
        return TestClient(app)

    def test_non_numeric_version_returns_400(self) -> None:
        r = self._client().get("/api/artifacts/general/plan?version=abc")
        assert r.status_code == 400
        assert "integer" in r.json()["error"]

    def test_numeric_version_ok(self) -> None:
        r = self._client().get("/api/artifacts/general/plan?version=2")
        assert r.status_code == 200
        assert r.json()["version"] == 2

    def test_no_version_ok(self) -> None:
        r = self._client().get("/api/artifacts/general/plan")
        assert r.status_code == 200
        assert r.json()["version"] is None

    def test_missing_artifact_404(self) -> None:
        r = self._client().get("/api/artifacts/general/missing")
        assert r.status_code == 404

    def test_invalid_conv_400(self) -> None:
        r = self._client().get("/api/artifacts/INVALID!/plan")
        assert r.status_code == 400
