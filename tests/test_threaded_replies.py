"""Tests for threaded replies — server-lane (plans/threaded-replies-plan §11 ember).

Covers:
- ``tool_comms_send`` ``reply_to`` validation (parent-exists, depth-2, no-system-parent).
- ``MessageStore.find_by_id`` and ``MessageStore.update_thread_metadata``.
- JSONL replay second-pass thread-metadata recompute via
  ``broker._rebuild_thread_metadata``.

These tests deliberately avoid the broker-dispatcher integration (which lives
in the MQTT loop in ``mcp_server.py`` and requires the live broker). The
dispatcher logic mirrors ``_rebuild_thread_metadata``, which IS covered here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_comms.broker import (
    MessageStore,
    _rebuild_thread_metadata,
    replay_jsonl_logs,
)
from claude_comms.mcp_tools import ParticipantRegistry, tool_comms_send


# ---------------------------------------------------------------------------
# MessageStore extensions
# ---------------------------------------------------------------------------


class TestMessageStoreThreadHelpers:
    def test_find_by_id_present(self) -> None:
        store = MessageStore()
        msg = {"id": "m1", "conv": "general", "body": "hi", "sender": {}}
        store.add("general", msg)
        found = store.find_by_id("general", "m1")
        assert found is msg  # live reference, not a copy

    def test_find_by_id_absent(self) -> None:
        store = MessageStore()
        assert store.find_by_id("general", "missing") is None

    def test_find_by_id_wrong_conv(self) -> None:
        store = MessageStore()
        store.add("general", {"id": "m1"})
        assert store.find_by_id("other", "m1") is None

    def test_update_thread_metadata_sets_count_and_ts(self) -> None:
        store = MessageStore()
        root = {"id": "r1", "conv": "general", "sender": {}}
        store.add("general", root)
        ok = store.update_thread_metadata(
            "general", "r1", reply_count=1, last_ts="2026-05-07T12:00:00Z"
        )
        assert ok is True
        assert root["thread_reply_count"] == 1
        assert root["thread_last_ts"] == "2026-05-07T12:00:00Z"

    def test_update_thread_metadata_appends_participants_dedup(self) -> None:
        store = MessageStore()
        root = {"id": "r1", "conv": "general", "thread_participants": ["aaaa1111"]}
        store.add("general", root)
        store.update_thread_metadata(
            "general", "r1", add_participants=["bbbb2222", "aaaa1111", "cccc3333"]
        )
        assert root["thread_participants"] == [
            "aaaa1111",
            "bbbb2222",
            "cccc3333",
        ]

    def test_update_thread_metadata_missing_root(self) -> None:
        store = MessageStore()
        assert store.update_thread_metadata("general", "nope", reply_count=1) is False


# ---------------------------------------------------------------------------
# tool_comms_send reply_to validation
# ---------------------------------------------------------------------------


@pytest.fixture
def registered() -> tuple[ParticipantRegistry, MessageStore, str]:
    """Registry + store + a participant key joined to ``general``."""
    registry = ParticipantRegistry()
    store = MessageStore()
    p = registry.join("ember", "general")
    return registry, store, p.key


async def _publish(topic: str, payload: bytes, retain: bool = False) -> None:  # pyright: ignore[reportUnusedParameter]
    return None


@pytest.mark.asyncio
async def test_send_with_reply_to_unknown_parent_errors(
    registered: tuple[ParticipantRegistry, MessageStore, str],
) -> None:
    registry, store, key = registered
    result = await tool_comms_send(
        registry,
        _publish,
        store,
        key=key,
        conversation="general",
        message="hello",
        reply_to="does-not-exist",
    )
    assert result.get("error") is True
    assert "unknown" in result["message"].lower()


@pytest.mark.asyncio
async def test_send_with_reply_to_depth2_errors(
    registered: tuple[ParticipantRegistry, MessageStore, str],
) -> None:
    registry, store, key = registered
    # Seed a top-level + a reply
    store.add(
        "general",
        {
            "id": "root1",
            "conv": "general",
            "reply_to": None,
            "sender": {"key": key, "type": "claude"},
        },
    )
    store.add(
        "general",
        {
            "id": "reply1",
            "conv": "general",
            "reply_to": "root1",
            "sender": {"key": key, "type": "claude"},
        },
    )
    # Now try to reply to the reply -> should reject as depth-2 violation
    result = await tool_comms_send(
        registry,
        _publish,
        store,
        key=key,
        conversation="general",
        message="nested",
        reply_to="reply1",
    )
    assert result.get("error") is True
    assert "depth" in result["message"].lower()


@pytest.mark.asyncio
async def test_send_with_reply_to_system_parent_errors(
    registered: tuple[ParticipantRegistry, MessageStore, str],
) -> None:
    registry, store, key = registered
    store.add(
        "general",
        {
            "id": "sys1",
            "conv": "general",
            "reply_to": None,
            "sender": {"key": "00000000", "name": "system", "type": "system"},
        },
    )
    result = await tool_comms_send(
        registry,
        _publish,
        store,
        key=key,
        conversation="general",
        message="reply to system",
        reply_to="sys1",
    )
    assert result.get("error") is True
    assert "system" in result["message"].lower()


@pytest.mark.asyncio
async def test_send_with_valid_reply_to_succeeds(
    registered: tuple[ParticipantRegistry, MessageStore, str],
) -> None:
    registry, store, key = registered
    store.add(
        "general",
        {
            "id": "root1",
            "conv": "general",
            "reply_to": None,
            "sender": {"key": key, "name": "ember", "type": "claude"},
        },
    )
    result = await tool_comms_send(
        registry,
        _publish,
        store,
        key=key,
        conversation="general",
        message="thread reply",
        reply_to="root1",
    )
    assert result.get("status") == "sent"
    assert result.get("reply_to") == "root1"


@pytest.mark.asyncio
async def test_send_without_store_skips_validation(
    registered: tuple[ParticipantRegistry, MessageStore, str],
) -> None:
    """Legacy call path (no store passed) should not crash on reply_to."""
    registry, _store, key = registered
    result = await tool_comms_send(
        registry,
        _publish,
        # no store
        key=key,
        conversation="general",
        message="hi",
        reply_to="anything",
    )
    # No validation possible without store; send still goes through.
    assert result.get("status") == "sent"


# ---------------------------------------------------------------------------
# JSONL replay second-pass thread-metadata recompute
# ---------------------------------------------------------------------------


def _write_jsonl(path: Path, messages: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for m in messages:
            fh.write(json.dumps(m) + "\n")


def test_rebuild_thread_metadata_idempotent() -> None:
    store = MessageStore()
    store.add(
        "general",
        {
            "id": "r1",
            "conv": "general",
            "reply_to": None,
            "sender": {"key": "aaaa1111"},
        },
    )
    store.add(
        "general",
        {
            "id": "p1",
            "conv": "general",
            "reply_to": "r1",
            "sender": {"key": "bbbb2222", "name": "phoenix"},
            "ts": "T1",
        },
    )
    store.add(
        "general",
        {
            "id": "p2",
            "conv": "general",
            "reply_to": "r1",
            "sender": {"key": "cccc3333", "name": "sage"},
            "ts": "T2",
        },
    )
    _rebuild_thread_metadata(store)
    root = store.find_by_id("general", "r1")
    assert root["thread_reply_count"] == 2
    assert root["thread_last_ts"] == "T2"
    assert root["thread_last_author"] == "sage"
    assert set(root["thread_participants"]) == {"bbbb2222", "cccc3333"}
    # Idempotency: second call yields same state.
    _rebuild_thread_metadata(store)
    root2 = store.find_by_id("general", "r1")
    assert root2["thread_reply_count"] == 2
    assert root2["thread_last_ts"] == "T2"
    assert set(root2["thread_participants"]) == {"bbbb2222", "cccc3333"}


def test_rebuild_thread_metadata_includes_mentions() -> None:
    store = MessageStore()
    store.add(
        "general",
        {
            "id": "r1",
            "conv": "general",
            "reply_to": None,
            "sender": {"key": "aaaa1111"},
        },
    )
    store.add(
        "general",
        {
            "id": "p1",
            "conv": "general",
            "reply_to": "r1",
            "sender": {"key": "bbbb2222"},
            "mentions": ["dddd4444"],
            "ts": "T1",
        },
    )
    _rebuild_thread_metadata(store)
    root = store.find_by_id("general", "r1")
    assert root["thread_reply_count"] == 1
    assert "bbbb2222" in root["thread_participants"]
    assert "dddd4444" in root["thread_participants"]


def test_rebuild_thread_metadata_orphan_reply_skipped() -> None:
    store = MessageStore()
    # Reply with no root in the store — should not crash, should not aggregate.
    store.add(
        "general",
        {
            "id": "p1",
            "conv": "general",
            "reply_to": "missing-root",
            "sender": {"key": "bbbb2222"},
            "ts": "T1",
        },
    )
    _rebuild_thread_metadata(store)
    # No root to update; just verify no exception and the orphan is unmodified
    # apart from the absent thread_root_id stamp.
    assert store.find_by_id("general", "p1") is not None


def test_rebuild_thread_metadata_stamps_thread_root_id_on_replies() -> None:
    store = MessageStore()
    store.add(
        "general",
        {
            "id": "r1",
            "conv": "general",
            "reply_to": None,
            "sender": {"key": "aaaa1111"},
        },
    )
    store.add(
        "general",
        {
            "id": "p1",
            "conv": "general",
            "reply_to": "r1",
            "sender": {"key": "bbbb2222"},
            "ts": "T1",
        },
    )
    _rebuild_thread_metadata(store)
    reply = store.find_by_id("general", "p1")
    assert reply["thread_root_id"] == "r1"


def test_replay_jsonl_logs_runs_thread_metadata_pass(tmp_path: Path) -> None:
    log = tmp_path / "general.jsonl"
    _write_jsonl(
        log,
        [
            {
                "id": "r1",
                "conv": "general",
                "reply_to": None,
                "sender": {"key": "aaaa1111"},
                "ts": "T0",
            },
            {
                "id": "p1",
                "conv": "general",
                "reply_to": "r1",
                "sender": {"key": "bbbb2222"},
                "ts": "T1",
            },
            {
                "id": "p2",
                "conv": "general",
                "reply_to": "r1",
                "sender": {"key": "cccc3333"},
                "ts": "T2",
            },
        ],
    )
    store = replay_jsonl_logs(tmp_path)
    root = store.find_by_id("general", "r1")
    assert root["thread_reply_count"] == 2
    assert root["thread_last_ts"] == "T2"
    assert set(root["thread_participants"]) == {"bbbb2222", "cccc3333"}
