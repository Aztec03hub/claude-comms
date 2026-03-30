"""Integration tests for claude-comms.

Tests component interactions WITHOUT a real MQTT broker:
- Config -> CLI init flow (config created, permissions set)
- Message creation -> serialization -> deserialization roundtrip
- Mention parsing -> recipient resolution pipeline
- Log exporter: message -> .log + .jsonl file content verification
- MessageDeduplicator: duplicate detection across components
- Participant registry: join, name resolution, name change
- Hook installer: generates correct script content for platform
- MCP tools: send -> store -> read pipeline (using mock publish)
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from claude_comms.broker import MessageDeduplicator, MessageStore
from claude_comms.config import (
    get_default_config,
    load_config,
    save_config,
)
from claude_comms.hook_installer import (
    _generate_unix_script,
    _generate_windows_script,
    generate_hook_script,
)
from claude_comms.log_exporter import LogExporter, format_log_entry, format_log_header
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_check,
    tool_comms_join,
    tool_comms_members,
    tool_comms_read,
    tool_comms_send,
    tool_comms_update_name,
)
from claude_comms.mention import (
    build_mention_prefix,
    extract_mentions,
    resolve_mentions,
    strip_mentions,
)
from claude_comms.message import Message, Sender


# ===================================================================
# Config -> CLI init flow
# ===================================================================


class TestConfigInitFlow:
    """Config creation, loading, permissions, and round-trip."""

    def test_init_creates_config_with_key(self, tmp_path: Path) -> None:
        config = get_default_config()
        assert len(config["identity"]["key"]) == 8
        assert config["identity"]["type"] == "human"

    def test_save_and_load_roundtrip(self, tmp_path: Path) -> None:
        config = get_default_config()
        config["identity"]["name"] = "integration-test"
        config_path = tmp_path / "config.yaml"

        saved = save_config(config, config_path)
        assert saved == config_path
        assert config_path.exists()

        loaded = load_config(config_path)
        assert loaded["identity"]["name"] == "integration-test"
        assert loaded["identity"]["key"] == config["identity"]["key"]

    def test_save_sets_permissions(self, tmp_path: Path) -> None:
        config = get_default_config()
        config_path = tmp_path / "config.yaml"
        save_config(config, config_path)

        mode = config_path.stat().st_mode
        # Owner read/write should be set
        assert mode & stat.S_IRUSR
        assert mode & stat.S_IWUSR
        # Others should NOT have access
        assert not (mode & stat.S_IROTH)
        assert not (mode & stat.S_IWOTH)

    def test_save_creates_parent_dirs(self, tmp_path: Path) -> None:
        config = get_default_config()
        config_path = tmp_path / "subdir" / "deep" / "config.yaml"
        save_config(config, config_path)
        assert config_path.exists()

    def test_load_with_missing_keys_fills_defaults(self, tmp_path: Path) -> None:
        """A partial config file should be merged with defaults."""
        config_path = tmp_path / "config.yaml"
        # Write a minimal config
        config_path.write_text("identity:\n  key: aabbccdd\n  name: partial\n  type: claude\n")

        loaded = load_config(config_path)
        # Should have broker defaults filled in
        assert loaded["broker"]["port"] == 1883
        assert loaded["mcp"]["port"] == 9920
        assert loaded["default_conversation"] == "general"

    def test_env_password_overrides_config(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["password"] = "yaml-password"
        save_config(config, config_path)

        monkeypatch.setenv("CLAUDE_COMMS_PASSWORD", "env-password")
        loaded = load_config(config_path)
        assert loaded["broker"]["auth"]["password"] == "env-password"


# ===================================================================
# Message creation -> serialization -> deserialization roundtrip
# ===================================================================


class TestMessageRoundtrip:
    """Full lifecycle: create, serialize to MQTT payload, deserialize, verify."""

    def test_full_roundtrip_broadcast(self) -> None:
        msg = Message.create(
            sender_key="a3f7b2c1",
            sender_name="claude-test",
            sender_type="claude",
            body="Integration test message",
            conv="general",
        )

        # Serialize
        payload = msg.to_mqtt_payload()
        assert isinstance(payload, str)

        # Deserialize
        restored = Message.from_mqtt_payload(payload)
        assert restored.id == msg.id
        assert restored.sender.key == "a3f7b2c1"
        assert restored.sender.name == "claude-test"
        assert restored.body == "Integration test message"
        assert restored.conv == "general"
        assert restored.recipients is None
        assert restored.is_broadcast

    def test_full_roundtrip_targeted(self) -> None:
        msg = Message.create(
            sender_key="a3f7b2c1",
            sender_name="claude-test",
            sender_type="claude",
            body="[@bob] Hey Bob!",
            conv="project-x",
            recipients=["b2e19d04"],
            reply_to="00000000-0000-0000-0000-000000000000",
        )

        payload = msg.to_mqtt_payload()
        restored = Message.from_mqtt_payload(payload.encode("utf-8"))

        assert not restored.is_broadcast
        assert restored.recipients == ["b2e19d04"]
        assert restored.is_for("b2e19d04")
        assert not restored.is_for("ffffffff")
        assert restored.reply_to == "00000000-0000-0000-0000-000000000000"

    def test_roundtrip_preserves_json_structure(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="test",
            sender_type="human",
            body="hello",
            conv="general",
        )
        data = json.loads(msg.to_mqtt_payload())
        assert set(data.keys()) == {
            "id", "ts", "sender", "recipients", "body", "reply_to", "conv"
        }
        assert set(data["sender"].keys()) == {"key", "name", "type"}

    def test_topic_derivation(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="test",
            sender_type="claude",
            body="hi",
            conv="project-alpha",
        )
        assert msg.topic == "claude-comms/conv/project-alpha/messages"


# ===================================================================
# Mention parsing -> recipient resolution pipeline
# ===================================================================


class TestMentionResolutionPipeline:
    """Test the full pipeline: body with mentions -> extract -> resolve to keys."""

    def test_extract_and_resolve(self) -> None:
        body = "[@alice, @bob] Check this out!"
        names = extract_mentions(body)
        assert names == ["alice", "bob"]

        name_to_key = {"alice": "a1b2c3d4", "bob": "e5f6a7b8"}
        keys = resolve_mentions(body, name_to_key)
        assert keys == ["a1b2c3d4", "e5f6a7b8"]

    def test_resolve_with_missing_name(self) -> None:
        body = "[@alice, @ghost] Hello"
        name_to_key = {"alice": "a1b2c3d4"}
        keys = resolve_mentions(body, name_to_key)
        assert keys == ["a1b2c3d4"]
        # ghost is silently dropped

    def test_resolve_deduplicates(self) -> None:
        body = "[@alice, @alice] Duplicate mention"
        name_to_key = {"alice": "a1b2c3d4"}
        keys = resolve_mentions(body, name_to_key)
        assert keys == ["a1b2c3d4"]
        assert len(keys) == 1

    def test_build_prefix_and_strip(self) -> None:
        prefix = build_mention_prefix(["alice", "bob"])
        assert prefix == "[@alice, @bob] "

        full_body = prefix + "Hello everyone"
        stripped = strip_mentions(full_body)
        assert stripped == "Hello everyone"

    def test_no_mentions_gives_empty(self) -> None:
        body = "Just a plain message"
        names = extract_mentions(body)
        assert names == []

        keys = resolve_mentions(body, {"alice": "a1b2c3d4"})
        assert keys == []

    def test_mentions_not_at_start_ignored(self) -> None:
        body = "Hey @alice how are you?"
        names = extract_mentions(body)
        assert names == []

    def test_mention_pipeline_with_registry(self) -> None:
        """End-to-end: register participants, resolve mentions from body."""
        registry = ParticipantRegistry()
        r1 = tool_comms_join(registry, name="alice", conversation="general")
        r2 = tool_comms_join(registry, name="bob", conversation="general")

        name_map = registry.name_to_key_map("general")
        body = "[@alice, @bob] Team meeting at 3pm"
        keys = resolve_mentions(body, name_map)

        assert r1["key"] in keys
        assert r2["key"] in keys


# ===================================================================
# Log exporter: message -> .log + .jsonl file content verification
# ===================================================================


class TestLogExporterIntegration:
    """Test LogExporter writes correct file content for messages."""

    def _make_msg(self, msg_id: str = "test-id-001", conv: str = "general") -> dict:
        return {
            "id": msg_id,
            "ts": "2026-03-13T14:23:45.123-05:00",
            "sender": {"key": "a3f7b2c1", "name": "claude-test", "type": "claude"},
            "body": "Hello from integration test",
            "conv": conv,
            "recipients": None,
            "reply_to": None,
        }

    def test_write_message_creates_both_files(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="both")
        msg = self._make_msg()
        result = exporter.write_message(msg)

        assert result is True
        assert (tmp_path / "general.log").exists()
        assert (tmp_path / "general.jsonl").exists()

    def test_log_file_content_format(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="text")
        msg = self._make_msg()
        exporter.write_message(msg)

        content = (tmp_path / "general.log").read_text()

        # Header should be present
        assert "CONVERSATION: general" in content
        assert "=" * 80 in content

        # Message entry
        assert "@claude-test" in content
        assert "(a3f7b2c1)" in content
        assert "Hello from integration test" in content

    def test_jsonl_file_content(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="jsonl")
        msg = self._make_msg()
        exporter.write_message(msg)

        content = (tmp_path / "general.jsonl").read_text().strip()
        data = json.loads(content)
        assert data["id"] == "test-id-001"
        assert data["sender"]["name"] == "claude-test"
        assert data["body"] == "Hello from integration test"

    def test_multiple_messages_appended(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="both")
        for i in range(3):
            msg = self._make_msg(msg_id=f"msg-{i}")
            msg["body"] = f"Message number {i}"
            exporter.write_message(msg)

        # JSONL: 3 lines
        jsonl_lines = (tmp_path / "general.jsonl").read_text().strip().split("\n")
        assert len(jsonl_lines) == 3

        # Log: all messages present
        log_content = (tmp_path / "general.log").read_text()
        for i in range(3):
            assert f"Message number {i}" in log_content

    def test_log_grep_patterns_work(self, tmp_path: Path) -> None:
        """Verify that standard grep patterns work on generated log files."""
        exporter = LogExporter(log_dir=tmp_path, fmt="text")

        msg1 = self._make_msg(msg_id="msg-1")
        msg1["body"] = "Important announcement"
        exporter.write_message(msg1)

        msg2 = self._make_msg(msg_id="msg-2")
        msg2["sender"]["name"] = "phil"
        msg2["sender"]["key"] = "00ff0e8a"
        msg2["body"] = "Got it, thanks!"
        exporter.write_message(msg2)

        content = (tmp_path / "general.log").read_text()

        # Grep for sender name
        lines = content.split("\n")
        phil_lines = [l for l in lines if "@phil" in l]
        assert len(phil_lines) >= 1

        # Grep for sender key
        key_lines = [l for l in lines if "(00ff0e8a)" in l]
        assert len(key_lines) >= 1

        # Grep for message content
        important_lines = [l for l in lines if "Important announcement" in l]
        assert len(important_lines) >= 1

    def test_presence_event_in_log(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="text")
        result = exporter.write_presence(
            "general",
            name="claude-nebula",
            key="c9d3e5f7",
            event="joined",
            ts_str="2026-03-13T14:46:00-05:00",
        )
        assert result is True

        content = (tmp_path / "general.log").read_text()
        assert "claude-nebula" in content
        assert "(c9d3e5f7)" in content
        assert "joined the conversation" in content

    def test_from_config_factory(self, tmp_config: dict, tmp_path: Path) -> None:
        exporter = LogExporter.from_config(tmp_config)
        assert str(tmp_path) in str(exporter.log_dir)

    def test_invalid_conv_id_rejected(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="both")
        msg = self._make_msg()
        msg["conv"] = "../escape"
        result = exporter.write_message(msg)
        assert result is False

    def test_text_only_no_jsonl(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="text")
        exporter.write_message(self._make_msg())
        assert (tmp_path / "general.log").exists()
        assert not (tmp_path / "general.jsonl").exists()

    def test_jsonl_only_no_log(self, tmp_path: Path) -> None:
        exporter = LogExporter(log_dir=tmp_path, fmt="jsonl")
        exporter.write_message(self._make_msg())
        assert not (tmp_path / "general.log").exists()
        assert (tmp_path / "general.jsonl").exists()


# ===================================================================
# MessageDeduplicator: duplicate detection across components
# ===================================================================


class TestDeduplicatorIntegration:
    """Test deduplicator used by LogExporter and across components."""

    def test_shared_deduplicator_blocks_log_dupes(self, tmp_path: Path) -> None:
        dedup = MessageDeduplicator()
        exporter = LogExporter(log_dir=tmp_path, fmt="jsonl", deduplicator=dedup)

        msg = {
            "id": "shared-dedup-001",
            "ts": "2026-03-13T14:00:00-05:00",
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": "First write",
            "conv": "general",
        }

        assert exporter.write_message(msg) is True
        assert exporter.write_message(msg) is False  # duplicate

        lines = (tmp_path / "general.jsonl").read_text().strip().split("\n")
        assert len(lines) == 1

    def test_deduplicator_eviction(self) -> None:
        dedup = MessageDeduplicator(max_size=5)
        for i in range(10):
            dedup.is_duplicate(f"msg-{i}")
        # Oldest should have been evicted
        assert dedup.size == 5
        # First 5 were evicted, so they're "new" again
        assert dedup.is_duplicate("msg-0") is False
        # Recent ones are still tracked
        assert dedup.is_duplicate("msg-9") is True

    def test_deduplicator_with_message_store(self) -> None:
        """Dedup shared between LogExporter and MessageStore writes."""
        dedup = MessageDeduplicator()
        store = MessageStore()

        msg_id = "cross-component-001"

        # Simulate: dedup marks it as seen
        assert dedup.is_duplicate(msg_id) is False
        store.add("general", {"id": msg_id, "body": "stored"})

        # Second encounter should be duplicate
        assert dedup.is_duplicate(msg_id) is True


# ===================================================================
# Participant registry: join, name resolution, name change
# ===================================================================


class TestParticipantRegistryIntegration:
    """Test registry interactions across join, resolve, and name change."""

    def test_join_resolve_name(self) -> None:
        registry = ParticipantRegistry()
        result = tool_comms_join(registry, name="alice", conversation="general")
        key = result["key"]

        resolved = registry.resolve_name("alice")
        assert resolved == key

        # Case-insensitive
        assert registry.resolve_name("Alice") == key

    def test_name_change_updates_resolution(self) -> None:
        registry = ParticipantRegistry()
        result = tool_comms_join(registry, name="old-name", conversation="general")
        key = result["key"]

        registry.update_name(key, "new-name")

        assert registry.resolve_name("old-name") is None
        assert registry.resolve_name("new-name") == key

    def test_name_change_preserves_membership(self) -> None:
        registry = ParticipantRegistry()
        result = tool_comms_join(registry, name="alice", conversation="general")
        key = result["key"]
        tool_comms_join(registry, key=key, conversation="dev")

        registry.update_name(key, "alice-v2")

        members_general = registry.members("general")
        members_dev = registry.members("dev")

        assert any(m.key == key and m.name == "alice-v2" for m in members_general)
        assert any(m.key == key and m.name == "alice-v2" for m in members_dev)

    def test_multi_conversation_membership(self) -> None:
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="alice", conversation="general")
        key = r["key"]
        tool_comms_join(registry, key=key, conversation="dev")
        tool_comms_join(registry, key=key, conversation="ops")

        convs = set(registry.conversations_for(key))
        assert convs == {"general", "dev", "ops"}

    def test_leave_removes_from_one_conversation(self) -> None:
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="alice", conversation="general")
        key = r["key"]
        tool_comms_join(registry, key=key, conversation="dev")

        registry.leave(key, "general")

        convs = set(registry.conversations_for(key))
        assert "general" not in convs
        assert "dev" in convs

    def test_resolve_recipients_mixed_names_and_keys(self) -> None:
        registry = ParticipantRegistry()
        r1 = tool_comms_join(registry, name="alice", conversation="general")
        r2 = tool_comms_join(registry, name="bob", conversation="general")

        resolved = registry.resolve_recipients(["alice", r2["key"]])
        assert r1["key"] in resolved
        assert r2["key"] in resolved


# ===================================================================
# Hook installer: generates correct script content for platform
# ===================================================================


class TestHookInstallerIntegration:
    """Test hook script generation produces valid, correct content."""

    def test_unix_script_has_required_sections(self) -> None:
        script = _generate_unix_script("a3f7b2c1")

        # Shebang
        assert script.startswith("#!/bin/bash")
        # Drains stdin
        assert "cat > /dev/null" in script
        # Checks notification file
        assert "a3f7b2c1.jsonl" in script
        # Outputs JSON with context
        assert "hookSpecificOutput" in script
        assert "additionalContext" in script
        # Uses the baked-in key
        assert "a3f7b2c1" in script

    def test_windows_script_has_required_sections(self) -> None:
        script = _generate_windows_script("a3f7b2c1")

        assert script.startswith("@echo off")
        assert "more > nul" in script
        assert "a3f7b2c1.jsonl" in script
        assert "hookSpecificOutput" in script
        assert "powershell" in script

    @patch("claude_comms.hook_installer._is_windows", return_value=False)
    def test_platform_dispatch_unix(self, _mock) -> None:
        script = generate_hook_script("aabbccdd")
        assert "#!/bin/bash" in script

    @patch("claude_comms.hook_installer._is_windows", return_value=True)
    def test_platform_dispatch_windows(self, _mock) -> None:
        script = generate_hook_script("aabbccdd")
        assert "@echo off" in script

    def test_different_keys_produce_different_scripts(self) -> None:
        script1 = _generate_unix_script("aaaaaaaa")
        script2 = _generate_unix_script("bbbbbbbb")
        assert "aaaaaaaa" in script1
        assert "bbbbbbbb" in script2
        assert "bbbbbbbb" not in script1


# ===================================================================
# MCP tools: send -> store -> read pipeline (using mock publish)
# ===================================================================


class TestMCPToolsPipeline:
    """Test the full MCP tool pipeline: join -> send -> store -> read."""

    @pytest.mark.asyncio
    async def test_send_store_read_pipeline(self) -> None:
        """Join, send a message (capturing it), store it, read it back."""
        registry = ParticipantRegistry()
        store = MessageStore()

        # Join
        r = tool_comms_join(registry, name="alice", conversation="general")
        key = r["key"]

        # Send with a spy that captures the message
        captured: list[tuple[str, bytes]] = []

        async def mock_publish(topic: str, payload: bytes) -> None:
            captured.append((topic, payload))

        result = await tool_comms_send(
            registry,
            mock_publish,
            key=key,
            conversation="general",
            message="Hello world!",
        )
        assert result["status"] == "sent"
        assert len(captured) == 1

        # Parse the published message and add to store
        topic, payload = captured[0]
        msg_data = json.loads(payload)
        store.add("general", msg_data)

        # Read it back
        read_result = tool_comms_read(
            registry, store, key=key, conversation="general"
        )
        assert read_result["count"] == 1
        assert read_result["messages"][0]["body"] == "Hello world!"
        assert read_result["messages"][0]["sender"]["key"] == key

    @pytest.mark.asyncio
    async def test_targeted_send_with_mentions(self) -> None:
        """Send a targeted message and verify mention prefix + recipients."""
        registry = ParticipantRegistry()
        store = MessageStore()

        r1 = tool_comms_join(registry, name="alice", conversation="general")
        r2 = tool_comms_join(registry, name="bob", conversation="general")

        captured: list[tuple[str, bytes]] = []

        async def mock_publish(topic: str, payload: bytes) -> None:
            captured.append((topic, payload))

        result = await tool_comms_send(
            registry,
            mock_publish,
            key=r1["key"],
            conversation="general",
            message="Hey Bob, check this!",
            recipients=["bob"],
        )
        assert result["status"] == "sent"
        assert r2["key"] in result["recipients"]

        msg_data = json.loads(captured[0][1])
        assert "[@bob]" in msg_data["body"]
        assert msg_data["recipients"] == [r2["key"]]

    @pytest.mark.asyncio
    async def test_send_then_check_unread(self) -> None:
        """Send a message from alice, check unread for bob."""
        registry = ParticipantRegistry()
        store = MessageStore()

        r_alice = tool_comms_join(registry, name="alice", conversation="general")
        r_bob = tool_comms_join(registry, name="bob", conversation="general")

        captured: list[tuple[str, bytes]] = []

        async def mock_publish(topic: str, payload: bytes) -> None:
            captured.append((topic, payload))

        await tool_comms_send(
            registry,
            mock_publish,
            key=r_alice["key"],
            conversation="general",
            message="Hey team!",
        )

        msg_data = json.loads(captured[0][1])
        store.add("general", msg_data)

        # Bob should have 1 unread
        check = tool_comms_check(registry, store, key=r_bob["key"])
        assert check["total_unread"] == 1

        # Bob reads messages
        tool_comms_read(
            registry, store, key=r_bob["key"], conversation="general"
        )

        # Now check again - should be 0 unread
        check2 = tool_comms_check(registry, store, key=r_bob["key"])
        assert check2["total_unread"] == 0

    @pytest.mark.asyncio
    async def test_send_to_log_exporter(self) -> None:
        """Send a message, write to LogExporter, verify log content."""
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="alice", conversation="general")

        captured: list[tuple[str, bytes]] = []

        async def mock_publish(topic: str, payload: bytes) -> None:
            captured.append((topic, payload))

        await tool_comms_send(
            registry,
            mock_publish,
            key=r["key"],
            conversation="general",
            message="Logged message",
        )

        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            exporter = LogExporter(log_dir=tmpdir, fmt="both")
            msg_data = json.loads(captured[0][1])
            exporter.write_message(msg_data)

            # Verify log content
            log_content = (Path(tmpdir) / "general.log").read_text()
            assert "@alice" in log_content
            assert "Logged message" in log_content

            jsonl_content = (Path(tmpdir) / "general.jsonl").read_text().strip()
            jsonl_data = json.loads(jsonl_content)
            assert jsonl_data["body"] == "Logged message"
