"""Tests for participant key generation, name changes, and uniqueness."""

from __future__ import annotations

import json

import pytest

from claude_comms.participant import (
    KEY_PATTERN,
    Participant,
    generate_key,
    validate_key,
    validate_name,
)


# ---------------------------------------------------------------------------
# Key generation
# ---------------------------------------------------------------------------


class TestKeyGeneration:
    def test_length(self) -> None:
        key = generate_key()
        assert len(key) == 8

    def test_hex_chars_only(self) -> None:
        key = generate_key()
        assert KEY_PATTERN.match(key)

    def test_uniqueness(self) -> None:
        """Generate 100 keys and verify no collisions."""
        keys = {generate_key() for _ in range(100)}
        assert len(keys) == 100

    def test_lowercase(self) -> None:
        key = generate_key()
        assert key == key.lower()


# ---------------------------------------------------------------------------
# Key / name validation
# ---------------------------------------------------------------------------


class TestValidation:
    @pytest.mark.parametrize("key", ["a3f7b2c1", "00000000", "ffffffff", "abcdef01"])
    def test_valid_keys(self, key: str) -> None:
        assert validate_key(key) is True

    @pytest.mark.parametrize(
        "key", ["A3F7B2C1", "short", "toolongkey", "zzzzzzzz", "1234567g", ""]
    )
    def test_invalid_keys(self, key: str) -> None:
        assert validate_key(key) is False

    @pytest.mark.parametrize(
        "name", ["phil", "claude-veridian", "claude_test", "x", "a" * 64]
    )
    def test_valid_names(self, name: str) -> None:
        assert validate_name(name) is True

    @pytest.mark.parametrize("name", ["", "a" * 65, "has space", "bad!char", "@nope"])
    def test_invalid_names(self, name: str) -> None:
        assert validate_name(name) is False


# ---------------------------------------------------------------------------
# Participant model
# ---------------------------------------------------------------------------


class TestParticipant:
    def test_create(self) -> None:
        p = Participant.create("claude-veridian", "claude")
        assert len(p.key) == 8
        assert p.name == "claude-veridian"
        assert p.type == "claude"

    def test_create_human(self) -> None:
        p = Participant.create("phil", "human")
        assert p.type == "human"

    def test_invalid_key_rejected(self) -> None:
        with pytest.raises(ValueError, match="hex"):
            Participant(key="BADKEY!!", name="test", type="claude")

    def test_invalid_name_rejected(self) -> None:
        with pytest.raises(ValueError, match="name"):
            Participant(key="abcdef01", name="bad name with spaces", type="claude")

    def test_invalid_type_rejected(self) -> None:
        with pytest.raises(ValueError):
            Participant(key="abcdef01", name="test", type="robot")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Name management
# ---------------------------------------------------------------------------


class TestNameManagement:
    def test_with_name_returns_new_instance(self) -> None:
        p1 = Participant.create("original", "claude")
        p2 = p1.with_name("updated")
        assert p2.name == "updated"
        assert p2.key == p1.key  # key is immutable
        assert p1.name == "original"  # original unchanged

    def test_with_name_preserves_type(self) -> None:
        p = Participant.create("phil", "human")
        p2 = p.with_name("philippe")
        assert p2.type == "human"


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


class TestSerialization:
    def test_json_round_trip(self) -> None:
        p = Participant(key="a3f7b2c1", name="claude-veridian", type="claude")
        payload = p.to_mqtt_payload()
        restored = Participant.from_mqtt_payload(payload)
        assert restored == p

    def test_from_bytes(self) -> None:
        p = Participant(key="a3f7b2c1", name="test", type="human")
        payload_bytes = p.to_mqtt_payload().encode("utf-8")
        restored = Participant.from_mqtt_payload(payload_bytes)
        assert restored == p

    def test_json_keys(self) -> None:
        p = Participant(key="a3f7b2c1", name="test", type="claude")
        data = json.loads(p.to_mqtt_payload())
        assert set(data.keys()) == {"key", "name", "type", "client"}


# ---------------------------------------------------------------------------
# MQTT topic
# ---------------------------------------------------------------------------


class TestRegistryTopic:
    def test_topic_format(self) -> None:
        p = Participant(key="a3f7b2c1", name="test", type="claude")
        assert p.registry_topic == "claude-comms/system/participants/a3f7b2c1"
