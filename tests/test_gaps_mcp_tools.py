"""Gap tests for mcp_tools.py.

Covers:
- Token-aware pagination edge cases (single huge message, boundary)
- Very long messages
- Concurrent registry operations
- comms_read count clamping
- comms_history with count clamping and token truncation
- comms_send with invalid conversation
- comms_leave with invalid conversation
- Registry resolve_recipients with unknown names
"""

from __future__ import annotations

import json
import threading

import pytest

from claude_comms.broker import MessageStore
from claude_comms.mcp_tools import (
    MAX_OUTPUT_CHARS,
    ParticipantRegistry,
    tool_comms_check,
    tool_comms_conversations,
    tool_comms_history,
    tool_comms_join,
    tool_comms_leave,
    tool_comms_members,
    tool_comms_read,
    tool_comms_send,
    tool_comms_update_name,
)


# --- Token-aware pagination edge cases ---


class TestTokenPaginationEdgeCases:
    def test_single_message_exceeding_limit(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        """A single message larger than MAX_OUTPUT_CHARS should still be returned."""
        huge_body = "x" * (MAX_OUTPUT_CHARS + 1000)
        store.add("general", {
            "id": "huge-1",
            "ts": "2026-03-13T10:00:00-05:00",
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": huge_body,
            "conv": "general",
        })
        result = tool_comms_read(
            registry, store, key=sample_participant["key"], conversation="general"
        )
        # Must return at least one message even if it exceeds the limit
        assert result["count"] >= 1

    def test_pagination_returns_most_recent(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        """When truncated, should keep the most recent messages."""
        for i in range(50):
            store.add("general", {
                "id": f"pag-{i:04d}",
                "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                "body": "y" * 5000,
                "conv": "general",
            })
        result = tool_comms_read(
            registry, store, key=sample_participant["key"], conversation="general", count=50
        )
        # Last message in result should be the most recent
        if result["messages"]:
            last_id = result["messages"][-1]["id"]
            assert last_id == "pag-0049"

    def test_history_token_truncation(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        """comms_history should also respect token limits."""
        for i in range(100):
            store.add("general", {
                "id": f"hist-{i}",
                "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                "body": "z" * 2000,
                "conv": "general",
            })
        result = tool_comms_history(
            registry, store, key=sample_participant["key"],
            conversation="general", count=200,
        )
        assert result["count"] < 100
        assert result["has_more"] is True


# --- Count clamping ---


class TestCountClamping:
    def test_read_count_clamped_to_min(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        """count=0 should be clamped to 1."""
        store.add("general", {
            "id": "clamp-1",
            "ts": "2026-03-13T10:00:00-05:00",
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": "hi",
            "conv": "general",
        })
        result = tool_comms_read(
            registry, store, key=sample_participant["key"],
            conversation="general", count=0,
        )
        assert result["count"] == 1

    def test_read_count_clamped_to_max(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        """count=999 should be clamped to 200."""
        for i in range(5):
            store.add("general", {
                "id": f"cmax-{i}",
                "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                "body": "hi",
                "conv": "general",
            })
        result = tool_comms_read(
            registry, store, key=sample_participant["key"],
            conversation="general", count=999,
        )
        # Should not crash, returns all 5
        assert result["count"] == 5

    def test_history_count_clamped_to_min(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        store.add("general", {
            "id": "hclamp-1",
            "ts": "2026-03-13T10:00:00-05:00",
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": "hi",
            "conv": "general",
        })
        result = tool_comms_history(
            registry, store, key=sample_participant["key"],
            conversation="general", count=-5,
        )
        assert result["count"] == 1


# --- comms_send edge cases ---


class TestCommsSendEdgeCases:
    @pytest.mark.asyncio
    async def test_send_invalid_conversation(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
        publish_spy,
    ):
        result = await tool_comms_send(
            registry, publish_spy,
            key=sample_participant["key"],
            conversation="INVALID!!",
            message="hello",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_send_very_long_message(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
        publish_spy,
    ):
        """Very long message should succeed (no length limit in tool)."""
        long_msg = "A" * 100_000
        result = await tool_comms_send(
            registry, publish_spy,
            key=sample_participant["key"],
            conversation="general",
            message=long_msg,
        )
        assert result["status"] == "sent"
        _, payload = publish_spy.last_call
        parsed = json.loads(payload)
        assert len(parsed["body"]) == 100_000


# --- comms_leave edge cases ---


class TestCommsLeaveEdgeCases:
    def test_leave_invalid_conversation_id(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
    ):
        result = tool_comms_leave(
            registry, key=sample_participant["key"], conversation="BAD!"
        )
        assert result.get("error") is True

    def test_leave_with_invalid_key_format(self, registry: ParticipantRegistry):
        result = tool_comms_leave(registry, key="ZZZZZZZZ", conversation="general")
        assert result.get("error") is True


# --- Registry concurrent operations ---


class TestRegistryConcurrency:
    def test_concurrent_joins(self, registry: ParticipantRegistry):
        """Multiple threads joining simultaneously should not corrupt state."""
        results = {}
        errors = []

        def join_thread(name, conv):
            try:
                r = tool_comms_join(registry, name=name, conversation=conv)
                results[name] = r
            except Exception as e:
                errors.append(e)

        threads = []
        for i in range(20):
            t = threading.Thread(target=join_thread, args=(f"user{i}", "general"))
            threads.append(t)

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        assert len(results) == 20
        # Each should have a unique key
        keys = {r["key"] for r in results.values()}
        assert len(keys) == 20


# --- Registry resolve_recipients edge cases ---


class TestResolveRecipientsEdgeCases:
    def test_resolve_unknown_name_dropped(self, registry: ParticipantRegistry):
        tool_comms_join(registry, name="alice", conversation="general")
        resolved = registry.resolve_recipients(["alice", "nonexistent"])
        assert len(resolved) == 1

    def test_resolve_empty_list(self, registry: ParticipantRegistry):
        resolved = registry.resolve_recipients([])
        assert resolved == []

    def test_resolve_all_unknown(self, registry: ParticipantRegistry):
        resolved = registry.resolve_recipients(["ghost1", "ghost2"])
        assert resolved == []


# --- comms_check edge cases ---


class TestCommsCheckEdgeCases:
    def test_check_after_read_cursor_update(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        """After reading, check should show 0 unread."""
        store.add("general", {
            "id": "chk-1",
            "ts": "2026-03-13T10:00:00-05:00",
            "sender": {"key": "other123", "name": "other", "type": "claude"},
            "body": "Hi",
            "conv": "general",
        })
        # Read to update cursor
        tool_comms_read(
            registry, store, key=sample_participant["key"], conversation="general"
        )
        result = tool_comms_check(
            registry, store, key=sample_participant["key"]
        )
        assert result["total_unread"] == 0

    def test_check_invalid_key(
        self, registry: ParticipantRegistry, store: MessageStore
    ):
        result = tool_comms_check(registry, store, key="ZZZZZZZZ")
        assert result.get("error") is True
