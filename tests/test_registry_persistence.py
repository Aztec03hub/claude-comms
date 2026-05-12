"""End-to-end persistence tests: ``ParticipantRegistry`` + ``RegistryStore``.

Validates the bug-fix at the level the bug report manifested at: a
participant joins, the daemon "restarts" (simulated by tearing down the
registry + store and rebuilding them against the same DB), and the
participant's key + memberships + cursors are still recognized.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from claude_comms.broker import MessageStore
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_conversations,
    tool_comms_join,
)
from claude_comms.participant import ConnectionInfo
from claude_comms.registry_store import RegistryStore


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fresh_pair(tmp_path: Path) -> tuple[RegistryStore, ParticipantRegistry]:
    store = RegistryStore.open(tmp_path)
    return store, ParticipantRegistry(store=store)


def _simulate_restart(
    store: RegistryStore, tmp_path: Path
) -> tuple[RegistryStore, ParticipantRegistry]:
    """Close the store, reopen it, return a fresh registry bound to it."""
    store.close()
    new_store = RegistryStore.open(tmp_path)
    return new_store, ParticipantRegistry(store=new_store)


# ---------------------------------------------------------------------------
# Backward-compat: no store kwarg means pure in-memory (legacy behaviour)
# ---------------------------------------------------------------------------


def test_no_store_kwarg_is_pure_memory() -> None:
    """``ParticipantRegistry()`` without a store keeps the legacy contract."""
    r = ParticipantRegistry()
    p = r.join("alice", "general")
    assert r.get(p.key) is p
    # And there is no store wired up.
    assert r._store is None  # noqa: SLF001 — internal invariant the suite relies on


# ---------------------------------------------------------------------------
# Round-trip through restart
# ---------------------------------------------------------------------------


def test_participants_survive_restart(tmp_path: Path) -> None:
    store, reg = _fresh_pair(tmp_path)
    p1 = reg.join("alice", "general", participant_type="claude")
    p2 = reg.join("bob", "ops", participant_type="human")
    p1_key = p1.key
    p2_key = p2.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        assert reg.get(p1_key) is not None
        assert reg.get(p2_key) is not None
        assert reg.get(p1_key).name == "alice"
        assert reg.get(p1_key).type == "claude"
        assert reg.get(p2_key).type == "human"
    finally:
        store.close()


def test_memberships_survive_restart(tmp_path: Path) -> None:
    store, reg = _fresh_pair(tmp_path)
    p = reg.join("alice", "general")
    reg.join("alice", "ops", key=p.key)
    reg.join("alice", "secret", key=p.key)
    p_key = p.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        assert set(reg.conversations_for(p_key)) == {"general", "ops", "secret"}
    finally:
        store.close()


def test_leave_persists_across_restart(tmp_path: Path) -> None:
    store, reg = _fresh_pair(tmp_path)
    p = reg.join("alice", "general")
    reg.join("alice", "ops", key=p.key)
    assert reg.leave(p.key, "ops") is True
    p_key = p.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        assert set(reg.conversations_for(p_key)) == {"general"}
    finally:
        store.close()


def test_name_change_persists_across_restart(tmp_path: Path) -> None:
    store, reg = _fresh_pair(tmp_path)
    p = reg.join("alice", "general")
    reg.update_name(p.key, "alice_v2")
    p_key = p.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        assert reg.get(p_key).name == "alice_v2"
        # Name index should be rebuilt against the new name.
        assert reg.resolve_name("alice_v2") == p_key
        assert reg.resolve_name("alice") is None
    finally:
        store.close()


def test_read_cursor_persists_across_restart(tmp_path: Path) -> None:
    store, reg = _fresh_pair(tmp_path)
    p = reg.join("alice", "general")
    reg.update_cursor(p.key, "general", "2026-05-12T10:00:00Z")
    p_key = p.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        assert reg.get_cursor(p_key, "general") == "2026-05-12T10:00:00Z"
    finally:
        store.close()


def test_thread_cursor_persists_across_restart(tmp_path: Path) -> None:
    store, reg = _fresh_pair(tmp_path)
    p = reg.join("alice", "general")
    reg.update_thread_cursor(p.key, "general", "root-abc", "2026-05-12T10:00:00Z")
    reg.advance_thread_cursors_to(
        p.key,
        "general",
        {"root-xyz": "2026-05-12T11:00:00Z"},
    )
    p_key = p.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        assert reg.get_thread_cursor(p_key, "general", "root-abc") == (
            "2026-05-12T10:00:00Z"
        )
        assert reg.get_thread_cursor(p_key, "general", "root-xyz") == (
            "2026-05-12T11:00:00Z"
        )
    finally:
        store.close()


# ---------------------------------------------------------------------------
# Connections are NOT persisted (offline-on-startup discipline)
# ---------------------------------------------------------------------------


def test_connections_not_persisted_offline_on_startup(tmp_path: Path) -> None:
    """A participant who was online before restart comes back offline.

    Rehydrated participants always start with ``connections == {}`` so
    presence + ``_ensure_mcp_connection`` re-populate them organically on
    next interaction.
    """
    store, reg = _fresh_pair(tmp_path)
    p = reg.join("alice", "general")
    # Manually wire a connection — the synthetic MCP connection path does
    # this in real life via ``_ensure_mcp_connection``.
    p.connections["mcp"] = ConnectionInfo(
        client="mcp",
        instance_id=None,
        since="2026-05-12T10:00:00Z",
        last_seen="2026-05-12T10:00:00Z",
    )
    assert p.is_online is True
    p_key = p.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        rehydrated = reg.get(p_key)
        assert rehydrated is not None
        assert rehydrated.connections == {}
        assert rehydrated.is_online is False
    finally:
        store.close()


# ---------------------------------------------------------------------------
# Bug-report symptom verification (the marquee test)
# ---------------------------------------------------------------------------


def test_tool_comms_join_with_existing_key_after_restart(tmp_path: Path) -> None:
    """A standing Claude Code agent's key keeps working after restart.

    This is the exact symptom from the user's bug report: agent joins,
    receives key X, daemon restarts, agent calls ``comms_join(key=X)``
    expecting to be recognized.
    """
    store, reg = _fresh_pair(tmp_path)
    # First-time join — get assigned a key.
    join_result_1 = asyncio.run(
        tool_comms_join(reg, name="standing-agent", conversation="general")
    )
    assert join_result_1.get("status") == "joined"
    assigned_key = join_result_1["key"]

    # Simulate `claude-comms stop && start`.
    store, reg = _simulate_restart(store, tmp_path)
    try:
        # Agent re-joins with previously-assigned key. Before the fix this
        # returned an error because the in-memory registry was empty after
        # restart.
        join_result_2 = asyncio.run(
            tool_comms_join(reg, key=assigned_key, conversation="general")
        )
        assert join_result_2.get("status") == "joined", join_result_2
        assert join_result_2["key"] == assigned_key
        assert join_result_2["name"] == "standing-agent"
    finally:
        store.close()


def test_tool_comms_conversations_after_restart(tmp_path: Path) -> None:
    """``comms_conversations(key=X)`` reflects pre-restart memberships."""
    store, reg = _fresh_pair(tmp_path)
    p = reg.join("standing-agent", "general")
    reg.join("standing-agent", "ops", key=p.key)
    reg.join("standing-agent", "secret-channel", key=p.key)
    agent_key = p.key

    store, reg = _simulate_restart(store, tmp_path)
    try:
        msg_store = MessageStore()
        result = tool_comms_conversations(reg, msg_store, key=agent_key)
        # Tool returns {"conversations": [{"conversation": ..., ...}, ...]}.
        conv_names = {entry["conversation"] for entry in result["conversations"]}
        assert {"general", "ops", "secret-channel"} <= conv_names
    finally:
        store.close()
