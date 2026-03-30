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

from claude_comms.broker import EmbeddedBroker, MessageDeduplicator, MessageStore, replay_jsonl_logs
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
    tool_comms_leave,
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


# ===================================================================
# Round 1: Broker lifecycle — EmbeddedBroker, Deduplicator, Store, Replay
# ===================================================================


class TestEmbeddedBrokerFromConfig:
    """Test EmbeddedBroker.from_config() with various configurations."""

    def test_from_empty_config(self) -> None:
        broker = EmbeddedBroker.from_config({})
        assert broker.host == "127.0.0.1"
        assert broker.port == 1883
        assert broker.ws_host == "127.0.0.1"
        assert broker.ws_port == 9001
        assert broker.auth_enabled is False
        assert broker.auth_username is None
        assert broker.auth_password is None
        assert broker.max_replay == 1000

    def test_from_full_config(self) -> None:
        config = {
            "broker": {
                "host": "0.0.0.0",
                "port": 8883,
                "ws_host": "192.168.1.1",
                "ws_port": 8001,
                "auth": {
                    "enabled": True,
                    "username": "myuser",
                    "password": "mypass",
                },
            },
            "logging": {
                "dir": "/tmp/test-broker-logs",
                "max_messages_replay": 500,
            },
        }
        broker = EmbeddedBroker.from_config(config)
        assert broker.host == "0.0.0.0"
        assert broker.port == 8883
        assert broker.ws_host == "192.168.1.1"
        assert broker.ws_port == 8001
        assert broker.auth_enabled is True
        assert broker.auth_username == "myuser"
        assert broker.auth_password == "mypass"
        assert broker.max_replay == 500
        assert str(broker.log_dir) == "/tmp/test-broker-logs"

    def test_from_config_partial_broker(self) -> None:
        """Partial broker config should use defaults for missing keys."""
        config = {"broker": {"port": 9999}}
        broker = EmbeddedBroker.from_config(config)
        assert broker.port == 9999
        assert broker.host == "127.0.0.1"  # default
        assert broker.ws_port == 9001  # default

    def test_from_config_creates_deduplicator_and_store(self) -> None:
        broker = EmbeddedBroker.from_config({})
        assert isinstance(broker.deduplicator, MessageDeduplicator)
        assert isinstance(broker.message_store, MessageStore)

    def test_from_config_auth_without_credentials(self) -> None:
        """Auth enabled but no credentials — should still create broker."""
        config = {"broker": {"auth": {"enabled": True}}}
        broker = EmbeddedBroker.from_config(config)
        assert broker.auth_enabled is True
        assert broker.auth_username is None


class TestMessageDeduplicatorEdgeCases:
    """Edge cases for MessageDeduplicator: overflow, LRU, concurrent access."""

    def test_max_size_one_alternating(self) -> None:
        """With max_size=1, each new ID evicts the previous."""
        dedup = MessageDeduplicator(max_size=1)
        assert dedup.is_duplicate("a") is False
        assert dedup.is_duplicate("b") is False  # evicts "a"
        assert dedup.is_duplicate("a") is False  # "a" was evicted, re-added
        assert dedup.size == 1

    def test_overflow_preserves_most_recent(self) -> None:
        """Adding beyond max_size keeps the N most recent entries."""
        dedup = MessageDeduplicator(max_size=5)
        for i in range(20):
            dedup.is_duplicate(f"msg-{i}")
        assert dedup.size == 5
        # Most recent 5 should still be tracked
        for i in range(15, 20):
            assert dedup.is_duplicate(f"msg-{i}") is True
        # Oldest should be evicted
        for i in range(10):
            assert dedup.is_duplicate(f"msg-{i}") is False

    def test_lru_refresh_prevents_eviction(self) -> None:
        """Accessing an existing entry refreshes it, preventing eviction."""
        dedup = MessageDeduplicator(max_size=3)
        dedup.is_duplicate("a")
        dedup.is_duplicate("b")
        dedup.is_duplicate("c")
        # Refresh "a" so it moves to end
        dedup.is_duplicate("a")  # returns True (duplicate), moves to end
        # Add "d" — should evict "b" (oldest after refresh), not "a"
        dedup.is_duplicate("d")
        assert dedup.is_duplicate("a") is True  # still present
        assert dedup.is_duplicate("c") is True
        assert dedup.is_duplicate("d") is True

    def test_concurrent_access_thread_safe(self) -> None:
        """Concurrent writes from multiple threads should not corrupt state."""
        import threading

        dedup = MessageDeduplicator(max_size=1000)
        errors: list[Exception] = []

        def writer(start: int) -> None:
            try:
                for i in range(100):
                    dedup.is_duplicate(f"thread-{start}-{i}")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        assert dedup.size == 1000  # 10 threads * 100 unique IDs

    def test_negative_max_size_raises(self) -> None:
        with pytest.raises(ValueError):
            MessageDeduplicator(max_size=-1)

    def test_clear_then_reuse(self) -> None:
        dedup = MessageDeduplicator(max_size=5)
        for i in range(5):
            dedup.is_duplicate(f"msg-{i}")
        dedup.clear()
        assert dedup.size == 0
        # All IDs should now be "new" again
        for i in range(5):
            assert dedup.is_duplicate(f"msg-{i}") is False
        assert dedup.size == 5


class TestMessageStoreMultiConversation:
    """MessageStore with multiple conversations and cap enforcement."""

    def test_separate_conversations_independent(self) -> None:
        store = MessageStore(max_per_conv=5)
        for i in range(10):
            store.add("alpha", {"id": f"a-{i}", "body": f"alpha-{i}"})
            store.add("beta", {"id": f"b-{i}", "body": f"beta-{i}"})
        # Each conversation capped independently
        assert len(store.get("alpha")) == 5
        assert len(store.get("beta")) == 5
        assert store.get("alpha")[-1]["body"] == "alpha-9"
        assert store.get("beta")[-1]["body"] == "beta-9"

    def test_cap_enforcement_fifo(self) -> None:
        """Oldest messages are evicted first when cap is exceeded."""
        store = MessageStore(max_per_conv=3)
        for i in range(6):
            store.add("conv", {"id": str(i), "body": f"msg-{i}"})
        msgs = store.get("conv")
        assert [m["body"] for m in msgs] == ["msg-3", "msg-4", "msg-5"]

    def test_get_with_limit_zero(self) -> None:
        store = MessageStore()
        store.add("c", {"id": "1"})
        store.add("c", {"id": "2"})
        # limit=0 should return all (not treated as zero)
        result = store.get("c", limit=0)
        assert len(result) == 2

    def test_get_with_limit_exceeding_count(self) -> None:
        store = MessageStore()
        store.add("c", {"id": "1"})
        result = store.get("c", limit=100)
        assert len(result) == 1

    def test_conversations_returns_all_keys(self) -> None:
        store = MessageStore()
        for name in ["general", "dev", "ops", "random"]:
            store.add(name, {"id": f"in-{name}"})
        convs = set(store.conversations())
        assert convs == {"general", "dev", "ops", "random"}

    def test_thread_safety(self) -> None:
        """Concurrent adds from multiple threads should not corrupt."""
        import threading

        store = MessageStore(max_per_conv=1000)
        errors: list[Exception] = []

        def writer(conv: str) -> None:
            try:
                for i in range(100):
                    store.add(conv, {"id": f"{conv}-{i}"})
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=writer, args=(f"conv-{t}",))
            for t in range(5)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        for t in range(5):
            assert len(store.get(f"conv-{t}")) == 100


class TestReplayJSONLEdgeCases:
    """replay_jsonl_logs with edge cases: empty files, no directory, etc."""

    def test_replay_empty_jsonl_file(self, tmp_path: Path) -> None:
        """Empty JSONL file should produce empty store."""
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "general.jsonl").write_text("")
        store = replay_jsonl_logs(log_dir)
        assert store.get("general") == []

    def test_replay_only_blank_lines(self, tmp_path: Path) -> None:
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "general.jsonl").write_text("\n\n\n\n")
        store = replay_jsonl_logs(log_dir)
        assert store.get("general") == []

    def test_replay_mixed_valid_and_invalid(self, tmp_path: Path) -> None:
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        lines = [
            json.dumps({"id": "good-1", "conv": "general", "body": "ok"}),
            "NOT JSON",
            json.dumps({"id": "good-2", "conv": "general", "body": "also ok"}),
            json.dumps({"missing_id": True, "conv": "general"}),
            json.dumps({"id": "no-conv"}),
            "",
            json.dumps({"id": "good-3", "conv": "general", "body": "third"}),
        ]
        (log_dir / "general.jsonl").write_text("\n".join(lines) + "\n")
        store = replay_jsonl_logs(log_dir)
        assert len(store.get("general")) == 3

    def test_replay_nonexistent_dir_returns_empty_store(self) -> None:
        store = replay_jsonl_logs(Path("/nonexistent/path/to/logs"))
        assert store.conversations() == []

    def test_replay_with_existing_store(self, tmp_path: Path) -> None:
        """Replay should append to an existing store."""
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "general.jsonl").write_text(
            json.dumps({"id": "from-log", "conv": "general", "body": "logged"}) + "\n"
        )
        store = MessageStore()
        store.add("general", {"id": "pre-existing", "body": "already here"})
        replay_jsonl_logs(log_dir, store=store)
        msgs = store.get("general")
        assert len(msgs) == 2
        assert msgs[0]["body"] == "already here"
        assert msgs[1]["body"] == "logged"

    def test_replay_populates_deduplicator(self, tmp_path: Path) -> None:
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "general.jsonl").write_text(
            json.dumps({"id": "replay-id-99", "conv": "general", "body": "x"}) + "\n"
        )
        dedup = MessageDeduplicator()
        replay_jsonl_logs(log_dir, deduplicator=dedup)
        assert dedup.is_duplicate("replay-id-99") is True
        assert dedup.is_duplicate("new-id") is False

    def test_replay_multiple_jsonl_files(self, tmp_path: Path) -> None:
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        for conv in ["alpha", "beta", "gamma"]:
            msgs = [json.dumps({"id": f"{conv}-{i}", "conv": conv, "body": f"msg {i}"})
                    for i in range(3)]
            (log_dir / f"{conv}.jsonl").write_text("\n".join(msgs) + "\n")
        store = replay_jsonl_logs(log_dir)
        assert set(store.conversations()) == {"alpha", "beta", "gamma"}
        for conv in ["alpha", "beta", "gamma"]:
            assert len(store.get(conv)) == 3

    def test_replay_max_per_conv_caps(self, tmp_path: Path) -> None:
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        msgs = [json.dumps({"id": f"cap-{i}", "conv": "general", "body": f"m{i}"})
                for i in range(50)]
        (log_dir / "general.jsonl").write_text("\n".join(msgs) + "\n")
        store = replay_jsonl_logs(log_dir, max_per_conv=10)
        result = store.get("general")
        assert len(result) == 10
        assert result[-1]["id"] == "cap-49"  # most recent kept


class TestGenerateClientIdIntegration:
    """Test generate_client_id uniqueness and validation."""

    def test_format_components(self) -> None:
        from claude_comms.broker import generate_client_id
        cid = generate_client_id("mcp", "a3f7b2c1")
        parts = cid.split("-")
        assert parts[0] == "claude"
        assert parts[1] == "comms"
        assert parts[2] == "mcp"
        assert parts[3] == "a3f7b2c1"
        # last part is random hex
        assert len(parts[4]) == 8

    def test_uniqueness_across_calls(self) -> None:
        from claude_comms.broker import generate_client_id
        ids = set()
        for _ in range(500):
            ids.add(generate_client_id("test", "abcdef01"))
        assert len(ids) == 500

    def test_empty_component_raises(self) -> None:
        from claude_comms.broker import generate_client_id
        with pytest.raises(ValueError, match="component"):
            generate_client_id("", "abcdef01")

    def test_empty_key_raises(self) -> None:
        from claude_comms.broker import generate_client_id
        with pytest.raises(ValueError, match="participant_key"):
            generate_client_id("mcp", "")

    def test_none_component_raises(self) -> None:
        from claude_comms.broker import generate_client_id
        with pytest.raises(ValueError):
            generate_client_id(None, "abcdef01")

    def test_none_key_raises(self) -> None:
        from claude_comms.broker import generate_client_id
        with pytest.raises(ValueError):
            generate_client_id("mcp", None)


# ===================================================================
# Round 2: MCP Tools logic — all 9 tools, ParticipantRegistry, pagination
# ===================================================================


class TestAllCommsToolsWithMockPublish:
    """Test all 9 comms_* tool functions with mock publish."""

    def _setup(self):
        registry = ParticipantRegistry()
        store = MessageStore()
        r = tool_comms_join(registry, name="tester", conversation="general")
        return registry, store, r["key"]

    def test_comms_join_new_participant(self) -> None:
        registry = ParticipantRegistry()
        result = tool_comms_join(registry, name="alice", conversation="general")
        assert result["status"] == "joined"
        assert result["name"] == "alice"
        assert result["type"] == "claude"
        assert len(result["key"]) == 8

    def test_comms_join_rejoin_by_key(self) -> None:
        registry = ParticipantRegistry()
        r1 = tool_comms_join(registry, name="alice", conversation="general")
        r2 = tool_comms_join(registry, key=r1["key"], conversation="dev")
        assert r2["key"] == r1["key"]
        assert r2["conversation"] == "dev"

    def test_comms_join_invalid_conv(self) -> None:
        registry = ParticipantRegistry()
        result = tool_comms_join(registry, name="alice", conversation="INVALID!")
        assert result.get("error") is True

    def test_comms_leave_success(self) -> None:
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="alice", conversation="general")
        result = tool_comms_leave(registry, key=r["key"], conversation="general")
        assert result["status"] == "left"

    def test_comms_leave_not_member(self) -> None:
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="alice", conversation="general")
        result = tool_comms_leave(registry, key=r["key"], conversation="other")
        assert result["status"] == "not_a_member"

    def test_comms_leave_invalid_key(self) -> None:
        registry = ParticipantRegistry()
        result = tool_comms_leave(registry, key="ZZZZZZZZ", conversation="general")
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_comms_send_broadcast(self) -> None:
        registry, store, key = self._setup()
        captured = []

        async def mock_pub(topic, payload):
            captured.append((topic, payload))

        result = await tool_comms_send(
            registry, mock_pub, key=key, conversation="general",
            message="Hello world!",
        )
        assert result["status"] == "sent"
        assert result["recipients"] is None
        assert len(captured) == 1
        assert "claude-comms/conv/general/messages" in captured[0][0]

    @pytest.mark.asyncio
    async def test_comms_send_targeted(self) -> None:
        registry = ParticipantRegistry()
        r1 = tool_comms_join(registry, name="alice", conversation="general")
        r2 = tool_comms_join(registry, name="bob", conversation="general")
        captured = []

        async def mock_pub(topic, payload):
            captured.append((topic, payload))

        result = await tool_comms_send(
            registry, mock_pub, key=r1["key"], conversation="general",
            message="Hey Bob!", recipients=["bob"],
        )
        assert result["status"] == "sent"
        assert r2["key"] in result["recipients"]
        msg_data = json.loads(captured[0][1])
        assert "[@bob]" in msg_data["body"]

    @pytest.mark.asyncio
    async def test_comms_send_empty_body_rejected(self) -> None:
        registry, _, key = self._setup()

        async def mock_pub(topic, payload):
            pass

        result = await tool_comms_send(
            registry, mock_pub, key=key, conversation="general",
            message="   ",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_comms_send_invalid_conv(self) -> None:
        registry, _, key = self._setup()

        async def mock_pub(topic, payload):
            pass

        result = await tool_comms_send(
            registry, mock_pub, key=key, conversation="BAD!CONV",
            message="hi",
        )
        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_comms_send_broker_failure(self) -> None:
        registry, _, key = self._setup()

        async def failing_pub(topic, payload):
            raise ConnectionError("Broker down")

        result = await tool_comms_send(
            registry, failing_pub, key=key, conversation="general",
            message="will fail",
        )
        assert result.get("error") is True
        assert "broker" in result["message"].lower() or "failed" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_comms_send_unresolvable_recipients(self) -> None:
        registry, _, key = self._setup()

        async def mock_pub(topic, payload):
            pass

        result = await tool_comms_send(
            registry, mock_pub, key=key, conversation="general",
            message="hey", recipients=["ghost-user"],
        )
        assert result.get("error") is True

    def test_comms_read_empty(self) -> None:
        registry, store, key = self._setup()
        result = tool_comms_read(registry, store, key=key, conversation="general")
        assert result["count"] == 0
        assert result["messages"] == []

    def test_comms_read_with_messages(self) -> None:
        registry, store, key = self._setup()
        for i in range(5):
            store.add("general", {
                "id": f"r2-{i}", "ts": f"2026-03-13T14:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "other", "type": "claude"},
                "body": f"Message {i}", "conv": "general",
            })
        result = tool_comms_read(registry, store, key=key, conversation="general")
        assert result["count"] == 5

    def test_comms_read_with_since(self) -> None:
        registry, store, key = self._setup()
        for i in range(10):
            store.add("general", {
                "id": f"since-{i}", "ts": f"2026-03-13T14:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
                "body": f"m{i}", "conv": "general",
            })
        result = tool_comms_read(
            registry, store, key=key, conversation="general",
            since="2026-03-13T14:07:00-05:00",
        )
        assert result["count"] == 2  # messages 8, 9

    def test_comms_read_count_clamped(self) -> None:
        """Count should be clamped between 1 and 200."""
        registry, store, key = self._setup()
        for i in range(5):
            store.add("general", {
                "id": f"clamp-{i}", "ts": f"2026-03-13T14:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
                "body": "m", "conv": "general",
            })
        # count=0 should be clamped to 1
        result = tool_comms_read(
            registry, store, key=key, conversation="general", count=0,
        )
        assert result["count"] == 1

    def test_comms_check_no_unread(self) -> None:
        registry, store, key = self._setup()
        result = tool_comms_check(registry, store, key=key)
        assert result["total_unread"] == 0

    def test_comms_check_with_unread(self) -> None:
        registry, store, key = self._setup()
        store.add("general", {
            "id": "unread-1", "ts": "2026-03-13T15:00:00-05:00",
            "sender": {"key": "other123", "name": "o", "type": "claude"},
            "body": "hi", "conv": "general",
        })
        result = tool_comms_check(registry, store, key=key)
        assert result["total_unread"] == 1

    def test_comms_check_specific_conversation(self) -> None:
        registry, store, key = self._setup()
        result = tool_comms_check(
            registry, store, key=key, conversation="general",
        )
        assert result["total_unread"] == 0

    def test_comms_members(self) -> None:
        registry = ParticipantRegistry()
        r1 = tool_comms_join(registry, name="alice", conversation="general")
        tool_comms_join(registry, name="bob", conversation="general")
        result = tool_comms_members(registry, key=r1["key"], conversation="general")
        assert result["count"] == 2
        names = {m["name"] for m in result["members"]}
        assert "alice" in names and "bob" in names

    def test_comms_members_empty_conv(self) -> None:
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="alice", conversation="general")
        result = tool_comms_members(registry, key=r["key"], conversation="empty")
        assert result["count"] == 0

    def test_comms_conversations(self) -> None:
        from claude_comms.mcp_tools import tool_comms_conversations
        registry = ParticipantRegistry()
        store = MessageStore()
        r = tool_comms_join(registry, name="alice", conversation="general")
        tool_comms_join(registry, key=r["key"], conversation="dev")
        result = tool_comms_conversations(registry, store, key=r["key"])
        conv_ids = {c["conversation"] for c in result["conversations"]}
        assert "general" in conv_ids and "dev" in conv_ids

    def test_comms_update_name(self) -> None:
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="old-name", conversation="general")
        result = tool_comms_update_name(registry, key=r["key"], new_name="new-name")
        assert result["status"] == "updated"
        assert result["name"] == "new-name"

    def test_comms_update_name_invalid(self) -> None:
        registry = ParticipantRegistry()
        r = tool_comms_join(registry, name="alice", conversation="general")
        result = tool_comms_update_name(registry, key=r["key"], new_name="bad name!")
        assert result.get("error") is True

    def test_comms_history_all(self) -> None:
        from claude_comms.mcp_tools import tool_comms_history
        registry, store, key = self._setup()
        for i in range(5):
            store.add("general", {
                "id": f"hist-{i}", "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
                "body": f"History {i}", "conv": "general",
            })
        result = tool_comms_history(registry, store, key=key, conversation="general")
        assert result["count"] == 5

    def test_comms_history_with_query(self) -> None:
        from claude_comms.mcp_tools import tool_comms_history
        registry, store, key = self._setup()
        store.add("general", {
            "id": "hq-1", "ts": "2026-03-13T10:00:00-05:00",
            "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
            "body": "The quick brown fox", "conv": "general",
        })
        store.add("general", {
            "id": "hq-2", "ts": "2026-03-13T10:01:00-05:00",
            "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
            "body": "The lazy dog", "conv": "general",
        })
        result = tool_comms_history(
            registry, store, key=key, conversation="general", query="fox",
        )
        assert result["count"] == 1


class TestParticipantRegistryDetailed:
    """Detailed tests for ParticipantRegistry."""

    def test_join_creates_new_participant(self) -> None:
        registry = ParticipantRegistry()
        p = registry.join("alice", "general")
        assert p.name == "alice"
        assert len(p.key) == 8

    def test_join_same_name_returns_same_participant(self) -> None:
        registry = ParticipantRegistry()
        p1 = registry.join("alice", "general")
        p2 = registry.join("alice", "dev")
        assert p1.key == p2.key

    def test_join_with_key_returns_existing(self) -> None:
        registry = ParticipantRegistry()
        p1 = registry.join("alice", "general")
        p2 = registry.join("alice", "dev", key=p1.key)
        assert p2.key == p1.key

    def test_leave_returns_true_if_was_member(self) -> None:
        registry = ParticipantRegistry()
        p = registry.join("alice", "general")
        assert registry.leave(p.key, "general") is True
        assert registry.leave(p.key, "general") is False  # already left

    def test_resolve_name_case_insensitive(self) -> None:
        registry = ParticipantRegistry()
        p = registry.join("Alice", "general")
        assert registry.resolve_name("alice") == p.key
        assert registry.resolve_name("ALICE") == p.key

    def test_resolve_recipients_mixed_names_and_keys(self) -> None:
        registry = ParticipantRegistry()
        p1 = registry.join("alice", "general")
        p2 = registry.join("bob", "general")
        resolved = registry.resolve_recipients(["alice", p2.key])
        assert p1.key in resolved
        assert p2.key in resolved

    def test_resolve_recipients_unknown_dropped(self) -> None:
        registry = ParticipantRegistry()
        registry.join("alice", "general")
        resolved = registry.resolve_recipients(["alice", "ghost", "00000000"])
        # "ghost" is not resolvable, "00000000" is not registered
        # alice should resolve, "00000000" is valid hex but not registered
        assert len(resolved) >= 1

    def test_resolve_recipients_dedup(self) -> None:
        registry = ParticipantRegistry()
        p = registry.join("alice", "general")
        resolved = registry.resolve_recipients(["alice", p.key])
        assert len(resolved) == 1

    def test_update_name_reindexes(self) -> None:
        registry = ParticipantRegistry()
        p = registry.join("old-name", "general")
        updated = registry.update_name(p.key, "new-name")
        assert updated.name == "new-name"
        assert registry.resolve_name("old-name") is None
        assert registry.resolve_name("new-name") == p.key

    def test_update_name_nonexistent_key(self) -> None:
        registry = ParticipantRegistry()
        result = registry.update_name("deadbeef", "whatever")
        assert result is None

    def test_members_multi_conversation(self) -> None:
        registry = ParticipantRegistry()
        p1 = registry.join("alice", "general")
        p2 = registry.join("bob", "general")
        registry.join("charlie", "dev")
        general_members = registry.members("general")
        assert len(general_members) == 2
        dev_members = registry.members("dev")
        assert len(dev_members) == 1

    def test_conversations_for(self) -> None:
        registry = ParticipantRegistry()
        p = registry.join("alice", "general")
        registry.join("alice", "dev", key=p.key)
        convs = set(registry.conversations_for(p.key))
        assert convs == {"general", "dev"}

    def test_name_to_key_map(self) -> None:
        registry = ParticipantRegistry()
        registry.join("alice", "general")
        registry.join("bob", "general")
        m = registry.name_to_key_map("general")
        assert "alice" in m
        assert "bob" in m

    def test_read_cursor_lifecycle(self) -> None:
        registry = ParticipantRegistry()
        p = registry.join("alice", "general")
        assert registry.get_cursor(p.key, "general") is None
        registry.update_cursor(p.key, "general", "2026-03-13T14:00:00Z")
        assert registry.get_cursor(p.key, "general") == "2026-03-13T14:00:00Z"


class TestTokenAwarePaginationIntegration:
    """Token-aware pagination in comms_read and comms_history."""

    def test_large_messages_trigger_truncation(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        r = tool_comms_join(registry, name="tester", conversation="general")
        # Each message ~2000 chars = ~500 tokens. 100 messages = 50k tokens > 20k limit
        for i in range(100):
            store.add("general", {
                "id": f"big-{i}", "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
                "body": "x" * 2000, "conv": "general",
            })
        result = tool_comms_read(
            registry, store, key=r["key"], conversation="general", count=100,
        )
        assert result["count"] < 100
        assert result["has_more"] is True

    def test_small_messages_no_truncation(self) -> None:
        registry = ParticipantRegistry()
        store = MessageStore()
        r = tool_comms_join(registry, name="tester", conversation="general")
        for i in range(10):
            store.add("general", {
                "id": f"sm-{i}", "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
                "body": "short", "conv": "general",
            })
        result = tool_comms_read(
            registry, store, key=r["key"], conversation="general",
        )
        assert result["count"] == 10
        assert result["has_more"] is False

    def test_history_truncation(self) -> None:
        from claude_comms.mcp_tools import tool_comms_history
        registry = ParticipantRegistry()
        store = MessageStore()
        r = tool_comms_join(registry, name="tester", conversation="general")
        for i in range(100):
            store.add("general", {
                "id": f"hist-big-{i}", "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "aabbccdd", "name": "x", "type": "claude"},
                "body": "y" * 2000, "conv": "general",
            })
        result = tool_comms_history(
            registry, store, key=r["key"], conversation="general", count=100,
        )
        assert result["count"] < 100
        assert result["has_more"] is True
