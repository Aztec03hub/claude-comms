"""Backend tests for the durable profile-status triplet (v0.4.2 Step 3.14).

Covers ``comms_profile_status_set`` / ``comms_profile_status_clear`` MCP
tools plus the schema v2 -> v3 migration on the ``participants`` table.

Distinct from ``tests/test_status.py``, which covers the ephemeral
v0.4.0 activity API (``comms_status_set`` / ``comms_status_clear``) — see
``.worklogs/v042-3.14-HALTED-collision-report.md`` for the §I.18 rename
rationale.

Tests included (>=12 required by brief):

1.  ``test_profile_status_set_happy_path``
2.  ``test_profile_status_clear_happy_path``
3.  ``test_profile_status_set_then_clear_idempotent``
4.  ``test_profile_status_set_expires_at_future_preserved``
5.  ``test_profile_status_set_expires_at_past_swept_on_first_tick``
6.  ``test_profile_status_set_both_emoji_and_text_none_collapses_to_clear``
7.  ``test_profile_status_set_text_too_long_returns_error``
8.  ``test_profile_status_set_publishes_per_connection_with_three_keys``
9.  ``test_profile_status_set_payload_retain_true``
10. ``test_schema_migration_v2_to_v3_idempotent_on_populated_db``
11. ``test_schema_migration_v2_to_v3_adds_columns_on_first_open``
12. ``test_schema_migration_pragma_before_after``
13. ``test_existing_comms_status_set_still_works_post_migration``
        (REGRESSION on v0.4.0 ephemeral activity API)
14. ``test_auto_expire_sweep_clears_expired_and_republishes``
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from claude_comms.mcp_tools import (
    ParticipantRegistry,
    auto_expire_profile_statuses_once,
    profile_status_presence_topic,
    tool_comms_join,
    tool_comms_profile_status_clear,
    tool_comms_profile_status_set,
    tool_comms_status_set,
)
from claude_comms.participant import ConnectionInfo
from claude_comms.message import now_iso
from claude_comms.registry_store import (
    SCHEMA_VERSION,
    RegistryStore,
    _SCHEMA_DDL,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> RegistryStore:
    """Fresh registry store rooted at tmp_path (data_dir == tmp_path)."""
    s = RegistryStore.open(tmp_path)
    yield s
    s.close()


@pytest.fixture
def registry(store: RegistryStore) -> ParticipantRegistry:
    """Registry wired to the fresh store, for tests that need round-tripping."""
    return ParticipantRegistry(store=store)


async def _join_claude(reg: ParticipantRegistry, name: str = "claude-x") -> str:
    res = await tool_comms_join(reg, name=name, conversation="general")
    assert res.get("error") is not True, res
    return res["key"]


def _capture_publish_fn():
    """Return (publish_fn, captured_list) for assertions on publishes."""
    captured: list[dict] = []

    async def _pub(topic: str, payload: bytes, retain: bool = False) -> None:
        captured.append({"topic": topic, "payload": payload, "retain": retain})

    return _pub, captured


# ---------------------------------------------------------------------------
# 1-3: Set / clear happy paths and idempotency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_status_set_happy_path(registry: ParticipantRegistry):
    key = await _join_claude(registry)
    res = await tool_comms_profile_status_set(
        registry,
        key=key,
        emoji="thinking-face",
        text="deep in plan review",
    )
    assert res["status"] == "set"
    assert res["emoji"] == "thinking-face"
    assert res["text"] == "deep in plan review"

    p = registry.get(key)
    assert p.profile_status_emoji == "thinking-face"
    assert p.profile_status_text == "deep in plan review"
    assert p.profile_status_expires_at is None


@pytest.mark.asyncio
async def test_profile_status_clear_happy_path(registry: ParticipantRegistry):
    key = await _join_claude(registry)
    await tool_comms_profile_status_set(registry, key=key, emoji="x", text="something")
    res = await tool_comms_profile_status_clear(registry, key=key)
    assert res["status"] == "cleared"
    p = registry.get(key)
    assert p.profile_status_emoji is None
    assert p.profile_status_text is None
    assert p.profile_status_expires_at is None


@pytest.mark.asyncio
async def test_profile_status_set_then_clear_idempotent(
    registry: ParticipantRegistry,
):
    """Clear is safe to call repeatedly — no errors, columns stay NULL."""
    key = await _join_claude(registry)
    r1 = await tool_comms_profile_status_clear(registry, key=key)
    r2 = await tool_comms_profile_status_clear(registry, key=key)
    assert r1["status"] == r2["status"] == "cleared"
    p = registry.get(key)
    assert p.profile_status_emoji is None


# ---------------------------------------------------------------------------
# 4-5: expires_at semantics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_status_set_expires_at_future_preserved(
    registry: ParticipantRegistry,
):
    key = await _join_claude(registry)
    future_iso = (
        datetime.now(timezone.utc).astimezone() + timedelta(hours=1)
    ).isoformat()
    res = await tool_comms_profile_status_set(
        registry, key=key, emoji="zzz", text="afk 1h", expires_at=future_iso
    )
    assert res["status"] == "set"
    assert res["expires_at"] == future_iso

    # Auto-expire sweep should NOT touch a future-expiring status.
    cleared = await auto_expire_profile_statuses_once(registry, publish_fn=None)
    assert cleared == []
    p = registry.get(key)
    assert p.profile_status_text == "afk 1h"


@pytest.mark.asyncio
async def test_profile_status_set_expires_at_past_swept_on_first_tick(
    registry: ParticipantRegistry,
):
    """Past expires_at => row is set, but the first sweep clears it."""
    key = await _join_claude(registry)
    past_iso = (
        datetime.now(timezone.utc).astimezone() - timedelta(hours=1)
    ).isoformat()
    res = await tool_comms_profile_status_set(
        registry, key=key, emoji="x", text="leftover", expires_at=past_iso
    )
    assert res["status"] == "set"
    cleared_keys = await auto_expire_profile_statuses_once(registry, publish_fn=None)
    assert key in cleared_keys
    p = registry.get(key)
    assert p.profile_status_emoji is None
    assert p.profile_status_text is None


# ---------------------------------------------------------------------------
# 6: both None collapses to clear
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_status_set_both_emoji_and_text_none_collapses_to_clear(
    registry: ParticipantRegistry,
):
    """Brief asks for documented behaviour when emoji+text are both None.

    Choice: collapse to a clear (matches the §I.18 rule that the three
    columns move atomically — a set with no payload is semantically a
    clear). Documented here + in tool docstring + worklog §9.
    """
    key = await _join_claude(registry)
    # Seed something so we can prove the collapse actually wipes it.
    await tool_comms_profile_status_set(registry, key=key, emoji="x", text="seed")
    res = await tool_comms_profile_status_set(registry, key=key, emoji=None, text=None)
    assert res["status"] == "cleared"
    p = registry.get(key)
    assert p.profile_status_emoji is None
    assert p.profile_status_text is None


# ---------------------------------------------------------------------------
# 7: bounds
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_status_set_text_too_long_returns_error(
    registry: ParticipantRegistry,
):
    key = await _join_claude(registry)
    res = await tool_comms_profile_status_set(
        registry, key=key, emoji="x", text="y" * 141
    )
    assert res.get("error") is True


# ---------------------------------------------------------------------------
# 8-9: presence payload contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_status_set_publishes_per_connection_with_three_keys(
    registry: ParticipantRegistry,
):
    key = await _join_claude(registry)
    # Add an extra web connection so we can assert per-conn fan-out.
    p = registry.get(key)
    ts = now_iso()
    p.connections["web-abcd"] = ConnectionInfo(
        client="web", instance_id="abcd", since=ts, last_seen=ts
    )

    publish_fn, captured = _capture_publish_fn()
    res = await tool_comms_profile_status_set(
        registry,
        key=key,
        emoji="zap",
        text="shipping a feature",
        publish_fn=publish_fn,
    )
    assert res["status"] == "set"
    # Two connections => two retained publishes.
    assert len(captured) == 2
    topics = sorted(c["topic"] for c in captured)
    assert topics == sorted(
        [
            profile_status_presence_topic(key, "mcp"),
            profile_status_presence_topic(key, "web-abcd"),
        ]
    )
    for entry in captured:
        body = json.loads(entry["payload"].decode())
        # Existing presence keys preserved.
        for k in ("key", "name", "type", "status", "client", "ts"):
            assert k in body, f"missing existing key {k!r} in payload"
        # Three new profile_status_* keys present and snake_case.
        assert body["profile_status_emoji"] == "zap"
        assert body["profile_status_text"] == "shipping a feature"
        assert "profile_status_expires_at" in body


@pytest.mark.asyncio
async def test_profile_status_set_payload_retain_true(
    registry: ParticipantRegistry,
):
    key = await _join_claude(registry)
    publish_fn, captured = _capture_publish_fn()
    await tool_comms_profile_status_set(
        registry, key=key, emoji="x", text="y", publish_fn=publish_fn
    )
    assert captured, "no publish captured"
    for entry in captured:
        assert entry["retain"] is True, (
            f"publish must be retained; got retain={entry['retain']!r}"
        )


# ---------------------------------------------------------------------------
# 10-12: schema migration
# ---------------------------------------------------------------------------


def _seed_v2_db(tmp_path: Path) -> Path:
    """Bake a v0.4.2-Wave-A registry.db (schema_version=2, no profile_status_*).

    Mirrors the v1 fixture pattern in ``tests/test_registry_role.py`` — strip
    the v3 column additions from the live DDL so the seed cannot drift if
    later v2 tables ever get tweaked.
    """
    db_path = tmp_path / "registry.db"
    conn = sqlite3.connect(str(db_path))
    try:
        # Build v2-shaped participants table (no profile_status_* cols) by
        # rewriting the DDL block. Other v2 tables ride along verbatim.
        v2_participants = (
            "CREATE TABLE IF NOT EXISTS participants ("
            "key TEXT PRIMARY KEY, name TEXT NOT NULL, "
            "type TEXT NOT NULL CHECK (type IN ('claude','human')), "
            "created_at TEXT NOT NULL, last_seen TEXT NOT NULL); "
        )
        rest = _SCHEMA_DDL.split("CREATE INDEX")[1:]
        rebuilt = v2_participants + "CREATE INDEX" + "CREATE INDEX".join(rest)
        conn.executescript(rebuilt)
        conn.execute(
            "INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)",
            ("schema_version", "2"),
        )
        # Seed a participant row to exercise non-empty migration path.
        conn.execute(
            "INSERT INTO participants (key, name, type, created_at, last_seen) "
            "VALUES (?, ?, ?, ?, ?)",
            ("deadbeef", "old-claude", "claude", now_iso(), now_iso()),
        )
        conn.commit()
    finally:
        conn.close()
    return tmp_path


def test_schema_migration_v2_to_v3_adds_columns_on_first_open(tmp_path: Path):
    data_dir = _seed_v2_db(tmp_path)
    # Pre-migration: confirm profile_status_* are absent.
    pre_conn = sqlite3.connect(str(data_dir / "registry.db"))
    try:
        cols_pre = {
            row[1] for row in pre_conn.execute("PRAGMA table_info(participants)")
        }
    finally:
        pre_conn.close()
    assert "profile_status_emoji" not in cols_pre
    assert "profile_status_text" not in cols_pre
    assert "profile_status_expires_at" not in cols_pre

    # Open the store — runs migration.
    s = RegistryStore.open(data_dir)
    try:
        cols_post = {
            row[1]
            for row in s._conn.execute(  # noqa: SLF001
                "PRAGMA table_info(participants)"
            )
        }
    finally:
        s.close()
    assert "profile_status_emoji" in cols_post
    assert "profile_status_text" in cols_post
    assert "profile_status_expires_at" in cols_post
    assert SCHEMA_VERSION == 3


def test_schema_migration_v2_to_v3_idempotent_on_populated_db(tmp_path: Path):
    """Opening twice on the same v2-seeded DB must not raise or re-add columns."""
    data_dir = _seed_v2_db(tmp_path)
    s1 = RegistryStore.open(data_dir)
    s1.close()
    # Second open: no-op, schema_version stays at 3.
    s2 = RegistryStore.open(data_dir)
    try:
        row = s2._conn.execute(  # noqa: SLF001
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        assert row[0] == "3"
    finally:
        s2.close()


def test_schema_migration_pragma_before_after(tmp_path: Path):
    """End-to-end PRAGMA snapshot useful for worklog §3 smoke."""
    data_dir = _seed_v2_db(tmp_path)
    pre_conn = sqlite3.connect(str(data_dir / "registry.db"))
    try:
        pre_cols = [
            row[1] for row in pre_conn.execute("PRAGMA table_info(participants)")
        ]
    finally:
        pre_conn.close()
    s = RegistryStore.open(data_dir)
    try:
        post_cols = [
            row[1]
            for row in s._conn.execute(  # noqa: SLF001
                "PRAGMA table_info(participants)"
            )
        ]
    finally:
        s.close()
    # v2 had 5 cols; v3 adds 3.
    assert len(post_cols) - len(pre_cols) == 3
    assert set(post_cols) - set(pre_cols) == {
        "profile_status_emoji",
        "profile_status_text",
        "profile_status_expires_at",
    }


# ---------------------------------------------------------------------------
# 13: regression — existing comms_status_set still works after migration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_existing_comms_status_set_still_works_post_migration(
    tmp_path: Path,
):
    """The v0.4.0 ephemeral activity API must survive the v3 schema bump."""
    data_dir = _seed_v2_db(tmp_path)
    s = RegistryStore.open(data_dir)
    try:
        reg = ParticipantRegistry(store=s)
        key = await _join_claude(reg, name="acti-tester")
        res = await tool_comms_status_set(
            reg,
            key=key,
            conversation="general",
            label="thinking",
            ttl_seconds=30,
        )
        assert res["status"] == "set"
        assert res["label"] == "thinking"
        # The v0.4.0 contract: activity lands on every ConnectionInfo.
        p = reg.get(key)
        assert p.connections["mcp"].activity.label == "thinking"
    finally:
        s.close()
        # Reset the activity throttle so adjacent suites aren't affected.
        from claude_comms import mcp_tools as _mt

        _mt._activity_last_write.clear()


# ---------------------------------------------------------------------------
# 14: auto-expire sweep republishes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_auto_expire_sweep_clears_expired_and_republishes(
    registry: ParticipantRegistry,
):
    key = await _join_claude(registry)
    past_iso = (
        datetime.now(timezone.utc).astimezone() - timedelta(seconds=5)
    ).isoformat()
    await tool_comms_profile_status_set(
        registry, key=key, emoji="x", text="stale", expires_at=past_iso
    )
    publish_fn, captured = _capture_publish_fn()
    cleared = await auto_expire_profile_statuses_once(registry, publish_fn=publish_fn)
    assert key in cleared
    # At least one retained-clear publish per active connection.
    assert captured, "auto-expire produced no publishes"
    for entry in captured:
        body = json.loads(entry["payload"].decode())
        assert body["profile_status_emoji"] is None
        assert body["profile_status_text"] is None
        assert body["profile_status_expires_at"] is None
        assert entry["retain"] is True


# ---------------------------------------------------------------------------
# Bonus: distinct-storage proof — profile_status DOES NOT bleed into Activity
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_status_and_activity_are_independent(
    registry: ParticipantRegistry,
):
    """§I.18 rename invariant: setting profile_status doesn't touch Activity."""
    key = await _join_claude(registry)
    # Set an activity first.
    await tool_comms_status_set(
        registry,
        key=key,
        conversation="general",
        label="reading",
        ttl_seconds=60,
    )
    # Then set profile_status — must not clobber the activity.
    await tool_comms_profile_status_set(registry, key=key, emoji="x", text="durable")
    p = registry.get(key)
    assert p.profile_status_text == "durable"
    assert p.connections["mcp"].activity is not None
    assert p.connections["mcp"].activity.label == "reading"
    # Clean up the throttle so adjacent tests are unaffected.
    from claude_comms import mcp_tools as _mt

    _mt._activity_last_write.clear()
