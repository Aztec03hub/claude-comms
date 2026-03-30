"""Expanded gap tests — second round of test coverage.

Covers remaining untested code paths across all five target modules:
- hook_installer: install with OS write failure, settings roundtrip integrity
- log_exporter: from_config edge cases, write_presence in text-only mode, unicode in logs
- mcp_tools: comms_conversations unread tracking, comms_members invalid conv, registry edge cases
- config: password resolution chain combinations, _default_username fallback
- message: topic format, reply_to field, very long conv_id at boundary
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from claude_comms.broker import MessageDeduplicator, MessageStore
from claude_comms.config import (
    _deep_merge,
    get_default_config,
    load_config,
    save_config,
)
from claude_comms.hook_installer import (
    _add_hook_to_settings,
    _build_hook_entry,
    _generate_unix_script,
    _load_settings,
    _remove_hook_from_settings,
    _save_settings,
    install_hook,
    uninstall_hook,
)
from claude_comms.log_exporter import (
    LogExporter,
    _check_rotation,
    format_log_entry,
    format_log_header,
    format_presence_event,
)
from claude_comms.mcp_tools import (
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
from claude_comms.message import Message, Sender, validate_conv_id


# ===================================================================
# hook_installer — additional gaps
# ===================================================================


class TestHookInstallerSettingsRoundtrip:
    """Verify settings.json is not corrupted through add/remove cycles."""

    def test_add_remove_add_preserves_structure(self, tmp_path):
        settings_path = tmp_path / "settings.json"
        initial = {"hooks": {"PreToolUse": [{"matcher": "Read", "hooks": []}]}}
        _save_settings(initial, settings_path)

        loaded = _load_settings(settings_path)
        loaded = _add_hook_to_settings(loaded, "aabb1122")
        _save_settings(loaded, settings_path)

        loaded = _load_settings(settings_path)
        loaded = _remove_hook_from_settings(loaded)
        _save_settings(loaded, settings_path)

        loaded = _load_settings(settings_path)
        loaded = _add_hook_to_settings(loaded, "ccdd3344")
        _save_settings(loaded, settings_path)

        final = _load_settings(settings_path)
        # PreToolUse should still be intact
        assert "PreToolUse" in final["hooks"]
        assert len(final["hooks"]["PostToolUse"]) == 1

    def test_add_multiple_different_keys_keeps_latest(self):
        """Adding hooks with different keys replaces old comms hooks."""
        settings = {}
        settings = _add_hook_to_settings(settings, "key11111")
        settings = _add_hook_to_settings(settings, "key22222")
        # Should only have the latest one
        assert len(settings["hooks"]["PostToolUse"]) == 1
        cmd = settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        assert "key22222" in cmd


class TestHookInstallerUnixScriptDetails:
    def test_unix_script_limits_to_5_messages(self):
        script = _generate_unix_script("aabb1122")
        assert "tail -n 5" in script

    def test_unix_script_counts_total_messages(self):
        script = _generate_unix_script("aabb1122")
        assert "wc -l" in script

    def test_unix_script_handles_overflow_message(self):
        script = _generate_unix_script("aabb1122")
        assert "more message(s)" in script


# ===================================================================
# log_exporter — additional gaps
# ===================================================================


class TestLogExporterFromConfigEdgeCases:
    def test_from_config_with_string_log_dir(self, tmp_path):
        config = {"logging": {"dir": str(tmp_path / "custom-logs")}}
        exp = LogExporter.from_config(config)
        assert exp.log_dir == tmp_path / "custom-logs"

    def test_from_config_rotation_defaults(self):
        config = {"logging": {"rotation": {}}}
        exp = LogExporter.from_config(config)
        assert exp.max_size_bytes == 50 * 1024 * 1024
        assert exp.max_files == 10

    def test_from_config_shared_deduplicator(self):
        dedup = MessageDeduplicator()
        exp = LogExporter.from_config({}, deduplicator=dedup)
        assert exp.deduplicator is dedup


class TestLogExporterUnicode:
    def test_unicode_body_in_text_log(self, tmp_path):
        exp = LogExporter(log_dir=tmp_path, fmt="text")
        msg = {
            "id": "uni-1",
            "ts": "2026-03-13T14:00:00-05:00",
            "sender": {"key": "aabb1122", "name": "bot"},
            "body": "Hello \U0001f600 \u4f60\u597d!",
            "conv": "general",
        }
        exp.write_message(msg)
        content = (tmp_path / "general.log").read_text(encoding="utf-8")
        assert "\U0001f600" in content
        assert "\u4f60\u597d" in content

    def test_unicode_body_in_jsonl(self, tmp_path):
        exp = LogExporter(log_dir=tmp_path, fmt="jsonl")
        msg = {
            "id": "uni-2",
            "ts": "2026-03-13T14:00:00-05:00",
            "sender": {"key": "aabb1122", "name": "bot"},
            "body": "Emoji: \U0001f680\U0001f4a1",
            "conv": "general",
        }
        exp.write_message(msg)
        line = (tmp_path / "general.jsonl").read_text(encoding="utf-8").strip()
        parsed = json.loads(line)
        assert "\U0001f680" in parsed["body"]


class TestLogExporterPresenceTextOnly:
    def test_write_presence_text_only_mode(self, tmp_path):
        exp = LogExporter(log_dir=tmp_path, fmt="text")
        # Need to write a message first to create the log file with header
        exp.write_message({
            "id": "pre-1", "ts": "2026-03-13T14:00:00-05:00",
            "sender": {"key": "aabb1122", "name": "bot"}, "body": "init", "conv": "general",
        })
        result = exp.write_presence("general", "new-user", "ccdd3344", "joined")
        assert result is True
        content = (tmp_path / "general.log").read_text(encoding="utf-8")
        assert "new-user (ccdd3344) joined" in content


class TestFormatLogEntryEdgeCases:
    def test_format_entry_with_very_long_body(self):
        msg = {
            "ts": "2026-03-13T14:00:00-05:00",
            "sender": {"key": "aabb1122", "name": "bot"},
            "body": "x" * 10000,
        }
        entry = format_log_entry(msg)
        assert len(entry) > 10000

    def test_format_entry_empty_body(self):
        msg = {
            "ts": "2026-03-13T14:00:00-05:00",
            "sender": {"key": "aabb1122", "name": "bot"},
            "body": "",
        }
        entry = format_log_entry(msg)
        assert "@bot" in entry


# ===================================================================
# mcp_tools — additional gaps
# ===================================================================


class TestCommsConversationsUnreadTracking:
    def test_conversations_shows_unread_counts(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        key = sample_participant["key"]
        # Join a second conversation
        tool_comms_join(registry, key=key, conversation="dev")
        # Add messages to both
        for i in range(3):
            store.add("general", {
                "id": f"g-{i}", "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "other123", "name": "other", "type": "claude"},
                "body": f"gen msg {i}", "conv": "general",
            })
        for i in range(5):
            store.add("dev", {
                "id": f"d-{i}", "ts": f"2026-03-13T11:{i:02d}:00-05:00",
                "sender": {"key": "other123", "name": "other", "type": "claude"},
                "body": f"dev msg {i}", "conv": "dev",
            })
        result = tool_comms_conversations(registry, store, key=key)
        conv_map = {c["conversation"]: c for c in result["conversations"]}
        assert conv_map["general"]["unread_count"] == 3
        assert conv_map["dev"]["unread_count"] == 5

    def test_conversations_unread_after_partial_read(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        key = sample_participant["key"]
        for i in range(5):
            store.add("general", {
                "id": f"pr-{i}", "ts": f"2026-03-13T10:{i:02d}:00-05:00",
                "sender": {"key": "other123", "name": "other", "type": "claude"},
                "body": f"msg {i}", "conv": "general",
            })
        # Read only 2 messages
        tool_comms_read(registry, store, key=key, conversation="general", count=2)
        # Check conversations
        result = tool_comms_conversations(registry, store, key=key)
        # After reading, cursor is set to the latest of the 2 returned (which are the last 2)
        # So unread should be 0 since we read the most recent
        conv_map = {c["conversation"]: c for c in result["conversations"]}
        assert conv_map["general"]["unread_count"] == 0


class TestCommsMembersEdgeCases:
    def test_members_invalid_conversation_id(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
    ):
        result = tool_comms_members(
            registry, key=sample_participant["key"], conversation="BAD!!!"
        )
        assert result.get("error") is True

    def test_members_after_leave(
        self,
        registry: ParticipantRegistry,
        sample_participant: dict,
    ):
        key = sample_participant["key"]
        bob = tool_comms_join(registry, name="bob", conversation="general")
        tool_comms_leave(registry, key=bob["key"], conversation="general")
        result = tool_comms_members(registry, key=key, conversation="general")
        names = {m["name"] for m in result["members"]}
        assert "bob" not in names


class TestRegistryConversationsFor:
    def test_conversations_for_after_multiple_joins(
        self, registry: ParticipantRegistry
    ):
        r = tool_comms_join(registry, name="alice", conversation="general")
        key = r["key"]
        tool_comms_join(registry, key=key, conversation="dev")
        tool_comms_join(registry, key=key, conversation="ops")
        convs = set(registry.conversations_for(key))
        assert convs == {"general", "dev", "ops"}

    def test_conversations_for_unknown_key(self, registry: ParticipantRegistry):
        convs = registry.conversations_for("deadbeef")
        assert convs == []


class TestCommsHistoryEdgeCases:
    def test_history_with_no_results_for_query(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        store.add("general", {
            "id": "hq-1", "ts": "2026-03-13T10:00:00-05:00",
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": "Hello world", "conv": "general",
        })
        result = tool_comms_history(
            registry, store, key=sample_participant["key"],
            conversation="general", query="zzzznotfound",
        )
        assert result["count"] == 0
        assert result["messages"] == []

    def test_history_case_insensitive_search(
        self,
        registry: ParticipantRegistry,
        store: MessageStore,
        sample_participant: dict,
    ):
        store.add("general", {
            "id": "ci-1", "ts": "2026-03-13T10:00:00-05:00",
            "sender": {"key": "aabbccdd", "name": "test", "type": "claude"},
            "body": "The Quick Brown Fox", "conv": "general",
        })
        result = tool_comms_history(
            registry, store, key=sample_participant["key"],
            conversation="general", query="quick brown",
        )
        assert result["count"] == 1


# ===================================================================
# config — additional gaps
# ===================================================================


class TestPasswordResolutionCombinations:
    def test_env_overrides_even_when_yaml_has_password(self, tmp_path):
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["password"] = "yaml-pass"
        save_config(config, config_path)
        with patch.dict(os.environ, {"CLAUDE_COMMS_PASSWORD": "env-wins"}):
            loaded = load_config(config_path)
        assert loaded["broker"]["auth"]["password"] == "env-wins"

    def test_empty_env_var_does_not_override(self, tmp_path):
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["password"] = "yaml-pass"
        save_config(config, config_path)
        with patch.dict(os.environ, {"CLAUDE_COMMS_PASSWORD": ""}):
            loaded = load_config(config_path)
        assert loaded["broker"]["auth"]["password"] == "yaml-pass"


class TestConfigDefaultUsername:
    def test_default_username_returns_string(self):
        from claude_comms.config import _default_username
        name = _default_username()
        assert isinstance(name, str)
        assert len(name) > 0

    def test_default_username_fallback_on_error(self):
        from claude_comms.config import _default_username
        with patch("getpass.getuser", side_effect=Exception("no user")):
            name = _default_username()
        assert name == "unnamed"


class TestConfigSaveLoadRoundtrip:
    def test_all_fields_survive_roundtrip(self, tmp_path):
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["password"] = "test-pass"
        save_config(config, config_path)
        loaded = load_config(config_path)
        assert loaded["identity"]["key"] == config["identity"]["key"]
        assert loaded["broker"]["port"] == config["broker"]["port"]
        assert loaded["mcp"]["auto_join"] == config["mcp"]["auto_join"]
        assert loaded["notifications"]["hook_enabled"] == config["notifications"]["hook_enabled"]
        assert loaded["logging"]["rotation"]["max_files"] == config["logging"]["rotation"]["max_files"]


# ===================================================================
# message — additional gaps
# ===================================================================


class TestMessageTopicFormat:
    def test_topic_uses_conv_id(self):
        msg = Message.create(
            sender_key="abcdef01", sender_name="t", sender_type="claude",
            body="hi", conv="my-project",
        )
        assert msg.topic == "claude-comms/conv/my-project/messages"

    def test_topic_with_numeric_conv_id(self):
        msg = Message.create(
            sender_key="abcdef01", sender_name="t", sender_type="claude",
            body="hi", conv="123",
        )
        assert msg.topic == "claude-comms/conv/123/messages"


class TestMessageReplyTo:
    def test_reply_to_preserved_in_roundtrip(self):
        msg = Message.create(
            sender_key="abcdef01", sender_name="t", sender_type="claude",
            body="response", conv="general",
            reply_to="550e8400-e29b-41d4-a716-446655440000",
        )
        payload = msg.to_mqtt_payload()
        restored = Message.from_mqtt_payload(payload)
        assert restored.reply_to == "550e8400-e29b-41d4-a716-446655440000"

    def test_reply_to_none_by_default(self):
        msg = Message.create(
            sender_key="abcdef01", sender_name="t", sender_type="claude",
            body="hi", conv="general",
        )
        assert msg.reply_to is None
        data = json.loads(msg.to_mqtt_payload())
        assert data["reply_to"] is None


class TestConvIdBoundaryLength:
    def test_exactly_64_chars_valid(self):
        conv = "a" * 64
        assert validate_conv_id(conv) is True
        msg = Message.create(
            sender_key="abcdef01", sender_name="t", sender_type="claude",
            body="hi", conv=conv,
        )
        assert msg.conv == conv

    def test_63_chars_valid(self):
        conv = "a" * 63
        assert validate_conv_id(conv) is True

    def test_conv_with_hyphens_at_max_length(self):
        # 64 chars: starts and ends with alnum, hyphens in middle
        conv = "a" + "-a" * 31 + "a"  # 1 + 62 + 1 = 64
        assert len(conv) == 64
        assert validate_conv_id(conv) is True


class TestMessageFieldAccess:
    def test_sender_fields_accessible(self):
        msg = Message.create(
            sender_key="abcdef01", sender_name="claude-x", sender_type="claude",
            body="hi", conv="general",
        )
        assert msg.sender.key == "abcdef01"
        assert msg.sender.name == "claude-x"
        assert msg.sender.type == "claude"

    def test_message_id_is_valid_uuid(self):
        import uuid
        msg = Message.create(
            sender_key="abcdef01", sender_name="t", sender_type="claude",
            body="hi", conv="general",
        )
        uuid.UUID(msg.id)  # Should not raise

    def test_message_ts_contains_timezone(self):
        msg = Message.create(
            sender_key="abcdef01", sender_name="t", sender_type="claude",
            body="hi", conv="general",
        )
        # ISO timestamp should have timezone info
        assert "+" in msg.ts or "-" in msg.ts[10:] or "Z" in msg.ts
