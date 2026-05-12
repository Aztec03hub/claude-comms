"""Tests for MCP tool logic (claude_comms.mcp_tools).

These tests exercise the pure tool functions directly, without running
the MCP server or MQTT broker.  Fixtures from ``conftest.py`` provide
the shared state objects.
"""

from __future__ import annotations

import json

import pytest

from claude_comms.broker import MessageStore
from claude_comms.mcp_server import _publish_archive_event
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_check,
    tool_comms_conversation_create,
    tool_comms_conversation_delete,
    tool_comms_conversations,
    tool_comms_history,
    tool_comms_join,
    tool_comms_leave,
    tool_comms_members,
    tool_comms_read,
    tool_comms_send,
    tool_comms_update_name,
)


# ===================================================================
# comms_join
# ===================================================================


class TestCommsJoin:
    @pytest.mark.asyncio
    async def test_first_join_requires_name(self, registry: ParticipantRegistry):
        result = await tool_comms_join(registry, conversation="general")
        assert result.get("error") is True
        assert "name" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_first_join_returns_key(self, registry: ParticipantRegistry):
        result = await tool_comms_join(registry, name="alice", conversation="general")
        assert result["status"] == "joined"
        assert len(result["key"]) == 8
        assert result["name"] == "alice"
        assert result["conversation"] == "general"

    @pytest.mark.asyncio
    async def test_rejoin_same_name_idempotent(self, registry: ParticipantRegistry):
        r1 = await tool_comms_join(registry, name="alice", conversation="general")
        r2 = await tool_comms_join(registry, name="alice", conversation="general")
        assert r1["key"] == r2["key"]

    @pytest.mark.asyncio
    async def test_rejoin_with_key(self, registry: ParticipantRegistry):
        r1 = await tool_comms_join(registry, name="alice", conversation="general")
        key = r1["key"]
        r2 = await tool_comms_join(registry, key=key, conversation="dev")
        assert r2["key"] == key
        assert r2["conversation"] == "dev"

    @pytest.mark.asyncio
    async def test_invalid_conversation_id(self, registry: ParticipantRegistry):
        result = await tool_comms_join(registry, name="alice", conversation="INVALID!")
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_invalid_name(self, registry: ParticipantRegistry):
        result = await tool_comms_join(
            registry, name="has spaces", conversation="general"
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_default_conversation(self, registry: ParticipantRegistry):
        result = await tool_comms_join(registry, name="bob")
        assert result["conversation"] == "general"

    @pytest.mark.asyncio
    async def test_invalid_key_format(self, registry: ParticipantRegistry):
        result = await tool_comms_join(registry, key="ZZZZ", conversation="general")
        assert result.get("error") is True


# ===================================================================
# comms_leave
# ===================================================================


class TestCommsLeave:
    def test_leave_joined_conversation(
        self, registry: ParticipantRegistry, sample_participant: dict
    ):
        key = sample_participant["key"]
        result = tool_comms_leave(registry, key=key, conversation="general")
        assert result["status"] == "left"

    def test_leave_unjoined_conversation(
        self, registry: ParticipantRegistry, sample_participant: dict
    ):
        key = sample_participant["key"]
        result = tool_comms_leave(registry, key=key, conversation="other")
        assert result["status"] == "not_a_member"

    def test_leave_unknown_key(self, registry: ParticipantRegistry):
        result = tool_comms_leave(registry, key="00000000", conversation="general")
        assert result.get("error") is True


# ===================================================================
# comms_send
# ===================================================================


class TestCommsSend:
    @pytest.mark.asyncio
    async def test_send_broadcast(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
        publish_spy,
    ):
        key = sample_participant["key"]
        result = await tool_comms_send(
            registry,
            publish_spy,
            key=key,
            conversation="general",
            message="Hello everyone!",
        )
        assert result["status"] == "sent"
        assert result["recipients"] is None
        assert publish_spy.call_count == 1
        topic, payload, _retain = publish_spy.last_call
        assert topic == "claude-comms/conv/general/messages"
        msg = json.loads(payload)
        assert msg["body"] == "Hello everyone!"
        assert msg["sender"]["key"] == key

    @pytest.mark.asyncio
    async def test_send_with_recipients(
        self,
        registry: ParticipantRegistry,
        publish_spy,
    ):
        # Register two participants
        r1 = await tool_comms_join(registry, name="alice", conversation="general")
        r2 = await tool_comms_join(registry, name="bob", conversation="general")
        result = await tool_comms_send(
            registry,
            publish_spy,
            key=r1["key"],
            conversation="general",
            message="Hey Bob!",
            recipients=["bob"],
        )
        assert result["status"] == "sent"
        assert r2["key"] in result["recipients"]
        # Body should have mention prefix
        _, payload, _retain = publish_spy.last_call
        msg = json.loads(payload)
        assert "[@bob]" in msg["body"]

    @pytest.mark.asyncio
    async def test_send_empty_message(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
        publish_spy,
    ):
        result = await tool_comms_send(
            registry,
            publish_spy,
            key=sample_participant["key"],
            conversation="general",
            message="   ",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_send_unresolvable_recipients(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
        publish_spy,
    ):
        result = await tool_comms_send(
            registry,
            publish_spy,
            key=sample_participant["key"],
            conversation="general",
            message="Hey!",
            recipients=["nonexistent"],
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_send_unknown_key(
        self,
        registry: ParticipantRegistry,
        publish_spy,
    ):
        result = await tool_comms_send(
            registry,
            publish_spy,
            key="00000000",
            conversation="general",
            message="Hello",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_send_broker_failure(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
        failing_publish,
    ):
        result = await tool_comms_send(
            registry,
            failing_publish,
            key=sample_participant["key"],
            conversation="general",
            message="Hello",
        )
        assert result.get("error") is True
        assert (
            "broker" in result["message"].lower()
            or "unavailable" in result["message"].lower()
        )


# ===================================================================
# comms_read
# ===================================================================


class TestCommsRead:
    def _add_messages(self, store: MessageStore, conv: str, n: int) -> list[dict]:
        """Add n test messages to the store and return them."""
        msgs = []
        for i in range(n):
            msg = {
                "id": f"msg-{i:04d}",
                "ts": f"2026-03-13T14:{i:02d}:00.000-05:00",
                "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                "body": f"Message number {i}",
                "conv": conv,
            }
            store.add(conv, msg)
            msgs.append(msg)
        return msgs

    def test_read_empty(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        result = tool_comms_read(
            registry, store, key=sample_participant["key"], conversation="general"
        )
        assert result["count"] == 0
        assert result["messages"] == []
        assert result["has_more"] is False

    def test_read_messages(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        self._add_messages(store, "general", 5)
        result = tool_comms_read(
            registry, store, key=sample_participant["key"], conversation="general"
        )
        assert result["count"] == 5
        assert result["has_more"] is False

    def test_read_with_count_limit(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        self._add_messages(store, "general", 30)
        result = tool_comms_read(
            registry,
            store,
            key=sample_participant["key"],
            conversation="general",
            count=10,
        )
        assert result["count"] == 10
        assert result["has_more"] is True

    def test_read_since_filter(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        self._add_messages(store, "general", 10)
        result = tool_comms_read(
            registry,
            store,
            key=sample_participant["key"],
            conversation="general",
            since="2026-03-13T14:07:00.000-05:00",
        )
        # Messages 8, 9 have ts > the since value
        assert result["count"] == 2

    def test_read_updates_cursor(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        self._add_messages(store, "general", 3)
        tool_comms_read(
            registry, store, key=sample_participant["key"], conversation="general"
        )
        cursor = registry.get_cursor(sample_participant["key"], "general")
        assert cursor is not None
        assert "2026-03-13" in cursor

    def test_read_unknown_key(self, registry: ParticipantRegistry, store: MessageStore):
        result = tool_comms_read(
            registry, store, key="00000000", conversation="general"
        )
        assert result.get("error") is True


# ===================================================================
# comms_check
# ===================================================================


class TestCommsCheck:
    def test_check_no_unread(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        result = tool_comms_check(registry, store, key=sample_participant["key"])
        assert result["total_unread"] == 0

    def test_check_with_unread(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        store.add(
            "general",
            {
                "id": "m1",
                "ts": "2026-03-13T15:00:00.000-05:00",
                "sender": {"key": "other123", "name": "other", "type": "claude"},
                "body": "Hello!",
                "conv": "general",
            },
        )
        result = tool_comms_check(registry, store, key=sample_participant["key"])
        assert result["total_unread"] == 1
        assert result["conversations"][0]["conversation"] == "general"

    def test_check_specific_conversation(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        result = tool_comms_check(
            registry,
            store,
            key=sample_participant["key"],
            conversation="general",
        )
        assert result["total_unread"] == 0


# ===================================================================
# comms_members
# ===================================================================


class TestCommsMembers:
    @pytest.mark.asyncio
    async def test_members_lists_joined(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
    ):
        await tool_comms_join(registry, name="bob", conversation="general")
        result = tool_comms_members(
            registry,
            key=sample_participant["key"],
            conversation="general",
        )
        assert result["count"] == 2
        names = {m["name"] for m in result["members"]}
        assert "test-claude" in names
        assert "bob" in names

    def test_members_empty_conversation(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
    ):
        result = tool_comms_members(
            registry,
            key=sample_participant["key"],
            conversation="empty-conv",
        )
        assert result["count"] == 0


# ===================================================================
# comms_conversations
# ===================================================================


class TestCommsConversations:
    @pytest.mark.asyncio
    async def test_conversations_lists_joined(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        key = sample_participant["key"]
        await tool_comms_join(registry, key=key, conversation="dev")
        result = tool_comms_conversations(registry, store, key=key)
        conv_ids = {c["conversation"] for c in result["conversations"]}
        assert "general" in conv_ids
        assert "dev" in conv_ids

    def test_conversations_unknown_key(
        self, registry: ParticipantRegistry, store: MessageStore
    ):
        result = tool_comms_conversations(registry, store, key="00000000")
        assert result.get("error") is True


# ===================================================================
# comms_update_name
# ===================================================================


class TestCommsUpdateName:
    def test_update_name(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
    ):
        key = sample_participant["key"]
        result = tool_comms_update_name(registry, key=key, new_name="new-claude")
        assert result["status"] == "updated"
        assert result["name"] == "new-claude"
        assert result["key"] == key

    def test_update_name_invalid(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
    ):
        result = tool_comms_update_name(
            registry, key=sample_participant["key"], new_name="has spaces"
        )
        assert result.get("error") is True

    def test_update_name_unknown_key(self, registry: ParticipantRegistry):
        result = tool_comms_update_name(registry, key="00000000", new_name="test")
        assert result.get("error") is True


# ===================================================================
# comms_history
# ===================================================================


class TestCommsHistory:
    def test_history_all(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        for i in range(5):
            store.add(
                "general",
                {
                    "id": f"h-{i}",
                    "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                    "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                    "body": f"History message {i}",
                    "conv": "general",
                },
            )
        result = tool_comms_history(
            registry,
            store,
            key=sample_participant["key"],
            conversation="general",
        )
        assert result["count"] == 5

    def test_history_with_query(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        store.add(
            "general",
            {
                "id": "h-a",
                "ts": "2026-03-13T10:00:00-05:00",
                "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                "body": "The fox jumped",
                "conv": "general",
            },
        )
        store.add(
            "general",
            {
                "id": "h-b",
                "ts": "2026-03-13T10:01:00-05:00",
                "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                "body": "The dog barked",
                "conv": "general",
            },
        )
        result = tool_comms_history(
            registry,
            store,
            key=sample_participant["key"],
            conversation="general",
            query="fox",
        )
        assert result["count"] == 1
        assert "fox" in result["messages"][0]["body"]

    def test_history_query_by_sender(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        store.add(
            "general",
            {
                "id": "h-s1",
                "ts": "2026-03-13T10:00:00-05:00",
                "sender": {"key": "11111111", "name": "alice", "type": "claude"},
                "body": "From alice",
                "conv": "general",
            },
        )
        store.add(
            "general",
            {
                "id": "h-s2",
                "ts": "2026-03-13T10:01:00-05:00",
                "sender": {"key": "22222222", "name": "bob", "type": "claude"},
                "body": "From bob",
                "conv": "general",
            },
        )
        result = tool_comms_history(
            registry,
            store,
            key=sample_participant["key"],
            conversation="general",
            query="alice",
        )
        assert result["count"] == 1

    def test_history_invalid_conversation(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        result = tool_comms_history(
            registry,
            store,
            key=sample_participant["key"],
            conversation="INVALID!",
        )
        assert result.get("error") is True


# ===================================================================
# ParticipantRegistry unit tests
# ===================================================================


class TestParticipantRegistry:
    @pytest.mark.asyncio
    async def test_resolve_recipients_mixed(self, registry: ParticipantRegistry):
        await tool_comms_join(registry, name="alice", conversation="general")
        r2 = await tool_comms_join(registry, name="bob", conversation="general")
        bob_key = r2["key"]
        resolved = registry.resolve_recipients(["alice", bob_key])
        assert len(resolved) == 2
        assert bob_key in resolved

    @pytest.mark.asyncio
    async def test_resolve_recipients_dedup(self, registry: ParticipantRegistry):
        r1 = await tool_comms_join(registry, name="alice", conversation="general")
        key = r1["key"]
        resolved = registry.resolve_recipients(["alice", key])
        assert len(resolved) == 1

    @pytest.mark.asyncio
    async def test_name_to_key_map(self, registry: ParticipantRegistry):
        await tool_comms_join(registry, name="alice", conversation="general")
        await tool_comms_join(registry, name="bob", conversation="general")
        mapping = registry.name_to_key_map("general")
        assert "alice" in mapping
        assert "bob" in mapping
        assert len(mapping) == 2

    @pytest.mark.asyncio
    async def test_update_name_reindexes(self, registry: ParticipantRegistry):
        r = await tool_comms_join(registry, name="old-name", conversation="general")
        key = r["key"]
        registry.update_name(key, "new-name")
        assert registry.resolve_name("old-name") is None
        assert registry.resolve_name("new-name") == key


# ===================================================================
# Token-aware pagination
# ===================================================================


class TestTokenPagination:
    def test_large_messages_truncated(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        # Add messages with large bodies that exceed token limit
        for i in range(100):
            store.add(
                "general",
                {
                    "id": f"big-{i}",
                    "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                    "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
                    "body": "x" * 2000,  # ~500 tokens each
                    "conv": "general",
                },
            )
        result = tool_comms_read(
            registry,
            store,
            key=sample_participant["key"],
            conversation="general",
            count=100,
        )
        # Should have been truncated due to token limit
        assert result["count"] < 100
        assert result["has_more"] is True


# ===================================================================
# comms_conversation_delete (v0.4.0 step 2.2)
# ===================================================================


class TestCommsConversationDelete:
    """Smoke coverage for the new soft-delete MCP tool wired into the same
    fixtures the rest of the MCP tool surface uses.  Full end-to-end
    coverage lives in ``tests/test_conversation.py``; these specs lock the
    fixture-level contract that other MCP tools rely on (publish_spy as
    PublishFn, sample_participant as creator).
    """

    @pytest.mark.asyncio
    async def test_confirm_required_pre_flight(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
        publish_spy,
        tmp_path,
    ):
        # Create a conversation owned by ``test-claude`` (sample_participant)
        await tool_comms_conversation_create(
            registry,
            publish_spy,
            key=sample_participant["key"],
            conversation="design",
            conv_data_dir=tmp_path,
        )
        publish_spy.calls.clear()

        result = await tool_comms_conversation_delete(
            registry,
            store,
            publish_spy,
            key=sample_participant["key"],
            conversation="design",
            confirm=False,
            conv_data_dir=tmp_path,
        )

        assert result["error"] == "confirm_required"
        assert "message_count" in result
        assert "member_count" in result
        # Pre-flight branch must NOT publish anything.
        assert publish_spy.call_count == 0

    @pytest.mark.asyncio
    async def test_confirm_true_delete_succeeds(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
        publish_spy,
        tmp_path,
    ):
        await tool_comms_conversation_create(
            registry,
            publish_spy,
            key=sample_participant["key"],
            conversation="design",
            conv_data_dir=tmp_path,
        )
        publish_spy.calls.clear()

        result = await tool_comms_conversation_delete(
            registry,
            store,
            publish_spy,
            key=sample_participant["key"],
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        assert result == {"deleted": True, "conversation_id": "design"}
        # 5-step flow must publish at least: orphan banner + lifecycle event
        # + one retained-clear per member (>=1).  Lower bound 3.
        assert publish_spy.call_count >= 3

    @pytest.mark.asyncio
    async def test_invalid_conversation_id(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
        publish_spy,
        tmp_path,
    ):
        result = await tool_comms_conversation_delete(
            registry,
            store,
            publish_spy,
            key=sample_participant["key"],
            conversation="INVALID!",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result.get("error") is True
        assert publish_spy.call_count == 0


class TestPublishArchiveEvent:
    @pytest.mark.asyncio
    async def test_publishes_archived_event_on_system_topic(self):
        from conftest import PublishSpy

        spy = PublishSpy()
        await _publish_archive_event(
            spy,
            event_type="archived",
            conversation_id="design",
            archived_by="alice",
            evicted_keys=[],
        )
        # First (and only, with empty evicted_keys) publish is the system event
        assert spy.calls[0][0] == "claude-comms/system/conversations"
        payload = json.loads(spy.calls[0][1])
        assert payload["type"] == "archived"
        assert payload["id"] == "design"
        assert payload["archivedBy"] == "alice"
        assert "timestamp" in payload

    @pytest.mark.asyncio
    async def test_publishes_unarchived_event(self):
        from conftest import PublishSpy

        spy = PublishSpy()
        await _publish_archive_event(
            spy,
            event_type="unarchived",
            conversation_id="design",
        )
        assert spy.call_count == 1
        topic, raw, _retain = spy.calls[0]
        assert topic == "claude-comms/system/conversations"
        payload = json.loads(raw)
        assert payload["type"] == "unarchived"
        assert payload["id"] == "design"
        # unarchive event has no archivedBy
        assert "archivedBy" not in payload

    @pytest.mark.asyncio
    async def test_archive_retained_clears_member_presence(self):
        from conftest import PublishSpy

        spy = PublishSpy()
        await _publish_archive_event(
            spy,
            event_type="archived",
            conversation_id="design",
            archived_by="alice",
            evicted_keys=["aabbccdd", "11223344"],
        )

        # 1 system event + 2 presence clears = 3 publishes total
        assert spy.call_count == 3
        # Presence-clear topics
        presence_calls = [
            (topic, payload, retain)
            for topic, payload, retain in spy.calls
            if topic.startswith("claude-comms/conv/design/presence/")
        ]
        assert len(presence_calls) == 2
        for _topic, payload, retain in presence_calls:
            assert payload == b""  # retained-clear wire contract
            assert retain is True
        # And both member-key suffixes covered
        topics = {c[0] for c in presence_calls}
        assert "claude-comms/conv/design/presence/aabbccdd" in topics
        assert "claude-comms/conv/design/presence/11223344" in topics

    @pytest.mark.asyncio
    async def test_unarchive_does_not_clear_presence(self):
        from conftest import PublishSpy

        spy = PublishSpy()
        await _publish_archive_event(
            spy,
            event_type="unarchived",
            conversation_id="design",
            evicted_keys=["aabbccdd"],  # ignored on unarchive
        )
        # Only the system event — no presence retained-clear on unarchive
        assert spy.call_count == 1
        assert spy.calls[0][0] == "claude-comms/system/conversations"
