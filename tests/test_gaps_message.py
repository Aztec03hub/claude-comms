"""Gap tests for message.py.

Covers:
- Conversation ID validation edge cases (max length, unicode, special patterns)
- Unicode characters in body and sender name
- Max field lengths (64-char conv_id, long body)
- Sender validation edge cases
- from_mqtt_payload with malformed data
- is_for with edge cases
"""

from __future__ import annotations

import json

import pytest

from claude_comms.message import (
    CONV_ID_PATTERN,
    RESERVED_CONV_IDS,
    Message,
    Sender,
    validate_conv_id,
)


# --- Conversation ID validation edge cases ---


class TestConvIdEdgeCases:
    def test_max_length_64_chars(self):
        """64-char conv_id (all lowercase alnum) should be valid."""
        conv_id = "a" * 64
        assert validate_conv_id(conv_id) is True

    def test_65_chars_invalid(self):
        """65-char conv_id should be invalid (exceeds pattern max)."""
        conv_id = "a" * 65
        assert validate_conv_id(conv_id) is False

    def test_two_char_with_hyphen(self):
        """Two chars: first and last must be alnum, so 'a-' is invalid."""
        # Pattern: ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ for 2+ chars
        assert validate_conv_id("a-") is False

    def test_two_chars_valid(self):
        assert validate_conv_id("ab") is True

    def test_hyphen_in_middle(self):
        assert validate_conv_id("a-b") is True

    def test_multiple_consecutive_hyphens(self):
        assert validate_conv_id("a--b") is True

    def test_numeric_only(self):
        assert validate_conv_id("12345") is True

    def test_single_digit(self):
        assert validate_conv_id("9") is True

    def test_unicode_chars_invalid(self):
        assert validate_conv_id("caf\u00e9") is False

    def test_space_invalid(self):
        assert validate_conv_id("has space") is False

    def test_underscore_invalid(self):
        """Underscores are not allowed in conv_id pattern."""
        assert validate_conv_id("has_underscore") is False

    def test_dot_invalid(self):
        assert validate_conv_id("has.dot") is False

    def test_none_returns_false(self):
        assert validate_conv_id(None) is False


# --- Unicode in body and names ---


class TestUnicodeHandling:
    def test_unicode_body(self):
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="test",
            sender_type="claude",
            body="Hello \U0001f600 \u4f60\u597d world!",
            conv="general",
        )
        assert "\U0001f600" in msg.body
        # Round-trip
        payload = msg.to_mqtt_payload()
        restored = Message.from_mqtt_payload(payload)
        assert restored.body == msg.body

    def test_unicode_in_sender_name(self):
        """Sender name with unicode (if name pattern allows it)."""
        # NAME_PATTERN is [\w-]{1,64} which includes unicode word chars
        # But Sender field only validates min_length=1
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="\u00e9milie",
            sender_type="human",
            body="hi",
            conv="general",
        )
        assert msg.sender.name == "\u00e9milie"

    def test_emoji_in_body_roundtrip(self):
        body = "\U0001f4ec New messages: \U0001f389\U0001f680\U0001f4a1"
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="bot",
            sender_type="claude",
            body=body,
            conv="general",
        )
        payload = msg.to_mqtt_payload()
        restored = Message.from_mqtt_payload(payload)
        assert restored.body == body

    def test_multiline_body_preserved(self):
        body = "Line 1\nLine 2\n\nLine 4"
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="bot",
            sender_type="claude",
            body=body,
            conv="general",
        )
        payload = msg.to_mqtt_payload()
        restored = Message.from_mqtt_payload(payload)
        assert restored.body == body


# --- Sender validation edge cases ---


class TestSenderValidation:
    def test_sender_key_too_short(self):
        with pytest.raises(ValueError):
            Sender(key="abc", name="test", type="claude")

    def test_sender_key_too_long(self):
        with pytest.raises(ValueError):
            Sender(key="abcdef012", name="test", type="claude")

    def test_sender_key_uppercase_hex_accepted_by_sender(self):
        """Sender model only checks length (8 chars), not hex pattern.

        The Participant model validates hex pattern, but Sender is more lenient.
        Verify this is the current behavior.
        """
        # Sender key field validates min/max length but Participant validates hex
        sender = Sender(key="ABCDEF01", name="test", type="claude")
        assert sender.key == "ABCDEF01"

    def test_sender_empty_name(self):
        with pytest.raises(ValueError):
            Sender(key="abcdef01", name="", type="claude")

    def test_sender_invalid_type(self):
        with pytest.raises(ValueError):
            Sender(key="abcdef01", name="test", type="bot")  # type: ignore


# --- from_mqtt_payload with malformed data ---


class TestFromMqttPayloadMalformed:
    def test_invalid_json(self):
        with pytest.raises(Exception):
            Message.from_mqtt_payload("not json at all")

    def test_missing_required_field(self):
        """Missing 'body' should raise."""
        data = {
            "id": "123",
            "ts": "2026-01-01T00:00:00Z",
            "sender": {"key": "abcdef01", "name": "t", "type": "claude"},
            "conv": "general",
        }
        with pytest.raises(Exception):
            Message.from_mqtt_payload(json.dumps(data))

    def test_from_bytes_utf8(self):
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hello",
            conv="general",
        )
        payload_bytes = msg.to_mqtt_payload().encode("utf-8")
        restored = Message.from_mqtt_payload(payload_bytes)
        assert restored.body == "hello"


# --- is_for edge cases ---


class TestIsForEdgeCases:
    def test_is_for_sender_themselves(self):
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="general",
            recipients=["abcdef01"],
        )
        assert msg.is_for("abcdef01") is True

    def test_is_for_with_multiple_recipients(self):
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="general",
            recipients=["11111111", "22222222", "33333333"],
        )
        assert msg.is_for("22222222") is True
        assert msg.is_for("44444444") is False

    def test_is_for_empty_recipients_list(self):
        """Empty recipients list is NOT broadcast (recipients is not None)."""
        msg = Message(
            sender=Sender(key="abcdef01", name="t", type="claude"),
            body="hi",
            conv="general",
            recipients=[],
        )
        assert msg.is_broadcast is False
        assert msg.is_for("abcdef01") is False


# --- Recipients validation ---


class TestRecipientsValidation:
    def test_multiple_valid_recipients(self):
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="general",
            recipients=["11111111", "22222222"],
        )
        assert len(msg.recipients) == 2

    def test_recipient_with_uppercase_rejected(self):
        with pytest.raises(ValueError, match="recipient key"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="general",
                recipients=["AABBCCDD"],
            )

    def test_recipient_wrong_length_rejected(self):
        with pytest.raises(ValueError, match="recipient key"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="general",
                recipients=["abc"],
            )
