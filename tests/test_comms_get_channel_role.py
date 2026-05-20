"""Tests for the v0.4.2 Step 3.6b ``tool_comms_get_channel_role`` MCP wrapper.

Thin wrapper over ``RegistryStore.get_channel_role`` (added by Step 3.0a).
The wrapper adds: (a) caller-authorization (must be a member of the
conversation), (b) optional ``target_participant_key`` switch (self vs.
other), and (c) the structured response envelope shape that the frontend
mqtt-store consumes for role reconciliation.

Tests by name (6 total):

1. test_self_query_default_no_target_arg
2. test_target_query_returns_other_role
3. test_non_member_caller_rejected
4. test_unknown_target_returns_default_member
5. test_post_3_0a_backfill_creator_returns_owner
6. test_invalid_conversation_id_rejected
"""

from __future__ import annotations

from pathlib import Path

import pytest

from claude_comms.conversation import create_conversation_atomic
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_get_channel_role,
)
from claude_comms.registry_store import RegistryStore


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> RegistryStore:
    """Fresh RegistryStore rooted at tmp_path."""
    s = RegistryStore.open(tmp_path)
    yield s
    s.close()


def _registry_with(store: RegistryStore) -> ParticipantRegistry:
    """ParticipantRegistry wired to the test's RegistryStore."""
    return ParticipantRegistry(store=store)


def _join(
    registry: ParticipantRegistry,
    name: str,
    conversation: str,
    *,
    key: str,
    participant_type: str = "claude",
) -> None:
    registry.join(name, conversation, key=key, participant_type=participant_type)


# ---------------------------------------------------------------------------
# 1. Self-query default (no target_participant_key arg)
# ---------------------------------------------------------------------------


def test_self_query_default_no_target_arg(store: RegistryStore, tmp_path: Path) -> None:
    """Calling with no target arg returns the caller's own role."""
    registry = _registry_with(store)
    _join(registry, "alice", "design", key="aaaaaaaa")
    store.set_channel_role("design", "aaaaaaaa", "owner")

    result = tool_comms_get_channel_role(
        registry, store, key="aaaaaaaa", conversation="design"
    )

    assert result == {
        "role": "owner",
        "participant_key": "aaaaaaaa",
        "conversation": "design",
    }


# ---------------------------------------------------------------------------
# 2. Target-query returns other's role
# ---------------------------------------------------------------------------


def test_target_query_returns_other_role(store: RegistryStore, tmp_path: Path) -> None:
    """Passing target_participant_key returns that target's role."""
    registry = _registry_with(store)
    _join(registry, "alice", "design", key="aaaaaaaa")
    _join(registry, "bob", "design", key="bbbbbbbb")
    store.set_channel_role("design", "aaaaaaaa", "owner")
    store.set_channel_role("design", "bbbbbbbb", "admin")

    # Alice queries bob's role.
    result = tool_comms_get_channel_role(
        registry,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_participant_key="bbbbbbbb",
    )

    assert result["role"] == "admin"
    assert result["participant_key"] == "bbbbbbbb"
    assert result["conversation"] == "design"


# ---------------------------------------------------------------------------
# 3. Non-member caller rejected
# ---------------------------------------------------------------------------


def test_non_member_caller_rejected(store: RegistryStore, tmp_path: Path) -> None:
    """Caller who is not a member of the conversation gets an error envelope."""
    registry = _registry_with(store)
    # Alice exists but only in "general", not in "design".
    _join(registry, "alice", "general", key="aaaaaaaa")
    _join(registry, "bob", "design", key="bbbbbbbb")
    store.set_channel_role("design", "bbbbbbbb", "owner")

    result = tool_comms_get_channel_role(
        registry, store, key="aaaaaaaa", conversation="design"
    )

    assert result.get("error") is True
    assert "not a member" in result["message"].lower()


# ---------------------------------------------------------------------------
# 4. Unknown target returns default 'member'
# ---------------------------------------------------------------------------


def test_unknown_target_returns_default_member(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Target key with no explicit role row reads as the default 'member'.

    The wrapper preserves 3.0a's default-safe semantics: an unseen
    (conversation, target_key) pair returns ``'member'`` rather than
    erroring. Only caller-authorization or invalid input errors out.
    """
    registry = _registry_with(store)
    _join(registry, "alice", "design", key="aaaaaaaa")
    # No role row seeded for "deadbeef".

    result = tool_comms_get_channel_role(
        registry,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_participant_key="deadbeef",
    )

    assert result["role"] == "member"
    assert result["participant_key"] == "deadbeef"


# ---------------------------------------------------------------------------
# 5. Post-3.0a backfill: creator returns 'owner'
# ---------------------------------------------------------------------------


def test_post_3_0a_backfill_creator_returns_owner(tmp_path: Path) -> None:
    """A channel whose creator was backfilled at 1->2 migration reads as owner.

    Mirrors the 3.0a fixture pattern: seed a v1-shaped DB with a known
    participant + a conversation pointing to them by display name, then
    open via ``RegistryStore.open`` to trigger the backfill, then verify
    that the wrapper surfaces the backfilled owner role.
    """
    import sqlite3
    from claude_comms.registry_store import _SCHEMA_DDL

    # Seed v1-only DB (strip the conversation_roles block).
    db_path = tmp_path / "registry.db"
    conn = sqlite3.connect(str(db_path))
    try:
        v1_only = _SCHEMA_DDL.split("CREATE TABLE IF NOT EXISTS conversation_roles")[0]
        conn.executescript(v1_only)
        conn.execute(
            "INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)",
            ("schema_version", "1"),
        )
        conn.execute(
            "INSERT INTO participants (key, name, type, created_at, last_seen) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                "1234abcd",
                "claude",
                "claude",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )
        # Seed a membership row so the rehydrated registry recognises the
        # caller as a member of "general" (the wrapper checks membership
        # via ``registry.conversations_for``).
        conn.execute(
            "INSERT INTO conversation_members "
            "(participant_key, conversation, joined_at) VALUES (?, ?, ?)",
            ("1234abcd", "general", "2026-01-01T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    # Seed a conversation meta on disk with created_by='claude' so backfill
    # has something to grandfather.
    meta = create_conversation_atomic(
        name="general",
        topic="Main lobby",
        created_by="claude",
        data_dir=tmp_path,
    )
    assert meta is not None

    # Open RegistryStore => triggers 1->latest migration including the
    # creator-grandfather backfill.
    store = RegistryStore.open(tmp_path)
    try:
        registry = ParticipantRegistry(store=store)
        # The backfilled creator should now be owner of 'general'.
        result = tool_comms_get_channel_role(
            registry, store, key="1234abcd", conversation="general"
        )
        assert result["role"] == "owner"
        assert result["participant_key"] == "1234abcd"
        assert result["conversation"] == "general"
    finally:
        store.close()


# ---------------------------------------------------------------------------
# 6. Invalid conversation id rejected
# ---------------------------------------------------------------------------


def test_invalid_conversation_id_rejected(store: RegistryStore, tmp_path: Path) -> None:
    """Malformed conversation id returns an error envelope."""
    registry = _registry_with(store)
    _join(registry, "alice", "design", key="aaaaaaaa")

    result = tool_comms_get_channel_role(
        registry,
        store,
        key="aaaaaaaa",
        conversation="!!!bad!!!",
    )

    assert result.get("error") is True
    assert "invalid conversation" in result["message"].lower()
