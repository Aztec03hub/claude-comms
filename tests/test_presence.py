"""Unit tests for PresenceManager TTL-based liveness."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from claude_comms.mcp_tools import ParticipantRegistry
from claude_comms.participant import ConnectionInfo, Participant
from claude_comms.presence import (
    DEFAULT_CONNECTION_TTL_SECONDS,
    PresenceManager,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _stale_iso(seconds_ago: int) -> str:
    return (
        datetime.now(timezone.utc).astimezone() - timedelta(seconds=seconds_ago)
    ).isoformat()


def _registry_with_participant(
    key: str = "abcd1234",
    name: str = "test-user",
    conn_keys: list[str] | None = None,
    stale_seconds: int | None = None,
) -> tuple[ParticipantRegistry, Participant]:
    """Create a registry with a participant who has the specified connections.

    stale_seconds: if given, all connections get last_seen of that many seconds
                   ago.  Otherwise fresh.
    """
    reg = ParticipantRegistry()
    p = reg.join(name, "general", key=key, participant_type="human")
    ts = _stale_iso(stale_seconds) if stale_seconds else _now_iso()
    for ck in conn_keys or ["mcp"]:
        p.connections[ck] = ConnectionInfo(
            client=ck.split("-")[0] if "-" in ck else ck,
            instance_id=None,
            since=ts,
            last_seen=ts,
        )
    return reg, p


# ===================================================================
# 1. touch()
# ===================================================================


class TestTouch:
    def test_touch_updates_all_connections(self):
        old_ts = _stale_iso(60)
        reg = ParticipantRegistry()
        p = reg.join("alice", "general", key="abcd1234", participant_type="human")
        for ck in ("mcp", "web"):
            p.connections[ck] = ConnectionInfo(
                client=ck,
                instance_id=None,
                since=old_ts,
                last_seen=old_ts,
            )

        mgr = PresenceManager(reg)
        before = datetime.now(timezone.utc).astimezone()
        mgr.touch("abcd1234")
        after = datetime.now(timezone.utc).astimezone()

        for ck in ("mcp", "web"):
            updated = datetime.fromisoformat(p.connections[ck].last_seen)
            # Allow a tiny clock skew window
            assert (
                (before - timedelta(seconds=1))
                <= updated
                <= (after + timedelta(seconds=1))
            )
            # And clearly not the stale original
            assert p.connections[ck].last_seen != old_ts

    def test_touch_unknown_key_is_noop(self):
        reg = ParticipantRegistry()
        mgr = PresenceManager(reg)
        # Should not raise
        mgr.touch("00000000")

    def test_touch_no_connections_is_noop(self):
        reg = ParticipantRegistry()
        reg.join("alice", "general", key="abcd1234", participant_type="human")
        mgr = PresenceManager(reg)
        # Participant has no connections — must not raise, and must NOT
        # resurrect a connection (touch is strict refresh-only semantics).
        mgr.touch("abcd1234")
        p = reg.get("abcd1234")
        assert p is not None
        assert p.connections == {}


# ===================================================================
# 1b. ensure_connection() — refresh-or-resurrect
# ===================================================================


class TestEnsureConnection:
    def test_ensure_connection_updates_existing(self):
        """Like touch(): existing connections get their last_seen bumped."""
        old_ts = _stale_iso(60)
        reg = ParticipantRegistry()
        p = reg.join("alice", "general", key="abcd1234", participant_type="human")
        for ck in ("mcp", "web"):
            p.connections[ck] = ConnectionInfo(
                client=ck,
                instance_id=None,
                since=old_ts,
                last_seen=old_ts,
            )

        mgr = PresenceManager(reg)
        before = datetime.now(timezone.utc).astimezone()
        mgr.ensure_connection("abcd1234", client="mcp")
        after = datetime.now(timezone.utc).astimezone()

        for ck in ("mcp", "web"):
            updated = datetime.fromisoformat(p.connections[ck].last_seen)
            assert (
                (before - timedelta(seconds=1))
                <= updated
                <= (after + timedelta(seconds=1))
            )

    def test_ensure_connection_unknown_key_is_noop(self):
        reg = ParticipantRegistry()
        mgr = PresenceManager(reg)
        # Should not raise.
        mgr.ensure_connection("00000000", client="mcp")

    def test_ensure_connection_no_connections_recreates(self):
        """The fix: empty connections dict gets a fresh mcp record inserted."""
        reg = ParticipantRegistry()
        reg.join("alice", "general", key="abcd1234", participant_type="human")
        mgr = PresenceManager(reg)

        before = datetime.now(timezone.utc).astimezone()
        mgr.ensure_connection("abcd1234", client="mcp")
        after = datetime.now(timezone.utc).astimezone()

        p = reg.get("abcd1234")
        assert p is not None
        assert "mcp" in p.connections
        conn = p.connections["mcp"]
        assert conn.client == "mcp"
        assert conn.instance_id is None
        last_seen = datetime.fromisoformat(conn.last_seen)
        assert (
            (before - timedelta(seconds=1))
            <= last_seen
            <= (after + timedelta(seconds=1))
        )
        # since == last_seen on a fresh record
        assert conn.since == conn.last_seen

    def test_ensure_connection_after_sweep_brings_back_online(self):
        """End-to-end: stale conn gets swept, then ensure_connection resurrects."""
        # Start with a stale connection.
        reg, p = _registry_with_participant(
            stale_seconds=DEFAULT_CONNECTION_TTL_SECONDS + 5
        )
        assert "mcp" in p.connections

        mgr = PresenceManager(reg, ttl_seconds=DEFAULT_CONNECTION_TTL_SECONDS)

        # Run a single sweep — should drop the stale connection.
        async def _sweep():
            return await mgr._sweep_once()

        removed = asyncio.run(_sweep())
        assert ("abcd1234", "mcp") in removed
        assert p.connections == {}  # fully expired

        # Now simulate a tool call: ensure_connection should resurrect.
        mgr.ensure_connection("abcd1234", client="mcp")
        assert "mcp" in p.connections
        assert p.connections["mcp"].client == "mcp"

    def test_ensure_connection_respects_client_param(self):
        """Different client types create different conn keys."""
        reg = ParticipantRegistry()
        reg.join("alice", "general", key="abcd1234", participant_type="human")
        mgr = PresenceManager(reg)

        mgr.ensure_connection("abcd1234", client="web")
        p = reg.get("abcd1234")
        assert p is not None
        assert "web" in p.connections
        assert "mcp" not in p.connections
        assert p.connections["web"].client == "web"


# ===================================================================
# 2. _sweep_once()
# ===================================================================


class TestSweepOnce:
    @pytest.mark.asyncio
    async def test_sweep_removes_stale_connections(self):
        reg, p = _registry_with_participant(
            key="abcd1234", conn_keys=["mcp"], stale_seconds=400
        )
        mgr = PresenceManager(reg)

        removed = await mgr._sweep_once()

        assert ("abcd1234", "mcp") in removed
        assert "mcp" not in p.connections

    @pytest.mark.asyncio
    async def test_sweep_preserves_fresh_connections(self):
        reg, p = _registry_with_participant(
            key="abcd1234", conn_keys=["mcp"], stale_seconds=None
        )
        mgr = PresenceManager(reg)

        removed = await mgr._sweep_once()

        assert removed == []
        assert "mcp" in p.connections

    @pytest.mark.asyncio
    async def test_sweep_handles_unparseable_last_seen(self):
        reg = ParticipantRegistry()
        p = reg.join("alice", "general", key="abcd1234", participant_type="human")
        p.connections["mcp"] = ConnectionInfo(
            client="mcp",
            instance_id=None,
            since=_now_iso(),
            last_seen="garbage",
        )
        mgr = PresenceManager(reg)

        # Must not raise
        removed = await mgr._sweep_once()

        assert removed == []
        assert "mcp" in p.connections

    @pytest.mark.asyncio
    async def test_sweep_handles_mixed_connections(self):
        reg = ParticipantRegistry()
        p = reg.join("alice", "general", key="abcd1234", participant_type="human")
        # Fresh
        fresh_ts = _now_iso()
        p.connections["web"] = ConnectionInfo(
            client="web", instance_id=None, since=fresh_ts, last_seen=fresh_ts
        )
        # Stale
        stale_ts = _stale_iso(400)
        p.connections["mcp"] = ConnectionInfo(
            client="mcp", instance_id=None, since=stale_ts, last_seen=stale_ts
        )

        mgr = PresenceManager(reg)
        removed = await mgr._sweep_once()

        assert removed == [("abcd1234", "mcp")]
        assert "web" in p.connections
        assert "mcp" not in p.connections


# ===================================================================
# 3. _publish_offline()
# ===================================================================


class TestPublishOffline:
    @pytest.mark.asyncio
    async def test_publish_offline_sends_empty_retained(self):
        reg = ParticipantRegistry()
        publish_fn = AsyncMock()
        mgr = PresenceManager(reg, publish_fn=publish_fn)

        await mgr._publish_offline("abcd1234", "mcp")

        publish_fn.assert_awaited_once_with(
            "claude-comms/presence/abcd1234/mcp", b"", retain=True
        )

    @pytest.mark.asyncio
    async def test_publish_offline_no_publish_fn_is_silent(self):
        reg = ParticipantRegistry()
        mgr = PresenceManager(reg)  # no publish_fn

        # Must not raise
        await mgr._publish_offline("abcd1234", "mcp")

    @pytest.mark.asyncio
    async def test_publish_offline_swallows_publish_errors(self):
        reg = ParticipantRegistry()
        publish_fn = AsyncMock(side_effect=RuntimeError("broker down"))
        mgr = PresenceManager(reg, publish_fn=publish_fn)

        # Must not propagate
        await mgr._publish_offline("abcd1234", "mcp")

        publish_fn.assert_awaited_once()


# ===================================================================
# 4. flush_all_offline()
# ===================================================================


class TestFlushAllOffline:
    @pytest.mark.asyncio
    async def test_flush_publishes_for_every_connection(self):
        reg = ParticipantRegistry()
        ts = _now_iso()
        p1 = reg.join("alice", "general", key="abcd1234", participant_type="human")
        p2 = reg.join("bob", "general", key="deadbeef", participant_type="human")
        for p in (p1, p2):
            for ck in ("mcp", "web"):
                p.connections[ck] = ConnectionInfo(
                    client=ck, instance_id=None, since=ts, last_seen=ts
                )

        publish_fn = AsyncMock()
        mgr = PresenceManager(reg, publish_fn=publish_fn)

        await mgr.flush_all_offline()

        assert publish_fn.await_count == 4
        # Verify all calls used retained empty payloads
        for call in publish_fn.await_args_list:
            args, kwargs = call
            topic, payload = args[0], args[1]
            assert topic.startswith("claude-comms/presence/")
            assert payload == b""
            assert kwargs.get("retain") is True

        # Every expected topic is present
        topics = {call.args[0] for call in publish_fn.await_args_list}
        assert topics == {
            "claude-comms/presence/abcd1234/mcp",
            "claude-comms/presence/abcd1234/web",
            "claude-comms/presence/deadbeef/mcp",
            "claude-comms/presence/deadbeef/web",
        }

    @pytest.mark.asyncio
    async def test_flush_with_no_participants_is_noop(self):
        reg = ParticipantRegistry()
        publish_fn = AsyncMock()
        mgr = PresenceManager(reg, publish_fn=publish_fn)

        await mgr.flush_all_offline()

        publish_fn.assert_not_awaited()


# ===================================================================
# 5. start() / stop() / _run()
# ===================================================================


class TestRun:
    @pytest.mark.asyncio
    async def test_start_creates_task(self):
        reg = ParticipantRegistry()
        # Large sweep interval so the task stays idle
        mgr = PresenceManager(reg, sweep_interval_seconds=3600)

        mgr.start()
        try:
            assert mgr._task is not None
            assert not mgr._task.done()
        finally:
            await mgr.stop()

    @pytest.mark.asyncio
    async def test_stop_cancels_task(self):
        reg = ParticipantRegistry()
        mgr = PresenceManager(reg, sweep_interval_seconds=3600)
        mgr.start()
        task = mgr._task
        assert task is not None

        await mgr.stop()

        # Task reference cleared, underlying task done without raising out
        assert mgr._task is None
        assert task.done()
        # Cancellation was handled inside stop() — no exception propagated above
        # If it did raise, we'd never reach here.

    @pytest.mark.asyncio
    async def test_start_is_idempotent(self):
        reg = ParticipantRegistry()
        mgr = PresenceManager(reg, sweep_interval_seconds=3600)

        mgr.start()
        first_task = mgr._task
        try:
            mgr.start()
            second_task = mgr._task
            # Second call must not replace the first running task
            assert first_task is second_task
        finally:
            await mgr.stop()


# ===================================================================
# 6. Integration
# ===================================================================


class TestIntegration:
    @pytest.mark.asyncio
    async def test_full_cycle_expire_and_offline_publish(self):
        """Sweep removes a stale connection and triggers an offline publish.

        Rather than sleeping until TTL elapses (which adds wall-clock flake
        risk), we backdate ``last_seen`` to a past timestamp and invoke
        ``_sweep_once()`` directly.  The PresenceManager's background loop
        calls ``_publish_offline`` after each removed connection; we replicate
        that here so the full removal cycle is exercised without a timer.

        Production path:
            presence._sweep_once() → age > ttl_seconds → p.connections.pop()
            → caller calls _publish_offline(key, conn_key) → publish_fn(topic, b"", retain=True)
        """
        reg = ParticipantRegistry()
        p = reg.join("alice", "general", key="abcd1234", participant_type="human")
        # Backdate last_seen far enough to exceed any reasonable TTL.
        stale = _stale_iso(3600)
        p.connections["mcp"] = ConnectionInfo(
            client="mcp", instance_id=None, since=stale, last_seen=stale
        )

        publish_fn = AsyncMock()
        mgr = PresenceManager(
            reg,
            publish_fn=publish_fn,
            ttl_seconds=60,  # shorter than the 3600-s staleness above
        )

        # Drive the sweep directly — no background task, no wall-clock wait.
        removed = await mgr._sweep_once()  # noqa: SLF001
        # Replicate what _run() does after the sweep.
        for key, conn_key in removed:
            await mgr._publish_offline(key, conn_key)  # noqa: SLF001

        assert "mcp" not in p.connections
        assert ("abcd1234", "mcp") in removed
        publish_fn.assert_any_await(
            "claude-comms/presence/abcd1234/mcp", b"", retain=True
        )
