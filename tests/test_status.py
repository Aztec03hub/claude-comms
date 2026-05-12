"""Phase B+C backend tests for ephemeral status / activity (claude-sage).

Covers:
- Activity model serialisation (round-trip through pydantic + ConnectionInfo).
- ``tool_comms_status_set`` / ``tool_comms_status_clear`` semantics:
  unknown key, not-a-member, label validation, TTL clamping, throttle,
  applies-to-every-connection, idempotent clear, MQTT publish payload shape.
- Auto-synthesis of ``connections["mcp"]`` for Claude clients on join.
- Presence sweep clears expired activity while leaving the connection alive,
  and removes stale connections normally.
- ``working_indicator.working`` and ``working_decorator`` ergonomic helpers.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from claude_comms import mcp_tools
from claude_comms.mcp_tools import (
    MAX_ACTIVITY_TTL_SECONDS,
    ParticipantRegistry,
    activity_topic,
    tool_comms_join,
    tool_comms_members,
    tool_comms_status_clear,
    tool_comms_status_set,
)
from claude_comms.participant import Activity, ConnectionInfo
from claude_comms.message import now_iso
from claude_comms.presence import PresenceManager
from claude_comms.working_indicator import working, working_decorator


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reset_throttle() -> None:
    """Clear the module-level activity throttle so adjacent tests don't bleed."""
    mcp_tools._activity_last_write.clear()


@pytest.fixture(autouse=True)
def _isolate_throttle():
    """Each test gets a fresh throttle window."""
    _reset_throttle()
    yield
    _reset_throttle()


async def _join_claude(reg: ParticipantRegistry, name: str = "claude-x") -> str:
    """Join a Claude into 'general' and return its key."""
    res = await tool_comms_join(reg, name=name, conversation="general")
    assert res.get("error") is not True, res
    return res["key"]


# ---------------------------------------------------------------------------
# Activity model
# ---------------------------------------------------------------------------


def test_activity_round_trip():
    a = Activity(
        label="thinking",
        set_at="2026-04-28T10:00:00Z",
        expires_at="2026-04-28T10:00:30Z",
    )
    payload = a.model_dump_json()
    a2 = Activity.model_validate_json(payload)
    assert a2 == a


def test_activity_label_length_validation():
    with pytest.raises(Exception):
        Activity(label="", set_at="t", expires_at="t")
    with pytest.raises(Exception):
        Activity(label="x" * 33, set_at="t", expires_at="t")


def test_connection_info_optional_activity():
    ts = now_iso()
    c = ConnectionInfo(client="mcp", since=ts, last_seen=ts)
    assert c.activity is None
    c.activity = Activity(label="reading", set_at=ts, expires_at=ts)
    assert c.activity.label == "reading"


# ---------------------------------------------------------------------------
# join synthesizes mcp connection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_join_claude_synthesizes_mcp_connection():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    p = reg.get(key)
    assert p is not None
    assert "mcp" in p.connections
    assert p.connections["mcp"].client == "mcp"
    assert p.connections["mcp"].activity is None


@pytest.mark.asyncio
async def test_join_idempotent_does_not_duplicate_mcp():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    # Re-join with the existing key
    await tool_comms_join(reg, key=key, conversation="general")
    p = reg.get(key)
    assert list(p.connections.keys()) == ["mcp"]


# ---------------------------------------------------------------------------
# status_set validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_set_unknown_key():
    reg = ParticipantRegistry()
    res = await tool_comms_status_set(
        reg, key="deadbeef", conversation="general", label="thinking"
    )
    assert res.get("error") is True


@pytest.mark.asyncio
async def test_status_set_not_a_member():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    res = await tool_comms_status_set(
        reg, key=key, conversation="other-room", label="thinking"
    )
    assert res.get("error") is True


@pytest.mark.asyncio
async def test_status_set_label_required():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    res = await tool_comms_status_set(reg, key=key, conversation="general", label="")
    assert res.get("error") is True
    res2 = await tool_comms_status_set(
        reg, key=key, conversation="general", label="   "
    )
    assert res2.get("error") is True


@pytest.mark.asyncio
async def test_status_set_label_too_long():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    res = await tool_comms_status_set(
        reg, key=key, conversation="general", label="x" * 33
    )
    assert res.get("error") is True


# ---------------------------------------------------------------------------
# status_set TTL clamping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_set_ttl_clamped_to_max():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    res = await tool_comms_status_set(
        reg, key=key, conversation="general", label="thinking", ttl_seconds=10_000
    )
    assert res["status"] == "set"
    assert res["ttl_seconds"] == MAX_ACTIVITY_TTL_SECONDS


@pytest.mark.asyncio
async def test_status_set_ttl_clamped_to_min():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    res = await tool_comms_status_set(
        reg, key=key, conversation="general", label="thinking", ttl_seconds=0
    )
    assert res["status"] == "set"
    assert res["ttl_seconds"] == 1


# ---------------------------------------------------------------------------
# status_set applies + members reflects activity
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_set_applies_to_every_connection():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    p = reg.get(key)
    # Add another connection (simulate a web tab)
    ts = now_iso()
    p.connections["web-abcd"] = ConnectionInfo(
        client="web", instance_id="abcd", since=ts, last_seen=ts
    )

    res = await tool_comms_status_set(
        reg, key=key, conversation="general", label="thinking"
    )
    assert res["status"] == "set"
    assert set(res["applied_to_connections"]) == {"mcp", "web-abcd"}
    assert p.connections["mcp"].activity.label == "thinking"
    assert p.connections["web-abcd"].activity.label == "thinking"


@pytest.mark.asyncio
async def test_members_reflects_activity():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    await tool_comms_status_set(reg, key=key, conversation="general", label="reading")

    out = tool_comms_members(reg, key=key, conversation="general")
    me = out["members"][0]
    assert me["connections"]["mcp"]["activity"]["label"] == "reading"


# ---------------------------------------------------------------------------
# Throttle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_set_throttle_drops_burst():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    r1 = await tool_comms_status_set(reg, key=key, conversation="general", label="a")
    r2 = await tool_comms_status_set(reg, key=key, conversation="general", label="b")
    assert r1["status"] == "set"
    assert r2["status"] == "throttled"


# ---------------------------------------------------------------------------
# Clear
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_clear_removes_activity():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    await tool_comms_status_set(reg, key=key, conversation="general", label="thinking")
    res = await tool_comms_status_clear(reg, key=key, conversation="general")
    assert res["status"] == "cleared"
    assert res["count"] == 1
    p = reg.get(key)
    assert p.connections["mcp"].activity is None


@pytest.mark.asyncio
async def test_status_clear_idempotent_when_no_activity():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    res = await tool_comms_status_clear(reg, key=key, conversation="general")
    assert res["status"] == "cleared"
    assert res["count"] == 0


# ---------------------------------------------------------------------------
# MQTT publish payload shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_set_publishes_event():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    published: list[tuple[str, bytes]] = []

    async def fake_publish(topic, payload):
        published.append((topic, payload))

    res = await tool_comms_status_set(
        reg,
        key=key,
        conversation="general",
        label="thinking",
        publish_fn=fake_publish,
    )
    assert res["status"] == "set"
    assert len(published) == 1
    topic, payload = published[0]
    assert topic == activity_topic("general")
    body = json.loads(payload.decode())
    assert body["op"] == "set"
    assert body["activity"]["label"] == "thinking"
    assert body["key"] == key


@pytest.mark.asyncio
async def test_status_clear_publishes_event():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    published: list[tuple[str, bytes]] = []

    async def fake_publish(topic, payload):
        published.append((topic, payload))

    await tool_comms_status_set(
        reg, key=key, conversation="general", label="thinking", publish_fn=fake_publish
    )
    _reset_throttle()  # bypass throttle for the clear publish
    res = await tool_comms_status_clear(
        reg, key=key, conversation="general", publish_fn=fake_publish
    )
    assert res["status"] == "cleared"
    # Two publishes total: one set, one clear
    assert len(published) == 2
    body = json.loads(published[-1][1].decode())
    assert body["op"] == "clear"
    assert body["activity"] is None


@pytest.mark.asyncio
async def test_status_set_throttled_does_not_publish():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    published: list[tuple[str, bytes]] = []

    async def fake_publish(topic, payload):
        published.append((topic, payload))

    await tool_comms_status_set(
        reg, key=key, conversation="general", label="a", publish_fn=fake_publish
    )
    res2 = await tool_comms_status_set(
        reg, key=key, conversation="general", label="b", publish_fn=fake_publish
    )
    assert res2["status"] == "throttled"
    # Only one publish — the throttled call is a no-op
    assert len(published) == 1


# ---------------------------------------------------------------------------
# Presence sweep
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_clears_expired_activity_but_keeps_connection():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    # Set a very short activity TTL
    await tool_comms_status_set(
        reg, key=key, conversation="general", label="thinking", ttl_seconds=1
    )
    p = reg.get(key)
    assert p.connections["mcp"].activity is not None

    # Wait past the activity expiry
    await asyncio.sleep(1.5)

    # Sweep with a generous connection TTL so the connection itself stays
    pm = PresenceManager(reg, ttl_seconds=3600)
    removed = await pm._sweep_once()
    assert removed == []
    assert "mcp" in p.connections  # connection still alive
    assert p.connections["mcp"].activity is None  # activity cleared


@pytest.mark.asyncio
async def test_sweep_removes_stale_connection():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    p = reg.get(key)
    # Backdate the connection's last_seen so it's stale
    from datetime import datetime, timedelta, timezone

    stale = (datetime.now(timezone.utc) - timedelta(hours=1)).astimezone().isoformat()
    p.connections["mcp"].last_seen = stale

    pm = PresenceManager(reg, ttl_seconds=60)
    removed = await pm._sweep_once()
    assert (key, "mcp") in removed
    assert "mcp" not in p.connections


@pytest.mark.asyncio
async def test_sweep_clears_malformed_activity_timestamp():
    reg = ParticipantRegistry()
    key = await _join_claude(reg)
    p = reg.get(key)
    # Plant a malformed activity with bad expires_at
    p.connections["mcp"].activity = Activity(
        label="thinking", set_at="ok", expires_at="not-a-real-timestamp"
    )

    pm = PresenceManager(reg, ttl_seconds=3600)
    await pm._sweep_once()
    assert p.connections["mcp"].activity is None


# ---------------------------------------------------------------------------
# working_indicator helpers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_working_context_manager_sets_and_clears():
    set_calls: list[tuple] = []
    clear_calls = 0

    async def set_status(label, ttl_seconds):
        set_calls.append((label, ttl_seconds))

    async def clear_status():
        nonlocal clear_calls
        clear_calls += 1

    async with working(set_status, clear_status, "running tests", ttl_seconds=10):
        pass

    assert set_calls == [("running tests", 10)]
    assert clear_calls == 1


@pytest.mark.asyncio
async def test_working_context_manager_clears_on_exception():
    cleared = False

    async def set_status(label, ttl_seconds):
        pass

    async def clear_status():
        nonlocal cleared
        cleared = True

    with pytest.raises(RuntimeError):
        async with working(set_status, clear_status, "x"):
            raise RuntimeError("boom")
    assert cleared is True


@pytest.mark.asyncio
async def test_working_swallows_set_error_by_default():
    cleared = False

    async def set_status(label, ttl_seconds):
        raise RuntimeError("broker down")

    async def clear_status():
        nonlocal cleared
        cleared = True

    # Should not raise: swallow_errors=True default
    async with working(set_status, clear_status, "x"):
        pass
    assert cleared is True


@pytest.mark.asyncio
async def test_working_decorator_round_trip():
    set_calls = []
    clear_calls = 0

    async def set_status(label, ttl_seconds):
        set_calls.append((label, ttl_seconds))

    async def clear_status():
        nonlocal clear_calls
        clear_calls += 1

    @working_decorator(set_status, clear_status, "summarising", ttl_seconds=20)
    async def task(x: int) -> int:
        return x * 2

    result = await task(21)
    assert result == 42
    assert set_calls == [("summarising", 20)]
    assert clear_calls == 1


@pytest.mark.asyncio
async def test_working_decorator_clears_on_exception():
    cleared = False

    async def set_status(label, ttl_seconds):
        pass

    async def clear_status():
        nonlocal cleared
        cleared = True

    @working_decorator(set_status, clear_status, "running")
    async def task():
        raise ValueError("nope")

    with pytest.raises(ValueError):
        await task()
    assert cleared is True
