"""Participant identity: key generation, name management, profile."""

from __future__ import annotations

import re
import secrets
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# 8-character hex key pattern
KEY_PATTERN = re.compile(r"^[0-9a-f]{8}$")

# Display name: alphanumeric, hyphens, underscores; 1-64 chars
NAME_PATTERN = re.compile(r"^[\w-]{1,64}$")

ParticipantType = Literal["claude", "human"]

# Allowed connection types
CONNECTION_TYPES = ("web", "tui", "mcp", "cli", "api")


class ConnectionInfo(BaseModel):
    """A single active connection for a participant."""

    client: str = Field(description="Client type: web, tui, mcp, cli, api")
    instance_id: str | None = Field(default=None, description="Instance identifier")
    since: str = Field(description="ISO 8601 timestamp when connection was established")
    last_seen: str = Field(description="ISO 8601 timestamp of last activity")


def generate_key() -> str:
    """Generate an immutable 8-character hex participant key.

    Uses ``secrets.token_hex(4)`` for cryptographic randomness.
    With 4 billion possible keys, collision risk is negligible.
    """
    return secrets.token_hex(4)


def validate_key(key: str | None) -> bool:
    """Check whether *key* is a valid 8-character lowercase hex string.

    Returns ``False`` for ``None`` or empty strings.
    """
    if not key:
        return False
    return bool(KEY_PATTERN.match(key))


def validate_name(name: str | None) -> bool:
    """Check whether *name* is a valid display name.

    Returns ``False`` for ``None`` or empty strings.
    """
    if not name:
        return False
    return bool(NAME_PATTERN.match(name))


class Participant(BaseModel):
    """A participant in the claude-comms system.

    Attributes:
        key: Immutable 8-hex-char identifier, generated once.
        name: Mutable display name chosen by the participant.
        type: ``"claude"`` or ``"human"``.
    """

    key: str = Field(
        ...,
        min_length=8,
        max_length=8,
        description="Immutable 8-character hex identifier",
    )
    name: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="Display name (can change)",
    )
    type: ParticipantType = Field(
        ...,
        description="Participant type: claude or human",
    )
    client: str | None = Field(
        default=None,
        description="Deprecated: use connections instead. Kept for backward compat.",
    )
    connections: dict[str, ConnectionInfo] = Field(
        default_factory=dict,
        description="Active connections keyed by '{client}-{instanceId}'",
    )

    @field_validator("key")
    @classmethod
    def _validate_key(cls, v: str) -> str:
        if not KEY_PATTERN.match(v):
            raise ValueError(
                f"key must be exactly 8 lowercase hex characters, got {v!r}"
            )
        return v

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not NAME_PATTERN.match(v):
            raise ValueError(f"name must match {NAME_PATTERN.pattern!r}, got {v!r}")
        return v

    # -- Connection helpers ------------------------------------------------

    @property
    def is_online(self) -> bool:
        """True if the participant has at least one active connection."""
        return len(self.connections) > 0

    @property
    def active_client_types(self) -> list[str]:
        """Unique client types across all active connections."""
        return list(set(c.client for c in self.connections.values()))

    # -- Convenience constructors -----------------------------------------

    @classmethod
    def create(cls, name: str, participant_type: ParticipantType) -> Participant:
        """Create a new participant with an auto-generated key."""
        return cls(key=generate_key(), name=name, type=participant_type)

    # -- Name management --------------------------------------------------

    def with_name(self, new_name: str) -> Participant:
        """Return a copy with an updated display name (key stays the same)."""
        return self.model_copy(update={"name": new_name})

    # -- Serialization for MQTT retained messages -------------------------

    def to_mqtt_payload(self) -> str:
        """Serialize to JSON string for MQTT publishing."""
        return self.model_dump_json()

    @classmethod
    def from_mqtt_payload(cls, payload: str | bytes) -> Participant:
        """Deserialize from an MQTT retained message."""
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        return cls.model_validate_json(payload)

    # -- MQTT topic -------------------------------------------------------

    @property
    def registry_topic(self) -> str:
        """MQTT topic for this participant's registry entry."""
        return f"claude-comms/system/participants/{self.key}"
