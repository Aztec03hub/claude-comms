"""Gap tests for log_exporter.py.

Covers:
- Rotation edge cases (exactly at max size, multiple rotations, disabled rotation)
- Malformed messages (missing fields, bad types)
- format_log_entry edge cases (empty msg, missing ts, non-dict sender)
- format_presence_event with None values
- LogExporter header management edge cases
"""

from __future__ import annotations


from claude_comms.log_exporter import (
    LogExporter,
    _check_rotation,
    _rotate_file,
    format_log_entry,
    format_presence_event,
)


def _make_msg(
    *,
    conv: str = "general",
    body: str = "Hello!",
    msg_id: str = "test-id-001",
    ts: str = "2026-03-13T14:15:23.000-05:00",
    sender_name: str = "bot",
    sender_key: str = "a3f7b2c1",
) -> dict:
    return {
        "id": msg_id,
        "ts": ts,
        "sender": {"key": sender_key, "name": sender_name, "type": "claude"},
        "recipients": None,
        "body": body,
        "reply_to": None,
        "conv": conv,
    }


# --- Rotation edge cases ---


class TestRotationEdgeCases:
    def test_rotation_exactly_at_max_size(self, tmp_path):
        """File exactly at max_size_bytes should trigger rotation."""
        log_file = tmp_path / "test.jsonl"
        log_file.write_text("x" * 100)
        # max_size_bytes=100, file is exactly 100 bytes
        _check_rotation(log_file, max_size_bytes=100, max_files=3)
        # File should have been rotated
        assert (tmp_path / "test.jsonl.1").exists()

    def test_rotation_just_under_max_size(self, tmp_path):
        """File just under max_size_bytes should NOT trigger rotation."""
        log_file = tmp_path / "test.jsonl"
        log_file.write_text("x" * 99)
        _check_rotation(log_file, max_size_bytes=100, max_files=3)
        assert not (tmp_path / "test.jsonl.1").exists()

    def test_multiple_rotations_chain(self, tmp_path):
        """Multiple rotations should create .1, .2, .3 etc."""
        log_file = tmp_path / "test.log"

        # First rotation
        log_file.write_text("content-A")
        _rotate_file(log_file, max_files=5)
        assert (tmp_path / "test.log.1").read_text() == "content-A"
        assert not log_file.exists()

        # Second rotation
        log_file.write_text("content-B")
        _rotate_file(log_file, max_files=5)
        assert (tmp_path / "test.log.1").read_text() == "content-B"
        assert (tmp_path / "test.log.2").read_text() == "content-A"

    def test_rotation_deletes_oldest_beyond_max_files(self, tmp_path):
        """Files beyond max_files should be deleted."""
        log_file = tmp_path / "test.log"

        for i in range(5):
            log_file.write_text(f"content-{i}")
            _rotate_file(log_file, max_files=2)

        # Should only have .1 and .2
        assert (tmp_path / "test.log.1").exists()
        assert (tmp_path / "test.log.2").exists()
        assert not (tmp_path / "test.log.3").exists()

    def test_rotation_disabled_when_max_size_zero(self, tmp_path):
        """max_size_bytes=0 should disable rotation."""
        log_file = tmp_path / "test.log"
        log_file.write_text("x" * 1000)
        _check_rotation(log_file, max_size_bytes=0, max_files=5)
        assert not (tmp_path / "test.log.1").exists()

    def test_rotation_disabled_when_max_files_zero(self, tmp_path):
        """max_files=0 should disable rotation."""
        log_file = tmp_path / "test.log"
        log_file.write_text("x" * 1000)
        _check_rotation(log_file, max_size_bytes=10, max_files=0)
        assert not (tmp_path / "test.log.1").exists()

    def test_rotation_on_nonexistent_file(self, tmp_path):
        """Rotation should be a no-op for non-existent file."""
        log_file = tmp_path / "nonexistent.log"
        _check_rotation(log_file, max_size_bytes=10, max_files=3)
        # Should not raise or create files


# --- Malformed messages ---


class TestMalformedMessages:
    def test_format_entry_empty_dict(self):
        result = format_log_entry({})
        assert result == "[EMPTY MESSAGE]"

    def test_format_entry_none_body(self):
        """None-like msg still handled."""
        result = format_log_entry(None)
        assert result == "[EMPTY MESSAGE]"

    def test_format_entry_missing_ts(self):
        """Missing ts field should fall back to UNKNOWN TIME."""
        msg = {"sender": {"key": "aabb1122", "name": "bot"}, "body": "hi"}
        result = format_log_entry(msg)
        assert "UNKNOWN TIME" in result

    def test_format_entry_invalid_ts(self):
        """Invalid timestamp string should be used as-is."""
        msg = {
            "ts": "not-a-date",
            "sender": {"key": "aabb1122", "name": "bot"},
            "body": "hi",
        }
        result = format_log_entry(msg)
        assert "not-a-date" in result

    def test_format_entry_sender_not_dict(self):
        """Non-dict sender should fall back to 'unknown'."""
        msg = {"ts": "2026-01-01T00:00:00Z", "sender": "just-a-string", "body": "hi"}
        result = format_log_entry(msg)
        assert "@unknown" in result
        assert "(????????)" in result

    def test_format_entry_missing_sender(self):
        """Missing sender should fall back to 'unknown'."""
        msg = {"ts": "2026-01-01T00:00:00Z", "body": "hi"}
        result = format_log_entry(msg)
        assert "@unknown" in result

    def test_write_message_missing_conv_field(self, tmp_path):
        exp = LogExporter(log_dir=tmp_path, fmt="jsonl")
        msg = _make_msg()
        del msg["conv"]
        msg["conv"] = ""
        assert exp.write_message(msg) is False

    def test_write_message_missing_id_field(self, tmp_path):
        exp = LogExporter(log_dir=tmp_path, fmt="jsonl")
        msg = _make_msg()
        msg["id"] = ""
        assert exp.write_message(msg) is False


# --- format_presence_event edge cases ---


class TestPresenceEventEdgeCases:
    def test_presence_with_none_name(self):
        line = format_presence_event(None, "aabb1122", "joined")
        assert "unknown (aabb1122) joined" in line

    def test_presence_with_none_key(self):
        line = format_presence_event("bot", None, "left")
        assert "bot (????????) left" in line

    def test_presence_with_invalid_ts(self):
        """Invalid timestamp should fall back to current time."""
        line = format_presence_event("bot", "aabb1122", "joined", "INVALID")
        assert "joined" in line
        # Should not raise, just use current time


# --- LogExporter header management ---


class TestHeaderManagement:
    def test_header_not_written_for_jsonl_only(self, tmp_path):
        exp = LogExporter(log_dir=tmp_path, fmt="jsonl")
        exp.write_message(_make_msg())
        # No .log file should exist
        assert not (tmp_path / "general.log").exists()

    def test_header_written_once_for_multiple_messages(self, tmp_path):
        exp = LogExporter(log_dir=tmp_path, fmt="text")
        exp.write_message(_make_msg(msg_id="m1"))
        exp.write_message(_make_msg(msg_id="m2"))
        content = (tmp_path / "general.log").read_text()
        # Header separator should appear exactly twice (top and bottom of header)
        assert content.count("=" * 80) == 2

    def test_header_assumes_existing_file_has_header(self, tmp_path):
        """If log file already has content, header is not re-written."""
        log_file = tmp_path / "general.log"
        log_file.write_text("existing content\n")
        exp = LogExporter(log_dir=tmp_path, fmt="text")
        exp.write_message(_make_msg())
        content = log_file.read_text()
        # Should NOT contain the header separator since file had content
        assert "CONVERSATION:" not in content
