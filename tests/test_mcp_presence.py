"""
Regression tests for ``publish_mcp_presence_on_join`` (Bug 2 from the
v0.3.0 follow-up brief).

Pre-v0.3.1 behavior: an MCP-side ``comms_join`` published presence
to ``claude-comms/conv/{conv}/presence/{key}`` and
``claude-comms/system/participants/{key}-mcp`` with ``retain=False``.
A web UI that connected AFTER the worker joined saw no retained
message and ghosted the worker until the next 30-second REST poll.

These tests pin that the helper:

1. Publishes to BOTH topics
2. Uses ``retain=True``
3. Encodes the wire-format the web UI's ``#handlePresence`` expects
   (key / name / type / status / client / ts)
4. Swallows publish-side exceptions (best-effort -- presence is not a
   correctness gate for the join itself)
"""

from __future__ import annotations

import inspect
import json

import pytest

from claude_comms.mcp_server import publish_mcp_presence_on_join


# --------------------------------------------------------------------------
# Topic + retain assertions
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_publishes_to_both_conv_and_system_topics(publish_spy) -> None:
    await publish_mcp_presence_on_join(
        publish_spy,
        conversation="svelte-work",
        key="5e5d5fd1",
        name="svelte-worker",
        type_="claude",
    )
    topics = {call[0] for call in publish_spy.calls}
    assert "claude-comms/conv/svelte-work/presence/5e5d5fd1" in topics
    assert "claude-comms/system/participants/5e5d5fd1-mcp" in topics


@pytest.mark.asyncio
async def test_publishes_with_retain_true(publish_spy) -> None:
    """The Bug 2 fix: every presence publish must carry retain=True so
    web clients connecting AFTER the join still see the participant."""
    await publish_mcp_presence_on_join(
        publish_spy,
        conversation="svelte-work",
        key="5e5d5fd1",
        name="svelte-worker",
        type_="claude",
    )
    assert publish_spy.call_count == 2
    for _topic, _payload, retain in publish_spy.calls:
        assert retain is True, "presence publishes must be retained"


# --------------------------------------------------------------------------
# Wire format assertions (matches web/src/lib/mqtt-store.svelte.js
# #handlePresence expectations)
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_payload_has_all_handlePresence_fields(publish_spy) -> None:
    """The web UI's #handlePresence destructures (key, name, type, status,
    client, instanceId, ts). The MCP-side publish doesn't include
    instanceId (the connKey falls back to bare client name) but every
    other field must be present and correct."""
    await publish_mcp_presence_on_join(
        publish_spy,
        conversation="general",
        key="abcd1234",
        name="claude-dispatcher",
        type_="claude",
    )
    for _topic, payload, _retain in publish_spy.calls:
        msg = json.loads(payload)
        assert msg["key"] == "abcd1234"
        assert msg["name"] == "claude-dispatcher"
        assert msg["type"] == "claude"
        assert msg["status"] == "online"
        assert msg["client"] == "mcp"
        assert "ts" in msg and isinstance(msg["ts"], str)


@pytest.mark.asyncio
async def test_payload_for_human_type_still_publishes(publish_spy) -> None:
    """The helper doesn't gate on participant type -- the MCP transport
    is the gate. A human can theoretically join via MCP (CLI does this);
    that should still publish presence."""
    await publish_mcp_presence_on_join(
        publish_spy,
        conversation="general",
        key="ffffffff",
        name="phil",
        type_="human",
    )
    assert publish_spy.call_count == 2
    for _topic, payload, _retain in publish_spy.calls:
        assert json.loads(payload)["type"] == "human"


# --------------------------------------------------------------------------
# Resilience
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_swallows_publish_exceptions() -> None:
    """Best-effort: a broker disconnect during presence publish must NOT
    raise back into the caller -- the join already succeeded; presence
    is just the freshness hint. This is what lets ``_noop_publish``
    (placeholder before the MQTT subscriber is ready) be safe to call."""

    class _BrokenSpy:
        async def __call__(self, topic, payload, retain=False):
            raise ConnectionError("simulated broker outage")

    # Should NOT raise.
    await publish_mcp_presence_on_join(
        _BrokenSpy(),
        conversation="svelte-work",
        key="5e5d5fd1",
        name="svelte-worker",
        type_="claude",
    )


# --------------------------------------------------------------------------
# Presence keepalive: every read/poll tool must refresh presence (_touch)
# --------------------------------------------------------------------------


def _tool_body(source: str, name: str) -> str:
    """Return the source slice of an ``@mcp.tool`` function named *name*.

    Slices from ``def {name}(`` to the next tool boundary (next ``@mcp.tool``
    decorator or top-level-of-closure ``def``), good enough to assert a call
    appears inside the function body without importing the FastMCP wiring.
    """
    start = source.index(f"def {name}(")
    rest = source[start + 1 :]
    candidates = [
        i for i in (rest.find("\n    @mcp.tool"), rest.find("\n    def ")) if i != -1
    ]
    end = min(candidates) if candidates else len(rest)
    return rest[:end]


def test_every_read_path_touches_presence() -> None:
    """Regression guard: read/poll tools resurrect/refresh presence on call.

    If a future edit drops ``_touch(key)`` from any of these, slow pollers
    will flap offline between reads — exactly the keepalive bug this protects.
    """
    import claude_comms.mcp_server as mcp_server

    source = inspect.getsource(mcp_server)
    for name in (
        "comms_read",
        "comms_thread_read",
        "comms_history",
        "comms_check",
        "comms_members",
    ):
        body = _tool_body(source, name)
        assert "_touch(key)" in body, (
            f"{name} must call _touch(key) to keep presence fresh"
        )
