"""Tests for threaded replies — read-side surface (plans/threaded-replies-plan §11 phoenix).

Covers:
- ``tool_comms_read`` ``top_level_only=True`` filter and ``thread_summary`` decoration.
- ``tool_comms_thread_read`` (new tool): root always populated, replies filtering,
  visibility, since/count clamps, per-thread cursor advance.
- ``tool_comms_check`` ``thread_unread`` accounting and per-thread cursor advance
  under ``mark_seen=True``.
- ``ParticipantRegistry`` per-thread cursor methods (``update_thread_cursor`` /
  ``get_thread_cursor`` / ``thread_cursors_for`` / ``advance_thread_cursors_to``).
- Per-thread MQTT fanout topic published from ``tool_comms_send`` on reply.

These tests exercise only in-memory store + registry — no live MQTT broker.
"""

from __future__ import annotations

import pytest

from claude_comms.broker import MessageStore
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_check,
    tool_comms_read,
    tool_comms_send,
    tool_comms_thread_read,
)


# ---------------------------------------------------------------------------
# Registry per-thread cursor methods
# ---------------------------------------------------------------------------


class TestThreadCursorMethods:
    def test_set_get_roundtrip(self) -> None:
        r = ParticipantRegistry()
        r.update_thread_cursor("aaaa1111", "general", "rootid", "2026-05-07T10:00:00Z")
        assert (
            r.get_thread_cursor("aaaa1111", "general", "rootid")
            == "2026-05-07T10:00:00Z"
        )

    def test_get_missing_returns_none(self) -> None:
        r = ParticipantRegistry()
        assert r.get_thread_cursor("aaaa1111", "general", "rootid") is None

    def test_keyspace_isolation_per_root(self) -> None:
        r = ParticipantRegistry()
        r.update_thread_cursor("aaaa1111", "general", "root-A", "2026-01-01T00:00:00Z")
        r.update_thread_cursor("aaaa1111", "general", "root-B", "2026-02-02T00:00:00Z")
        assert (
            r.get_thread_cursor("aaaa1111", "general", "root-A")
            == "2026-01-01T00:00:00Z"
        )
        assert (
            r.get_thread_cursor("aaaa1111", "general", "root-B")
            == "2026-02-02T00:00:00Z"
        )

    def test_keyspace_isolation_per_user(self) -> None:
        r = ParticipantRegistry()
        r.update_thread_cursor("aaaa1111", "general", "root", "2026-01-01T00:00:00Z")
        r.update_thread_cursor("bbbb2222", "general", "root", "2026-02-02T00:00:00Z")
        assert r.get_thread_cursor(
            "aaaa1111", "general", "root"
        ) != r.get_thread_cursor("bbbb2222", "general", "root")

    def test_thread_cursors_for_returns_only_users_threads_in_conv(self) -> None:
        r = ParticipantRegistry()
        r.update_thread_cursor("aaaa1111", "general", "root-A", "t1")
        r.update_thread_cursor("aaaa1111", "general", "root-B", "t2")
        r.update_thread_cursor("aaaa1111", "other", "root-C", "t3")
        r.update_thread_cursor("bbbb2222", "general", "root-D", "t4")
        result = r.thread_cursors_for("aaaa1111", "general")
        assert result == {"root-A": "t1", "root-B": "t2"}

    def test_advance_thread_cursors_to_bulk(self) -> None:
        r = ParticipantRegistry()
        r.advance_thread_cursors_to(
            "aaaa1111",
            "general",
            {"root-A": "ts-1", "root-B": "ts-2"},
        )
        assert r.get_thread_cursor("aaaa1111", "general", "root-A") == "ts-1"
        assert r.get_thread_cursor("aaaa1111", "general", "root-B") == "ts-2"


# ---------------------------------------------------------------------------
# tool_comms_read top_level_only + thread_summary
# ---------------------------------------------------------------------------


@pytest.fixture
def stocked() -> tuple[ParticipantRegistry, MessageStore, str]:
    """Registry + store + a registered participant key joined to ``general``,
    pre-populated with one root + two replies.
    """
    registry = ParticipantRegistry()
    store = MessageStore()
    p = registry.join("ember", "general")
    root = {
        "id": "root-1",
        "ts": "2026-05-07T10:00:00Z",
        "sender": {"key": p.key, "name": "ember", "type": "claude"},
        "body": "kicking off the thread",
        "conv": "general",
        "recipients": None,
        "mentions": None,
        "reply_to": None,
        "thread_reply_count": 2,
        "thread_last_ts": "2026-05-07T10:02:00Z",
        "thread_last_author": "phoenix",
        "thread_participants": [p.key, "phxx0001"],
    }
    reply_1 = {
        "id": "reply-1",
        "ts": "2026-05-07T10:01:00Z",
        "sender": {"key": "phxx0001", "name": "phoenix", "type": "claude"},
        "body": "first reply",
        "conv": "general",
        "recipients": None,
        "mentions": None,
        "reply_to": "root-1",
        "thread_root_id": "root-1",
    }
    reply_2 = {
        "id": "reply-2",
        "ts": "2026-05-07T10:02:00Z",
        "sender": {"key": "phxx0001", "name": "phoenix", "type": "claude"},
        "body": "second reply",
        "conv": "general",
        "recipients": None,
        "mentions": None,
        "reply_to": "root-1",
        "thread_root_id": "root-1",
    }
    store.add("general", root)
    store.add("general", reply_1)
    store.add("general", reply_2)
    return registry, store, p.key


class TestCommsReadTopLevelOnly:
    def test_default_returns_all_messages(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        result = tool_comms_read(
            registry, store, key=key, conversation="general", count=10
        )
        ids = [m["id"] for m in result["messages"]]
        # No top_level_only → firehose, all three messages.
        assert ids == ["root-1", "reply-1", "reply-2"]
        # No decoration on default path.
        assert "thread_summary" not in result["messages"][0]

    def test_top_level_only_filters_replies(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        result = tool_comms_read(
            registry,
            store,
            key=key,
            conversation="general",
            count=10,
            top_level_only=True,
        )
        ids = [m["id"] for m in result["messages"]]
        assert ids == ["root-1"]

    def test_top_level_only_decorates_with_thread_summary(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        result = tool_comms_read(
            registry,
            store,
            key=key,
            conversation="general",
            count=10,
            top_level_only=True,
        )
        root = result["messages"][0]
        assert root["thread_summary"] == {
            "reply_count": 2,
            "last_ts": "2026-05-07T10:02:00Z",
            "last_author": "phoenix",
        }

    def test_top_level_only_does_not_mutate_store_dict(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        tool_comms_read(
            registry,
            store,
            key=key,
            conversation="general",
            count=10,
            top_level_only=True,
        )
        live = store.find_by_id("general", "root-1")
        assert live is not None
        # Decoration must not write thread_summary onto the live dict.
        assert "thread_summary" not in live

    def test_top_level_only_skips_decoration_for_childless_root(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        p = registry.join("ember", "general")
        plain = {
            "id": "plain-1",
            "ts": "2026-05-07T10:00:00Z",
            "sender": {"key": p.key, "name": "ember", "type": "claude"},
            "body": "no replies yet",
            "conv": "general",
            "recipients": None,
            "mentions": None,
            "reply_to": None,
        }
        store.add("general", plain)
        result = tool_comms_read(
            registry,
            store,
            key=p.key,
            conversation="general",
            count=10,
            top_level_only=True,
        )
        assert "thread_summary" not in result["messages"][0]


# ---------------------------------------------------------------------------
# tool_comms_thread_read
# ---------------------------------------------------------------------------


class TestCommsThreadRead:
    def test_returns_root_and_replies(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        result = tool_comms_thread_read(
            registry, store, key=key, conversation="general", root_id="root-1"
        )
        assert result["root"]["id"] == "root-1"
        reply_ids = [r["id"] for r in result["replies"]]
        assert reply_ids == ["reply-1", "reply-2"]

    def test_unknown_root_errors(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        result = tool_comms_thread_read(
            registry, store, key=key, conversation="general", root_id="nope"
        )
        assert result.get("error") is True

    def test_root_always_returned_even_with_since_excluding_all(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        # Since after every reply ts → replies empty, but root must remain.
        result = tool_comms_thread_read(
            registry,
            store,
            key=key,
            conversation="general",
            root_id="root-1",
            since="2026-05-07T11:00:00Z",
        )
        assert result["root"]["id"] == "root-1"
        assert result["replies"] == []

    def test_since_filters_replies(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        # Since right between reply-1 and reply-2 → only reply-2 returned.
        result = tool_comms_thread_read(
            registry,
            store,
            key=key,
            conversation="general",
            root_id="root-1",
            since="2026-05-07T10:01:30Z",
        )
        reply_ids = [r["id"] for r in result["replies"]]
        assert reply_ids == ["reply-2"]

    def test_advances_per_thread_cursor(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        assert registry.get_thread_cursor(key, "general", "root-1") is None
        tool_comms_thread_read(
            registry, store, key=key, conversation="general", root_id="root-1"
        )
        assert (
            registry.get_thread_cursor(key, "general", "root-1")
            == "2026-05-07T10:02:00Z"
        )

    def test_invisible_root_is_treated_as_not_found(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        ember = registry.join("ember", "general")
        sage = registry.join("sage", "general")
        # Whisper-root targeted to ember only — sage cannot see it.
        whisper_root = {
            "id": "whisper-1",
            "ts": "2026-05-07T10:00:00Z",
            "sender": {"key": ember.key, "name": "ember", "type": "claude"},
            "body": "private",
            "conv": "general",
            "recipients": [ember.key],
            "mentions": None,
            "reply_to": None,
        }
        store.add("general", whisper_root)
        # Sage tries to read the thread.
        result = tool_comms_thread_read(
            registry, store, key=sage.key, conversation="general", root_id="whisper-1"
        )
        assert result.get("error") is True


# ---------------------------------------------------------------------------
# tool_comms_check thread_unread
# ---------------------------------------------------------------------------


class TestCommsCheckThreadUnread:
    def test_thread_unread_counts_replies_after_cursor(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        result = tool_comms_check(registry, store, key=key, conversation="general")
        # Two replies, no per-thread cursor → both unread.
        entry = result["conversations"][0]
        assert entry["thread_unread"] == {"root-1": 2}

    def test_thread_unread_excludes_replies_before_cursor(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        # Set the per-thread cursor past reply-1 → only reply-2 unread.
        registry.update_thread_cursor(key, "general", "root-1", "2026-05-07T10:01:30Z")
        result = tool_comms_check(registry, store, key=key, conversation="general")
        entry = result["conversations"][0]
        assert entry["thread_unread"] == {"root-1": 1}

    def test_thread_unread_zero_when_caught_up(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        # Cursor past all replies.
        registry.update_thread_cursor(key, "general", "root-1", "2026-05-07T11:00:00Z")
        # Also ack the per-conv cursor so total_unread drops to 0.
        registry.update_cursor(key, "general", "2026-05-07T11:00:00Z")
        result = tool_comms_check(registry, store, key=key, conversation="general")
        # No unread → conv may not appear at all, or appear with no
        # thread_unread key.
        assert result["total_unread"] == 0
        for entry in result["conversations"]:
            assert entry.get("thread_unread", {}) == {}

    def test_mark_seen_advances_per_thread_cursors(
        self, stocked: tuple[ParticipantRegistry, MessageStore, str]
    ) -> None:
        registry, store, key = stocked
        result = tool_comms_check(
            registry, store, key=key, conversation="general", mark_seen=True
        )
        # PRE-advance count surfaces in response.
        entry = result["conversations"][0]
        assert entry["thread_unread"] == {"root-1": 2}
        # Per-thread cursor now sits at the latest reply ts.
        assert (
            registry.get_thread_cursor(key, "general", "root-1")
            == "2026-05-07T10:02:00Z"
        )
        # Subsequent check should report zero thread_unread.
        result2 = tool_comms_check(registry, store, key=key, conversation="general")
        for e in result2["conversations"]:
            assert e.get("thread_unread", {}) == {}


# ---------------------------------------------------------------------------
# Per-thread MQTT fanout topic
# ---------------------------------------------------------------------------


class TestPerThreadMQTTFanout:
    @pytest.mark.asyncio
    async def test_send_reply_publishes_to_both_topics(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        ember = registry.join("ember", "general")
        # Pre-existing root.
        root = {
            "id": "root-1",
            "ts": "2026-05-07T10:00:00Z",
            "sender": {"key": ember.key, "name": "ember", "type": "claude"},
            "body": "root",
            "conv": "general",
            "recipients": None,
            "mentions": None,
            "reply_to": None,
        }
        store.add("general", root)

        published: list[tuple[str, bytes]] = []

        async def capture(topic: str, payload: bytes) -> None:
            published.append((topic, payload))

        result = await tool_comms_send(
            registry,
            capture,
            store,
            key=ember.key,
            conversation="general",
            message="my reply",
            reply_to="root-1",
        )
        assert result["status"] == "sent"
        topics = [t for t, _ in published]
        assert "claude-comms/conv/general/messages" in topics
        assert "claude-comms/conv/general/threads/root-1" in topics
        # Same payload on both — clients dedup by message id.
        payload_msgs = {t: p for t, p in published}
        assert (
            payload_msgs["claude-comms/conv/general/messages"]
            == payload_msgs["claude-comms/conv/general/threads/root-1"]
        )

    @pytest.mark.asyncio
    async def test_send_top_level_message_does_not_publish_thread_topic(
        self,
    ) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        ember = registry.join("ember", "general")
        published: list[tuple[str, bytes]] = []

        async def capture(topic: str, payload: bytes) -> None:
            published.append((topic, payload))

        await tool_comms_send(
            registry,
            capture,
            store,
            key=ember.key,
            conversation="general",
            message="just a top-level",
        )
        topics = [t for t, _ in published]
        assert topics == ["claude-comms/conv/general/messages"]
