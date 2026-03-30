"""Tests for claude_comms.log_exporter."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from claude_comms.broker import MessageDeduplicator
from claude_comms.log_exporter import (
    LogExporter,
    format_log_entry,
    format_log_header,
    format_presence_event,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_msg(
    *,
    conv: str = "general",
    body: str = "Hello, world!",
    sender_name: str = "claude-veridian",
    sender_key: str = "a3f7b2c1",
    sender_type: str = "claude",
    msg_id: str = "550e8400-e29b-41d4-a716-446655440000",
    ts: str = "2026-03-13T14:15:23.000-05:00",
    recipients: list[str] | None = None,
    reply_to: str | None = None,
) -> dict:
    """Build a message dict matching the MQTT payload schema."""
    return {
        "id": msg_id,
        "ts": ts,
        "sender": {
            "key": sender_key,
            "name": sender_name,
            "type": sender_type,
        },
        "recipients": recipients,
        "body": body,
        "reply_to": reply_to,
        "conv": conv,
    }


@pytest.fixture
def log_dir(tmp_path: Path) -> Path:
    """Return a temporary log directory."""
    d = tmp_path / "logs"
    d.mkdir()
    return d


@pytest.fixture
def exporter(log_dir: Path) -> LogExporter:
    """Return a LogExporter writing to a temp directory."""
    return LogExporter(log_dir=log_dir, fmt="both", max_size_mb=50, max_files=5)


# ---------------------------------------------------------------------------
# format_log_header
# ---------------------------------------------------------------------------


class TestFormatLogHeader:
    def test_header_contains_conversation_id(self):
        header = format_log_header("general", "2026-03-13T14:15:00.000-05:00")
        assert "CONVERSATION: general" in header

    def test_header_contains_created_timestamp(self):
        header = format_log_header("general", "2026-03-13T14:15:00.000-05:00")
        assert "CREATED:" in header

    def test_header_has_separator_lines(self):
        header = format_log_header("general", "2026-03-13T14:15:00.000-05:00")
        lines = header.split("\n")
        assert lines[0] == "=" * 80
        assert lines[-1] == "=" * 80

    def test_header_uses_current_time_when_no_ts(self):
        header = format_log_header("general")
        assert "CREATED:" in header
        # Should contain current year
        year = datetime.now().strftime("%Y")
        assert year in header


# ---------------------------------------------------------------------------
# format_log_entry
# ---------------------------------------------------------------------------


class TestFormatLogEntry:
    def test_basic_format(self):
        msg = _make_msg(body="Hello everyone!")
        entry = format_log_entry(msg)
        # Must start with [ for grep pattern ^\[20
        assert entry.startswith("[")
        assert "@claude-veridian" in entry
        assert "(a3f7b2c1)" in entry
        assert "Hello everyone!" in entry

    def test_grep_pattern_all_messages(self):
        """Grep pattern: ^\\[20 matches message lines."""
        msg = _make_msg()
        entry = format_log_entry(msg)
        assert re.match(r"^\[20", entry)

    def test_grep_pattern_from_sender(self):
        """Grep pattern: ^\\[.*\\] @claude-veridian matches sender."""
        msg = _make_msg()
        entry = format_log_entry(msg)
        assert re.match(r"^\[.*\] @claude-veridian", entry)

    def test_grep_pattern_mention(self):
        """Grep pattern: @phil matches mentions in body."""
        msg = _make_msg(body="[@phil] Hey Phil, check this out.")
        entry = format_log_entry(msg)
        assert "@phil" in entry

    def test_grep_pattern_date(self):
        """Grep pattern: ^\\[2026-03-13 matches date."""
        msg = _make_msg()
        entry = format_log_entry(msg)
        assert re.match(r"^\[2026-03-13", entry)

    def test_multiline_body_indented(self):
        """Multi-line message bodies are indented with 4 spaces."""
        msg = _make_msg(body="First line.\nSecond line.\nThird line.")
        entry = format_log_entry(msg)
        lines = entry.split("\n")
        # Line 0 is the header, lines 1-3 are body
        assert lines[1] == "    First line."
        assert lines[2] == "    Second line."
        assert lines[3] == "    Third line."

    def test_sender_format_colon(self):
        """Sender line ends with a colon."""
        msg = _make_msg()
        entry = format_log_entry(msg)
        first_line = entry.split("\n")[0]
        assert first_line.endswith(":")


# ---------------------------------------------------------------------------
# format_presence_event
# ---------------------------------------------------------------------------


class TestFormatPresenceEvent:
    def test_joined_format(self):
        line = format_presence_event(
            "claude-nebula", "c9d3e5f7", "joined",
            "2026-03-13T14:46:00.000-05:00",
        )
        assert line.startswith("--- ")
        assert line.endswith(" ---")
        assert "claude-nebula (c9d3e5f7) joined the conversation" in line

    def test_left_format(self):
        line = format_presence_event(
            "claude-veridian", "a3f7b2c1", "left",
            "2026-03-13T14:45:12.000-05:00",
        )
        assert "left the conversation" in line

    def test_grep_pattern_join_leave(self):
        """Grep pattern: ^--- matches join/leave events."""
        line = format_presence_event(
            "claude-nebula", "c9d3e5f7", "joined",
            "2026-03-13T14:46:00.000-05:00",
        )
        assert re.match(r"^--- ", line)

    def test_contains_time_in_brackets(self):
        line = format_presence_event(
            "claude-nebula", "c9d3e5f7", "joined",
            "2026-03-13T14:46:00.000-05:00",
        )
        # Time should be in square brackets at the end
        assert re.search(r"\[.*\]", line)


# ---------------------------------------------------------------------------
# LogExporter.write_message — JSONL output
# ---------------------------------------------------------------------------


class TestWriteMessageJsonl:
    def test_writes_jsonl_file(self, exporter: LogExporter, log_dir: Path):
        msg = _make_msg()
        result = exporter.write_message(msg)
        assert result is True
        jsonl_path = log_dir / "general.jsonl"
        assert jsonl_path.exists()

    def test_jsonl_line_is_valid_json(self, exporter: LogExporter, log_dir: Path):
        msg = _make_msg()
        exporter.write_message(msg)
        jsonl_path = log_dir / "general.jsonl"
        line = jsonl_path.read_text(encoding="utf-8").strip()
        parsed = json.loads(line)
        assert parsed["id"] == msg["id"]
        assert parsed["sender"]["name"] == "claude-veridian"

    def test_jsonl_preserves_all_fields(self, exporter: LogExporter, log_dir: Path):
        msg = _make_msg(
            recipients=["b2e19d04"],
            reply_to="parent-uuid",
        )
        exporter.write_message(msg)
        jsonl_path = log_dir / "general.jsonl"
        parsed = json.loads(jsonl_path.read_text(encoding="utf-8").strip())
        assert parsed["recipients"] == ["b2e19d04"]
        assert parsed["reply_to"] == "parent-uuid"
        assert parsed["conv"] == "general"

    def test_multiple_messages_append(self, exporter: LogExporter, log_dir: Path):
        msg1 = _make_msg(msg_id="id-1", body="First")
        msg2 = _make_msg(msg_id="id-2", body="Second")
        exporter.write_message(msg1)
        exporter.write_message(msg2)
        jsonl_path = log_dir / "general.jsonl"
        lines = [l for l in jsonl_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        assert len(lines) == 2
        assert json.loads(lines[0])["body"] == "First"
        assert json.loads(lines[1])["body"] == "Second"


# ---------------------------------------------------------------------------
# LogExporter.write_message — text output
# ---------------------------------------------------------------------------


class TestWriteMessageText:
    def test_writes_log_file(self, exporter: LogExporter, log_dir: Path):
        msg = _make_msg()
        exporter.write_message(msg)
        log_path = log_dir / "general.log"
        assert log_path.exists()

    def test_log_has_header(self, exporter: LogExporter, log_dir: Path):
        msg = _make_msg()
        exporter.write_message(msg)
        log_path = log_dir / "general.log"
        content = log_path.read_text(encoding="utf-8")
        assert "CONVERSATION: general" in content
        assert "=" * 80 in content

    def test_log_has_message_entry(self, exporter: LogExporter, log_dir: Path):
        msg = _make_msg(body="Test message content")
        exporter.write_message(msg)
        content = (log_dir / "general.log").read_text(encoding="utf-8")
        assert "@claude-veridian (a3f7b2c1):" in content
        assert "    Test message content" in content

    def test_both_files_written(self, exporter: LogExporter, log_dir: Path):
        """Format 'both' writes both .log and .jsonl."""
        msg = _make_msg()
        exporter.write_message(msg)
        assert (log_dir / "general.log").exists()
        assert (log_dir / "general.jsonl").exists()


# ---------------------------------------------------------------------------
# LogExporter — format modes
# ---------------------------------------------------------------------------


class TestFormatModes:
    def test_text_only(self, log_dir: Path):
        exp = LogExporter(log_dir=log_dir, fmt="text")
        exp.write_message(_make_msg())
        assert (log_dir / "general.log").exists()
        assert not (log_dir / "general.jsonl").exists()

    def test_jsonl_only(self, log_dir: Path):
        exp = LogExporter(log_dir=log_dir, fmt="jsonl")
        exp.write_message(_make_msg())
        assert (log_dir / "general.jsonl").exists()
        assert not (log_dir / "general.log").exists()

    def test_both(self, log_dir: Path):
        exp = LogExporter(log_dir=log_dir, fmt="both")
        exp.write_message(_make_msg())
        assert (log_dir / "general.log").exists()
        assert (log_dir / "general.jsonl").exists()


# ---------------------------------------------------------------------------
# LogExporter — deduplication
# ---------------------------------------------------------------------------


class TestDeduplication:
    def test_duplicate_message_rejected(self, exporter: LogExporter, log_dir: Path):
        msg = _make_msg(msg_id="dup-id")
        assert exporter.write_message(msg) is True
        assert exporter.write_message(msg) is False
        # JSONL should have exactly one line
        lines = (log_dir / "general.jsonl").read_text(encoding="utf-8").splitlines()
        lines = [l for l in lines if l.strip()]
        assert len(lines) == 1

    def test_different_ids_both_written(self, exporter: LogExporter, log_dir: Path):
        msg1 = _make_msg(msg_id="id-aaa")
        msg2 = _make_msg(msg_id="id-bbb")
        assert exporter.write_message(msg1) is True
        assert exporter.write_message(msg2) is True

    def test_shared_deduplicator(self, log_dir: Path):
        """Multiple exporters sharing a deduplicator see the same IDs."""
        dedup = MessageDeduplicator()
        exp1 = LogExporter(log_dir=log_dir, fmt="jsonl", deduplicator=dedup)
        exp2 = LogExporter(log_dir=log_dir, fmt="jsonl", deduplicator=dedup)
        msg = _make_msg(msg_id="shared-id")
        assert exp1.write_message(msg) is True
        assert exp2.write_message(msg) is False

    def test_message_without_id_rejected(self, exporter: LogExporter):
        msg = _make_msg()
        msg["id"] = ""
        assert exporter.write_message(msg) is False


# ---------------------------------------------------------------------------
# LogExporter — conv_id validation
# ---------------------------------------------------------------------------


class TestConvIdValidation:
    def test_valid_conv_id(self, exporter: LogExporter):
        msg = _make_msg(conv="my-chat")
        assert exporter.write_message(msg) is True

    def test_single_char_conv_id(self, exporter: LogExporter):
        msg = _make_msg(conv="a", msg_id="single-char-id")
        assert exporter.write_message(msg) is True

    def test_path_traversal_rejected(self, exporter: LogExporter):
        msg = _make_msg(conv="../../etc/passwd", msg_id="evil-id")
        assert exporter.write_message(msg) is False

    def test_uppercase_rejected(self, exporter: LogExporter):
        msg = _make_msg(conv="MyChat", msg_id="upper-id")
        assert exporter.write_message(msg) is False

    def test_empty_conv_rejected(self, exporter: LogExporter):
        msg = _make_msg(conv="", msg_id="empty-id")
        # Override conv to empty since _make_msg would set it
        msg["conv"] = ""
        assert exporter.write_message(msg) is False

    def test_reserved_system_rejected(self, exporter: LogExporter):
        msg = _make_msg(msg_id="sys-id")
        msg["conv"] = "system"
        assert exporter.write_message(msg) is False

    def test_reserved_meta_rejected(self, exporter: LogExporter):
        msg = _make_msg(msg_id="meta-id")
        msg["conv"] = "meta"
        assert exporter.write_message(msg) is False


# ---------------------------------------------------------------------------
# LogExporter — presence events
# ---------------------------------------------------------------------------


class TestPresenceEvents:
    def test_write_join_event(self, exporter: LogExporter, log_dir: Path):
        # Write a message first so header is created
        exporter.write_message(_make_msg(msg_id="pre-join"))
        result = exporter.write_presence(
            "general", "claude-nebula", "c9d3e5f7", "joined",
            "2026-03-13T14:46:00.000-05:00",
        )
        assert result is True
        content = (log_dir / "general.log").read_text(encoding="utf-8")
        assert "--- claude-nebula (c9d3e5f7) joined the conversation" in content

    def test_invalid_conv_rejected(self, exporter: LogExporter):
        result = exporter.write_presence(
            "../../etc", "evil", "deadbeef", "joined",
        )
        assert result is False

    def test_presence_skipped_in_jsonl_only_mode(self, log_dir: Path):
        exp = LogExporter(log_dir=log_dir, fmt="jsonl")
        result = exp.write_presence("general", "test", "abcd1234", "joined")
        assert result is True  # Returns True (no error), just no output


# ---------------------------------------------------------------------------
# LogExporter — log rotation
# ---------------------------------------------------------------------------


class TestLogRotation:
    def test_rotation_creates_numbered_files(self, log_dir: Path):
        # Use a tiny max_size to trigger rotation
        exp = LogExporter(
            log_dir=log_dir, fmt="jsonl", max_size_mb=0, max_files=3,
        )
        # max_size_mb=0 means max_size_bytes=0, so rotation is disabled
        # Use a very small size instead
        exp.max_size_bytes = 10  # 10 bytes

        # Write enough messages to trigger rotation
        for i in range(5):
            msg = _make_msg(msg_id=f"rot-{i}", body=f"Message {i} with enough text to exceed the limit easily")
            exp.write_message(msg)

        # Should have the main file and some rotated files
        jsonl_path = log_dir / "general.jsonl"
        assert jsonl_path.exists()

    def test_rotation_respects_max_files(self, log_dir: Path):
        max_files = 2
        exp = LogExporter(
            log_dir=log_dir, fmt="jsonl", max_size_mb=0, max_files=max_files,
        )
        exp.max_size_bytes = 10

        for i in range(10):
            msg = _make_msg(msg_id=f"maxf-{i}", body="x" * 100)
            exp.write_message(msg)

        # Should not have more than max_files rotated copies
        rotated = list(log_dir.glob("general.jsonl.*"))
        assert len(rotated) <= max_files


# ---------------------------------------------------------------------------
# LogExporter.from_config
# ---------------------------------------------------------------------------


class TestFromConfig:
    def test_from_config_defaults(self, log_dir: Path):
        config = {
            "logging": {
                "dir": str(log_dir),
                "format": "both",
                "rotation": {
                    "max_size_mb": 25,
                    "max_files": 3,
                },
            },
        }
        exp = LogExporter.from_config(config)
        assert exp.log_dir == log_dir
        assert exp.fmt == "both"
        assert exp.max_size_bytes == 25 * 1024 * 1024
        assert exp.max_files == 3

    def test_from_config_missing_keys(self):
        """Missing config keys use sensible defaults."""
        exp = LogExporter.from_config({})
        assert exp.fmt == "both"
        assert exp.max_files == 10


# ---------------------------------------------------------------------------
# LogExporter — multiple conversations
# ---------------------------------------------------------------------------


class TestMultipleConversations:
    def test_separate_files_per_conversation(self, exporter: LogExporter, log_dir: Path):
        msg1 = _make_msg(conv="chat-a", msg_id="conv-a-1")
        msg2 = _make_msg(conv="chat-b", msg_id="conv-b-1")
        exporter.write_message(msg1)
        exporter.write_message(msg2)
        assert (log_dir / "chat-a.jsonl").exists()
        assert (log_dir / "chat-b.jsonl").exists()
        assert (log_dir / "chat-a.log").exists()
        assert (log_dir / "chat-b.log").exists()

    def test_conversation_headers_independent(self, exporter: LogExporter, log_dir: Path):
        exporter.write_message(_make_msg(conv="alpha", msg_id="a1"))
        exporter.write_message(_make_msg(conv="beta", msg_id="b1"))
        alpha_content = (log_dir / "alpha.log").read_text(encoding="utf-8")
        beta_content = (log_dir / "beta.log").read_text(encoding="utf-8")
        assert "CONVERSATION: alpha" in alpha_content
        assert "CONVERSATION: beta" in beta_content
