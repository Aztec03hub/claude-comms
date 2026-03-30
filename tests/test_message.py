"""Tests for message creation, serialization, and validation."""

from __future__ import annotations

import json
import uuid

import pytest

from claude_comms.message import (
    Message,
    Sender,
    new_message_id,
    now_iso,
    validate_conv_id,
)


# ---------------------------------------------------------------------------
# Helper fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def sender() -> Sender:
    return Sender(key="a3f7b2c1", name="claude-veridian", type="claude")


@pytest.fixture
def sample_message(sender: Sender) -> Message:
    return Message(
        id="550e8400-e29b-41d4-a716-446655440000",
        ts="2026-03-13T14:23:45.123-05:00",
        sender=sender,
        recipients=["b2e19d04", "00ff0e8a"],
        body="[@claude-MasterSensei, @phil] Here's my analysis.",
        reply_to=None,
        conv="general",
    )


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


class TestMessageCreation:
    def test_create_convenience(self) -> None:
        msg = Message.create(
            sender_key="a3f7b2c1",
            sender_name="claude-veridian",
            sender_type="claude",
            body="Hello world",
            conv="general",
        )
        assert msg.sender.key == "a3f7b2c1"
        assert msg.sender.name == "claude-veridian"
        assert msg.sender.type == "claude"
        assert msg.body == "Hello world"
        assert msg.conv == "general"
        assert msg.recipients is None
        assert msg.reply_to is None
        # Auto-generated fields
        uuid.UUID(msg.id)  # must be valid UUID
        assert "T" in msg.ts  # ISO 8601

    def test_create_with_recipients_and_reply(self) -> None:
        msg = Message.create(
            sender_key="a3f7b2c1",
            sender_name="test",
            sender_type="human",
            body="reply",
            conv="general",
            recipients=["b2e19d04"],
            reply_to="550e8400-e29b-41d4-a716-446655440000",
        )
        assert msg.recipients == ["b2e19d04"]
        assert msg.reply_to == "550e8400-e29b-41d4-a716-446655440000"

    def test_defaults(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="test",
            sender_type="claude",
            body="hi",
            conv="x",
        )
        assert msg.is_broadcast
        assert msg.reply_to is None


# ---------------------------------------------------------------------------
# Serialization round-trip
# ---------------------------------------------------------------------------


class TestSerialization:
    def test_json_round_trip(self, sample_message: Message) -> None:
        payload = sample_message.to_mqtt_payload()
        restored = Message.from_mqtt_payload(payload)
        assert restored == sample_message

    def test_from_bytes(self, sample_message: Message) -> None:
        payload_bytes = sample_message.to_mqtt_payload().encode("utf-8")
        restored = Message.from_mqtt_payload(payload_bytes)
        assert restored == sample_message

    def test_json_keys(self, sample_message: Message) -> None:
        data = json.loads(sample_message.to_mqtt_payload())
        assert set(data.keys()) == {
            "id",
            "ts",
            "sender",
            "recipients",
            "body",
            "reply_to",
            "conv",
        }
        assert set(data["sender"].keys()) == {"key", "name", "type"}

    def test_null_recipients_serialized(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="general",
        )
        data = json.loads(msg.to_mqtt_payload())
        assert data["recipients"] is None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestValidation:
    def test_invalid_conv_id_special_chars(self) -> None:
        with pytest.raises(ValueError, match="conv_id"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="../etc/passwd",
            )

    def test_invalid_conv_id_uppercase(self) -> None:
        with pytest.raises(ValueError, match="conv_id"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="General",
            )

    def test_reserved_conv_id_system(self) -> None:
        with pytest.raises(ValueError, match="reserved"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="system",
            )

    def test_reserved_conv_id_meta(self) -> None:
        with pytest.raises(ValueError, match="reserved"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="meta",
            )

    def test_valid_single_char_conv_id(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="x",
        )
        assert msg.conv == "x"

    def test_valid_hyphenated_conv_id(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="project-alpha-2",
        )
        assert msg.conv == "project-alpha-2"

    def test_conv_id_leading_hyphen_invalid(self) -> None:
        with pytest.raises(ValueError, match="conv_id"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="-bad",
            )

    def test_conv_id_trailing_hyphen_invalid(self) -> None:
        with pytest.raises(ValueError, match="conv_id"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="bad-",
            )

    def test_invalid_recipient_key(self) -> None:
        with pytest.raises(ValueError, match="recipient key"):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="hi",
                conv="general",
                recipients=["not-hex!"],
            )

    def test_empty_body_rejected(self) -> None:
        with pytest.raises(ValueError):
            Message.create(
                sender_key="abcdef01",
                sender_name="t",
                sender_type="claude",
                body="",
                conv="general",
            )


# ---------------------------------------------------------------------------
# Routing helpers
# ---------------------------------------------------------------------------


class TestRouting:
    def test_is_broadcast(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="general",
        )
        assert msg.is_broadcast is True
        assert msg.is_for("anything") is True

    def test_targeted_message(self) -> None:
        msg = Message.create(
            sender_key="abcdef01",
            sender_name="t",
            sender_type="claude",
            body="hi",
            conv="general",
            recipients=["b2e19d04"],
        )
        assert msg.is_broadcast is False
        assert msg.is_for("b2e19d04") is True
        assert msg.is_for("ffffffff") is False

    def test_topic(self, sample_message: Message) -> None:
        assert sample_message.topic == "claude-comms/conv/general/messages"


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


class TestUtilities:
    def test_new_message_id_is_uuid(self) -> None:
        mid = new_message_id()
        uuid.UUID(mid)  # should not raise

    def test_now_iso_has_timezone(self) -> None:
        ts = now_iso()
        assert "+" in ts or "Z" in ts or "-" in ts[10:]

    @pytest.mark.parametrize(
        "conv_id,expected",
        [
            ("general", True),
            ("a", True),
            ("project-alpha-2", True),
            ("x" * 64, True),
            ("", False),
            ("-bad", False),
            ("bad-", False),
            ("BAD", False),
            ("../etc", False),
            ("system", False),
            ("meta", False),
        ],
    )
    def test_validate_conv_id(self, conv_id: str, expected: bool) -> None:
        assert validate_conv_id(conv_id) is expected
