"""End-to-end tests for claude-comms.

Tests full system flows with a mock MQTT broker:
- Two-participant chat: join, send, receive, verify message content
- Targeted messaging: send to specific recipient, verify routing
- Conversation lifecycle: create, send messages, verify logs
- Presence: join -> online, leave -> offline
- Name change: update name, verify old messages still linked by key
- Log format verification: send messages, verify .log grep patterns work
- JSONL replay: write messages, restart, verify history restored
- Notification flow: message arrives -> notification file written
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_comms.broker import (
    MessageDeduplicator,
    MessageStore,
    replay_jsonl_logs,
)
from claude_comms.log_exporter import LogExporter, format_log_entry
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_check,
    tool_comms_conversations,
    tool_comms_join,
    tool_comms_leave,
    tool_comms_members,
    tool_comms_read,
    tool_comms_send,
    tool_comms_update_name,
)
from claude_comms.message import Message


# ===================================================================
# Helpers
# ===================================================================


class MockBroker:
    """Mock MQTT broker for E2E tests.

    Provides publish/subscribe simulation. Messages published to a topic
    are dispatched to all subscribers of that topic pattern.
    """

    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []
        self.subscribers: dict[str, list] = {}

    async def publish(self, topic: str, payload: bytes) -> None:
        """Simulate publishing a message to the broker."""
        msg_data = json.loads(payload)
        self.published.append((topic, msg_data))

        # Dispatch to subscribers
        for pattern, callbacks in self.subscribers.items():
            if self._topic_matches(pattern, topic):
                for cb in callbacks:
                    await cb(topic, msg_data)

    def subscribe(self, pattern: str, callback) -> None:
        """Register a callback for a topic pattern."""
        self.subscribers.setdefault(pattern, []).append(callback)

    def get_messages(self, topic: str | None = None) -> list[dict]:
        """Return all published messages, optionally filtered by topic."""
        if topic is None:
            return [msg for _, msg in self.published]
        return [msg for t, msg in self.published if t == topic]

    @staticmethod
    def _topic_matches(pattern: str, topic: str) -> bool:
        """Simple MQTT topic matching with + wildcard."""
        pat_parts = pattern.split("/")
        top_parts = topic.split("/")
        if len(pat_parts) != len(top_parts):
            return False
        for p, t in zip(pat_parts, top_parts):
            if p == "+":
                continue
            if p != t:
                return False
        return True


# ===================================================================
# Two-participant chat
# ===================================================================


class TestTwoParticipantChat:
    """Full chat flow between two participants."""

    @pytest.mark.asyncio
    async def test_join_send_receive(self, e2e_config: dict) -> None:
        registry = ParticipantRegistry()
        MessageStore()  # ensure store initializes cleanly
        broker = MockBroker()

        # Both participants subscribe to general messages
        received_alice: list[dict] = []
        received_bob: list[dict] = []

        async def on_msg_alice(topic, msg):
            received_alice.append(msg)

        async def on_msg_bob(topic, msg):
            received_bob.append(msg)

        broker.subscribe("claude-comms/conv/+/messages", on_msg_alice)
        broker.subscribe("claude-comms/conv/+/messages", on_msg_bob)

        # Join
        r_alice = await tool_comms_join(registry, name="alice", conversation="general")
        r_bob = await tool_comms_join(registry, name="bob", conversation="general")

        # Alice sends a message
        result = await tool_comms_send(
            registry,
            broker.publish,
            key=r_alice["key"],
            conversation="general",
            message="Hello Bob!",
        )
        assert result["status"] == "sent"

        # Both should receive it
        assert len(received_alice) == 1
        assert len(received_bob) == 1
        assert received_bob[0]["body"] == "Hello Bob!"
        assert received_bob[0]["sender"]["name"] == "alice"

        # Bob replies
        result = await tool_comms_send(
            registry,
            broker.publish,
            key=r_bob["key"],
            conversation="general",
            message="Hey Alice!",
        )
        assert result["status"] == "sent"

        assert len(received_alice) == 2
        assert received_alice[1]["body"] == "Hey Alice!"
        assert received_alice[1]["sender"]["name"] == "bob"

    @pytest.mark.asyncio
    async def test_multiple_conversation_isolation(self, e2e_config: dict) -> None:
        """Messages in one conversation don't appear in another."""
        registry = ParticipantRegistry()
        broker = MockBroker()

        r1 = await tool_comms_join(registry, name="alice", conversation="general")
        await tool_comms_join(registry, key=r1["key"], conversation="dev")

        await tool_comms_send(
            registry,
            broker.publish,
            key=r1["key"],
            conversation="general",
            message="In general",
        )
        await tool_comms_send(
            registry,
            broker.publish,
            key=r1["key"],
            conversation="dev",
            message="In dev",
        )

        general_msgs = broker.get_messages("claude-comms/conv/general/messages")
        dev_msgs = broker.get_messages("claude-comms/conv/dev/messages")

        assert len(general_msgs) == 1
        assert general_msgs[0]["body"] == "In general"
        assert len(dev_msgs) == 1
        assert dev_msgs[0]["body"] == "In dev"


# ===================================================================
# Targeted messaging
# ===================================================================


class TestTargetedMessaging:
    """Test targeted message routing with recipients."""

    @pytest.mark.asyncio
    async def test_targeted_message_has_correct_recipients(self) -> None:
        registry = ParticipantRegistry()
        broker = MockBroker()

        r_alice = await tool_comms_join(registry, name="alice", conversation="general")
        r_bob = await tool_comms_join(registry, name="bob", conversation="general")
        r_charlie = await tool_comms_join(
            registry, name="charlie", conversation="general"
        )

        result = await tool_comms_send(
            registry,
            broker.publish,
            key=r_alice["key"],
            conversation="general",
            message="Secret for Bob only",
            recipients=["bob"],
        )

        assert result["status"] == "sent"
        msg = broker.get_messages()[0]

        # Message should be routable to bob only
        wire_msg = Message.model_validate(msg)
        assert wire_msg.is_for(r_bob["key"])
        # Charlie is not a recipient but the message is published to the
        # same topic (filtering is client-side in MQTT)
        assert not wire_msg.is_for(r_charlie["key"])

    @pytest.mark.asyncio
    async def test_targeted_to_multiple_recipients(self) -> None:
        registry = ParticipantRegistry()
        broker = MockBroker()

        r_alice = await tool_comms_join(registry, name="alice", conversation="general")
        r_bob = await tool_comms_join(registry, name="bob", conversation="general")
        r_charlie = await tool_comms_join(
            registry, name="charlie", conversation="general"
        )

        result = await tool_comms_send(
            registry,
            broker.publish,
            key=r_alice["key"],
            conversation="general",
            message="For both of you",
            recipients=["bob", "charlie"],
        )

        assert result["status"] == "sent"
        msg = Message.model_validate(broker.get_messages()[0])
        assert msg.is_for(r_bob["key"])
        assert msg.is_for(r_charlie["key"])
        assert not msg.is_for(r_alice["key"])
        assert "[@bob, @charlie]" in msg.body


# ===================================================================
# Conversation lifecycle
# ===================================================================


class TestConversationLifecycle:
    """Create conversation, send messages, verify in logs."""

    @pytest.mark.asyncio
    async def test_full_conversation_lifecycle(self, tmp_comms_dir: Path) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        broker = MockBroker()
        dedup = MessageDeduplicator()
        log_dir = tmp_comms_dir / "logs"
        exporter = LogExporter(log_dir=log_dir, fmt="both", deduplicator=dedup)

        # Join and add messages to store via broker callback
        async def on_message(topic, msg_data):
            store.add(msg_data["conv"], msg_data)
            exporter.write_message(msg_data)

        broker.subscribe("claude-comms/conv/+/messages", on_message)

        r = await tool_comms_join(registry, name="alice", conversation="project-x")
        exporter.write_presence("project-x", "alice", r["key"], "joined")

        # Send messages
        for i in range(5):
            await tool_comms_send(
                registry,
                broker.publish,
                key=r["key"],
                conversation="project-x",
                message=f"Update #{i}",
            )

        # Verify store
        msgs = store.get("project-x")
        assert len(msgs) == 5

        # Verify log files
        log_file = log_dir / "project-x.log"
        assert log_file.exists()
        content = log_file.read_text()
        assert "CONVERSATION: project-x" in content
        assert "alice" in content
        assert "joined the conversation" in content
        for i in range(5):
            assert f"Update #{i}" in content

        # Verify JSONL
        jsonl_file = log_dir / "project-x.jsonl"
        lines = jsonl_file.read_text().strip().split("\n")
        assert len(lines) == 5

        # Verify conversations listing
        convs = tool_comms_conversations(registry, store, key=r["key"])
        conv_ids = {c["conversation"] for c in convs["conversations"]}
        assert "project-x" in conv_ids


# ===================================================================
# Presence: join -> online, leave -> offline
# ===================================================================


class TestPresenceFlow:
    """Test join/leave presence tracking."""

    @pytest.mark.asyncio
    async def test_join_makes_visible_in_members(self) -> None:
        registry = ParticipantRegistry()
        r = await tool_comms_join(registry, name="alice", conversation="general")

        members = tool_comms_members(registry, key=r["key"], conversation="general")
        assert members["count"] == 1
        assert members["members"][0]["name"] == "alice"

    @pytest.mark.asyncio
    async def test_leave_removes_from_members(self) -> None:
        registry = ParticipantRegistry()
        r_alice = await tool_comms_join(registry, name="alice", conversation="general")
        r_bob = await tool_comms_join(registry, name="bob", conversation="general")

        tool_comms_leave(registry, key=r_alice["key"], conversation="general")

        members = tool_comms_members(registry, key=r_bob["key"], conversation="general")
        names = {m["name"] for m in members["members"]}
        assert "alice" not in names
        assert "bob" in names

    def test_presence_logged(self, tmp_comms_dir: Path) -> None:
        log_dir = tmp_comms_dir / "logs"
        exporter = LogExporter(log_dir=log_dir, fmt="text")

        exporter.write_presence("general", "alice", "a1b2c3d4", "joined")
        exporter.write_presence("general", "alice", "a1b2c3d4", "left")

        content = (log_dir / "general.log").read_text()
        assert "joined the conversation" in content
        assert "left the conversation" in content


# ===================================================================
# Name change: update name, verify old messages still linked by key
# ===================================================================


class TestNameChangeFlow:
    """Test that name changes preserve identity via key."""

    @pytest.mark.asyncio
    async def test_name_change_old_messages_linked_by_key(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        broker = MockBroker()

        async def on_message(topic, msg_data):
            store.add(msg_data["conv"], msg_data)

        broker.subscribe("claude-comms/conv/+/messages", on_message)

        # Join and send under old name
        r = await tool_comms_join(registry, name="old-name", conversation="general")
        key = r["key"]

        await tool_comms_send(
            registry,
            broker.publish,
            key=key,
            conversation="general",
            message="Message under old name",
        )

        # Change name
        update_result = tool_comms_update_name(registry, key=key, new_name="new-name")
        assert update_result["status"] == "updated"
        assert update_result["name"] == "new-name"

        # Send under new name
        await tool_comms_send(
            registry,
            broker.publish,
            key=key,
            conversation="general",
            message="Message under new name",
        )

        # All messages share the same sender key
        msgs = store.get("general")
        assert len(msgs) == 2
        assert msgs[0]["sender"]["key"] == key
        assert msgs[1]["sender"]["key"] == key
        # But names differ in the message payloads
        assert msgs[0]["sender"]["name"] == "old-name"
        assert msgs[1]["sender"]["name"] == "new-name"

    @pytest.mark.asyncio
    async def test_name_change_resolves_new_name(self) -> None:
        registry = ParticipantRegistry()
        r = await tool_comms_join(registry, name="original", conversation="general")
        key = r["key"]

        tool_comms_update_name(registry, key=key, new_name="renamed")

        # Old name no longer resolves
        assert registry.resolve_name("original") is None
        # New name resolves to same key
        assert registry.resolve_name("renamed") == key


# ===================================================================
# Log format verification
# ===================================================================


class TestLogFormatVerification:
    """Verify that generated log files support standard grep workflows."""

    @pytest.mark.asyncio
    async def test_grep_by_sender(self, log_exporter_instance: LogExporter) -> None:
        registry = ParticipantRegistry()
        broker = MockBroker()

        r_alice = await tool_comms_join(registry, name="alice", conversation="general")
        r_bob = await tool_comms_join(registry, name="bob", conversation="general")

        async def on_message(topic, msg_data):
            log_exporter_instance.write_message(msg_data)

        broker.subscribe("claude-comms/conv/+/messages", on_message)

        await tool_comms_send(
            registry,
            broker.publish,
            key=r_alice["key"],
            conversation="general",
            message="Alice's message",
        )
        await tool_comms_send(
            registry,
            broker.publish,
            key=r_bob["key"],
            conversation="general",
            message="Bob's message",
        )

        content = (log_exporter_instance.log_dir / "general.log").read_text()
        lines = content.split("\n")

        # grep '@alice' should find alice's messages
        alice_lines = [line for line in lines if "@alice" in line]
        assert len(alice_lines) >= 1

        # grep '@bob' should find bob's messages
        bob_lines = [line for line in lines if "@bob" in line]
        assert len(bob_lines) >= 1

    @pytest.mark.asyncio
    async def test_grep_by_key(self, log_exporter_instance: LogExporter) -> None:
        registry = ParticipantRegistry()
        broker = MockBroker()

        r = await tool_comms_join(registry, name="alice", conversation="general")
        key = r["key"]

        async def on_message(topic, msg_data):
            log_exporter_instance.write_message(msg_data)

        broker.subscribe("claude-comms/conv/+/messages", on_message)

        await tool_comms_send(
            registry,
            broker.publish,
            key=key,
            conversation="general",
            message="Find me by key",
        )

        content = (log_exporter_instance.log_dir / "general.log").read_text()
        assert f"({key})" in content

    @pytest.mark.asyncio
    async def test_grep_by_content(self, log_exporter_instance: LogExporter) -> None:
        registry = ParticipantRegistry()
        broker = MockBroker()

        r = await tool_comms_join(registry, name="alice", conversation="general")

        async def on_message(topic, msg_data):
            log_exporter_instance.write_message(msg_data)

        broker.subscribe("claude-comms/conv/+/messages", on_message)

        await tool_comms_send(
            registry,
            broker.publish,
            key=r["key"],
            conversation="general",
            message="UNIQUE_SEARCH_TOKEN_12345",
        )

        content = (log_exporter_instance.log_dir / "general.log").read_text()
        assert "UNIQUE_SEARCH_TOKEN_12345" in content


# ===================================================================
# Full E2E: integrated flow
# ===================================================================


class TestFullE2EFlow:
    """Combined end-to-end test exercising the full pipeline."""

    @pytest.mark.asyncio
    async def test_complete_session(self, tmp_comms_dir: Path) -> None:
        """Full session: join, chat, name change, leave, verify logs + replay."""
        registry = ParticipantRegistry()
        store = MessageStore()
        broker = MockBroker()
        dedup = MessageDeduplicator()
        log_dir = tmp_comms_dir / "logs"
        exporter = LogExporter(log_dir=log_dir, fmt="both", deduplicator=dedup)

        async def on_message(topic, msg_data):
            store.add(msg_data["conv"], msg_data)
            exporter.write_message(msg_data)

        broker.subscribe("claude-comms/conv/+/messages", on_message)

        # 1. Two participants join
        r_phil = await tool_comms_join(registry, name="phil", conversation="general")
        r_claude = await tool_comms_join(
            registry, name="claude-alpha", conversation="general"
        )
        exporter.write_presence("general", "phil", r_phil["key"], "joined")
        exporter.write_presence("general", "claude-alpha", r_claude["key"], "joined")

        # 2. Chat back and forth
        await tool_comms_send(
            registry,
            broker.publish,
            key=r_phil["key"],
            conversation="general",
            message="Hey Claude, how are you?",
        )
        await tool_comms_send(
            registry,
            broker.publish,
            key=r_claude["key"],
            conversation="general",
            message="Doing great, Phil! Working on the integration.",
        )
        await tool_comms_send(
            registry,
            broker.publish,
            key=r_phil["key"],
            conversation="general",
            message="Awesome, keep it up!",
        )

        # 3. Claude changes name
        tool_comms_update_name(registry, key=r_claude["key"], new_name="claude-beta")
        await tool_comms_send(
            registry,
            broker.publish,
            key=r_claude["key"],
            conversation="general",
            message="Name changed! Still me though.",
        )

        # 4. Verify store
        msgs = store.get("general")
        assert len(msgs) == 4
        assert msgs[0]["sender"]["name"] == "phil"
        assert msgs[1]["sender"]["name"] == "claude-alpha"
        assert msgs[3]["sender"]["name"] == "claude-beta"
        assert msgs[3]["sender"]["key"] == r_claude["key"]

        # 5. Verify members
        members = tool_comms_members(
            registry, key=r_phil["key"], conversation="general"
        )
        assert members["count"] == 2
        member_names = {m["name"] for m in members["members"]}
        assert "phil" in member_names
        assert "claude-beta" in member_names

        # 6. Phil leaves
        tool_comms_leave(registry, key=r_phil["key"], conversation="general")
        exporter.write_presence("general", "phil", r_phil["key"], "left")

        members_after = tool_comms_members(
            registry, key=r_claude["key"], conversation="general"
        )
        assert members_after["count"] == 1

        # 7. Verify log file content
        log_content = (log_dir / "general.log").read_text()
        assert "CONVERSATION: general" in log_content
        assert "phil" in log_content
        assert "claude-alpha" in log_content
        assert "Hey Claude, how are you?" in log_content
        assert "Doing great, Phil!" in log_content
        assert "Name changed!" in log_content
        assert "joined the conversation" in log_content
        assert "left the conversation" in log_content

        # 8. Verify JSONL and replay
        jsonl_lines = (log_dir / "general.jsonl").read_text().strip().split("\n")
        assert len(jsonl_lines) == 4

        # Replay into a fresh store
        fresh_store = replay_jsonl_logs(log_dir=log_dir)
        replayed = fresh_store.get("general")
        assert len(replayed) == 4
        assert replayed[0]["body"] == "Hey Claude, how are you?"
        assert replayed[-1]["body"] == "Name changed! Still me though."


# ===================================================================
# Round 5: Gap tests — error handling, edge cases, untested paths
# ===================================================================


class TestErrorHandlingPaths:
    """Test error handling paths that were previously uncovered."""

    @pytest.mark.asyncio
    async def test_send_to_invalid_conversation(self) -> None:
        """Sending to a conversation with invalid ID should return error."""
        registry = ParticipantRegistry()
        broker = MockBroker()
        r = await tool_comms_join(registry, name="alice", conversation="general")
        result = await tool_comms_send(
            registry,
            broker.publish,
            key=r["key"],
            conversation="INVALID!CONV",
            message="Hello",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_send_with_empty_body(self) -> None:
        """Empty or whitespace-only message body should be rejected."""
        registry = ParticipantRegistry()
        broker = MockBroker()
        r = await tool_comms_join(registry, name="alice", conversation="general")
        for body in ["", "   ", "\n\t"]:
            result = await tool_comms_send(
                registry,
                broker.publish,
                key=r["key"],
                conversation="general",
                message=body,
            )
            assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_send_with_unregistered_key(self) -> None:
        """Using an unregistered key should return error."""
        registry = ParticipantRegistry()
        broker = MockBroker()
        result = await tool_comms_send(
            registry,
            broker.publish,
            key="deadbeef",
            conversation="general",
            message="Hello",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_send_with_invalid_key_format(self) -> None:
        """Malformed key should return error."""
        registry = ParticipantRegistry()
        broker = MockBroker()
        result = await tool_comms_send(
            registry,
            broker.publish,
            key="ZZZ",
            conversation="general",
            message="Hello",
        )
        assert result.get("error") is True

    def test_read_with_invalid_key(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        result = tool_comms_read(
            registry, store, key="ZZZZZZZZ", conversation="general"
        )
        assert result.get("error") is True

    def test_check_with_invalid_key(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        result = tool_comms_check(registry, store, key="ZZZZZZZZ")
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_members_with_invalid_conv(self) -> None:
        registry = ParticipantRegistry()
        r = await tool_comms_join(registry, name="alice", conversation="general")
        result = tool_comms_members(registry, key=r["key"], conversation="BAD!")
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_history_with_invalid_conv(self) -> None:
        from claude_comms.mcp_tools import tool_comms_history

        registry = ParticipantRegistry()
        store = MessageStore()
        r = await tool_comms_join(registry, name="alice", conversation="general")
        result = tool_comms_history(
            registry,
            store,
            key=r["key"],
            conversation="BAD!",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_leave_with_invalid_conv(self) -> None:
        registry = ParticipantRegistry()
        r = await tool_comms_join(registry, name="alice", conversation="general")
        result = tool_comms_leave(registry, key=r["key"], conversation="BAD!")
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_join_with_reserved_conv_id(self) -> None:
        """Joining a reserved conversation ID should return error."""
        registry = ParticipantRegistry()
        for reserved in ["system", "meta"]:
            result = await tool_comms_join(
                registry,
                name="alice",
                conversation=reserved,
            )
            assert result.get("error") is True


class TestLogExporterEdgeCases:
    """Test edge cases in log exporter formatting."""

    def test_format_log_entry_empty_dict(self) -> None:
        result = format_log_entry({})
        assert result == "[EMPTY MESSAGE]"

    def test_format_log_entry_missing_sender(self) -> None:
        msg = {"ts": "2026-03-13T14:00:00-05:00", "body": "no sender"}
        result = format_log_entry(msg)
        assert "unknown" in result
        assert "no sender" in result

    def test_format_log_entry_missing_ts(self) -> None:
        msg = {
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": "no timestamp",
        }
        result = format_log_entry(msg)
        assert "UNKNOWN TIME" in result
        assert "no timestamp" in result

    def test_format_log_entry_invalid_ts(self) -> None:
        msg = {
            "ts": "not-a-timestamp",
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": "bad ts",
        }
        result = format_log_entry(msg)
        # Should fall back to using raw ts string
        assert "not-a-timestamp" in result

    def test_format_log_entry_sender_not_dict(self) -> None:
        msg = {
            "ts": "2026-03-13T14:00:00-05:00",
            "sender": "not-a-dict",
            "body": "weird sender",
        }
        result = format_log_entry(msg)
        assert "unknown" in result

    def test_format_presence_event_none_name(self) -> None:
        from claude_comms.log_exporter import format_presence_event

        result = format_presence_event(None, "aabbccdd", "joined")
        assert "unknown" in result
        assert "joined" in result

    def test_format_presence_event_none_key(self) -> None:
        from claude_comms.log_exporter import format_presence_event

        result = format_presence_event("alice", None, "left")
        assert "????????" in result
        assert "left" in result

    def test_format_presence_event_invalid_ts(self) -> None:
        from claude_comms.log_exporter import format_presence_event

        result = format_presence_event("alice", "aabbccdd", "joined", "not-a-date")
        # Should fall back to current time, not crash
        assert "alice" in result
        assert "joined" in result

    def test_format_log_header_no_ts(self) -> None:
        from claude_comms.log_exporter import format_log_header

        header = format_log_header("my-conv")
        assert "CONVERSATION: my-conv" in header
        assert "CREATED:" in header


class TestMultiParticipantEdgeCases:
    """Test multi-participant scenarios with edge cases."""

    @pytest.mark.asyncio
    async def test_targeted_to_self_is_rejected(self) -> None:
        """Sending a targeted message to only yourself is rejected.

        The recipient resolver drops the sender from the resolved set (you
        already receive your own broadcast via the conversation topic), so a
        send whose only recipient is the sender resolves to an empty set
        and `tool_comms_send` returns an error rather than publishing a
        no-op targeted message. This is the contract since the
        mentions/whispers ship (commit 04a0501).
        """
        registry = ParticipantRegistry()
        broker = MockBroker()
        r = await tool_comms_join(registry, name="alice", conversation="general")

        result = await tool_comms_send(
            registry,
            broker.publish,
            key=r["key"],
            conversation="general",
            message="Note to self",
            recipients=["alice"],
        )
        assert result.get("error") is True
        assert "recipients" in result.get("message", "").lower()
        # Nothing should have been published.
        assert broker.get_messages() == []

    @pytest.mark.asyncio
    async def test_targeted_by_key_and_name(self) -> None:
        """Target recipients by mixed keys and names."""
        registry = ParticipantRegistry()
        broker = MockBroker()
        r1 = await tool_comms_join(registry, name="alice", conversation="general")
        r2 = await tool_comms_join(registry, name="bob", conversation="general")

        result = await tool_comms_send(
            registry,
            broker.publish,
            key=r1["key"],
            conversation="general",
            message="Mixed targeting",
            recipients=["bob", r2["key"]],  # both resolve to bob
        )
        assert result["status"] == "sent"
        # Should deduplicate to a single recipient
        assert len(result["recipients"]) == 1
        assert r2["key"] in result["recipients"]

    @pytest.mark.asyncio
    async def test_read_updates_cursor_correctly(self) -> None:
        """Reading should update the read cursor to the latest message."""
        registry = ParticipantRegistry()
        store = MessageStore()
        r = await tool_comms_join(registry, name="alice", conversation="general")

        for i in range(3):
            store.add(
                "general",
                {
                    "id": f"cur-{i}",
                    "ts": f"2026-03-13T14:{i:02d}:00-05:00",
                    "sender": {"key": "other123", "name": "x", "type": "claude"},
                    "body": f"msg {i}",
                    "conv": "general",
                },
            )

        tool_comms_read(registry, store, key=r["key"], conversation="general")
        cursor = registry.get_cursor(r["key"], "general")
        assert cursor == "2026-03-13T14:02:00-05:00"

        # Add more messages
        store.add(
            "general",
            {
                "id": "cur-3",
                "ts": "2026-03-13T14:03:00-05:00",
                "sender": {"key": "other123", "name": "x", "type": "claude"},
                "body": "msg 3",
                "conv": "general",
            },
        )

        check = tool_comms_check(registry, store, key=r["key"])
        assert check["total_unread"] == 1  # only the new message

    @pytest.mark.asyncio
    async def test_broker_publish_exception_handled(self) -> None:
        """Various exception types from publish should be handled."""
        registry = ParticipantRegistry()
        r = await tool_comms_join(registry, name="alice", conversation="general")

        async def timeout_pub(topic, payload):
            raise TimeoutError("Connection timed out")

        result = await tool_comms_send(
            registry,
            timeout_pub,
            key=r["key"],
            conversation="general",
            message="will timeout",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_conversations_with_unread_counts(self) -> None:
        """Verify unread counts in conversations listing."""
        from claude_comms.mcp_tools import tool_comms_conversations

        registry = ParticipantRegistry()
        store = MessageStore()
        r = await tool_comms_join(registry, name="alice", conversation="general")
        await tool_comms_join(registry, key=r["key"], conversation="dev")

        # Add messages to both conversations
        for i in range(3):
            store.add(
                "general",
                {
                    "id": f"gen-{i}",
                    "ts": f"2026-03-13T14:{i:02d}:00-05:00",
                    "sender": {"key": "other123", "name": "x", "type": "claude"},
                    "body": f"gen {i}",
                    "conv": "general",
                },
            )
        store.add(
            "dev",
            {
                "id": "dev-0",
                "ts": "2026-03-13T14:00:00-05:00",
                "sender": {"key": "other123", "name": "x", "type": "claude"},
                "body": "dev msg",
                "conv": "dev",
            },
        )

        result = tool_comms_conversations(registry, store, key=r["key"])
        conv_map = {c["conversation"]: c for c in result["conversations"]}
        assert conv_map["general"]["unread_count"] == 3
        assert conv_map["dev"]["unread_count"] == 1

        # Read general, then check again
        tool_comms_read(registry, store, key=r["key"], conversation="general")
        result2 = tool_comms_conversations(registry, store, key=r["key"])
        conv_map2 = {c["conversation"]: c for c in result2["conversations"]}
        assert conv_map2["general"]["unread_count"] == 0
        assert conv_map2["dev"]["unread_count"] == 1
