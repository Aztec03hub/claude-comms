"""Message dataclass/Pydantic model, serialization, deserialization."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# Conversation ID validation — prevents path traversal in log paths
CONV_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$")

# Reserved conversation names that conflict with MQTT topic structure
RESERVED_CONV_IDS = frozenset({"system", "meta"})

ParticipantType = Literal["claude", "human"]


def validate_conv_id(conv_id: str | None) -> bool:
    """Return True if *conv_id* is valid for use in topics and file paths.

    Returns ``False`` for ``None`` or empty strings.
    """
    if not conv_id:
        return False
    if conv_id in RESERVED_CONV_IDS:
        return False
    return bool(CONV_ID_PATTERN.match(conv_id))


def new_message_id() -> str:
    """Generate a new UUID4 string for a message ID."""
    return str(uuid.uuid4())


def now_iso() -> str:
    """Return the current time as an ISO 8601 string with timezone."""
    return datetime.now(timezone.utc).astimezone().isoformat()


class Sender(BaseModel):
    """The sender block embedded in every message."""

    key: str = Field(
        ...,
        min_length=8,
        max_length=8,
        description="Immutable 8-hex-char identifier",
    )
    name: str = Field(..., min_length=1, description="Display name")
    type: ParticipantType = Field(..., description="Participant type: claude or human")


class Message(BaseModel):
    """A single chat message in the claude-comms system.

    This is the canonical wire-format model published to
    ``claude-comms/conv/{conv}/messages`` over MQTT.
    """

    id: str = Field(
        default_factory=new_message_id,
        description="Unique message UUID",
    )
    ts: str = Field(
        default_factory=now_iso,
        description="ISO 8601 timestamp with timezone",
    )
    sender: Sender = Field(..., description="Who sent this message")
    recipients: list[str] | None = Field(
        default=None,
        description="Target participant keys; null means broadcast",
    )
    body: str = Field(..., min_length=1, description="Message content")
    reply_to: str | None = Field(
        default=None,
        description="Parent message UUID for threading",
    )
    conv: str = Field(..., description="Conversation ID")

    @field_validator("conv")
    @classmethod
    def _validate_conv(cls, v: str) -> str:
        if v in RESERVED_CONV_IDS:
            raise ValueError(f"conv_id {v!r} is reserved")
        if not CONV_ID_PATTERN.match(v):
            raise ValueError(
                f"conv_id must match {CONV_ID_PATTERN.pattern!r}, got {v!r}"
            )
        return v

    @field_validator("recipients")
    @classmethod
    def _validate_recipients(cls, v: list[str] | None) -> list[str] | None:
        if v is not None:
            hex8 = re.compile(r"^[0-9a-f]{8}$")
            for key in v:
                if not hex8.match(key):
                    raise ValueError(
                        f"recipient key must be 8 lowercase hex chars, got {key!r}"
                    )
        return v

    # -- Convenience constructors -----------------------------------------

    @classmethod
    def create(
        cls,
        sender_key: str,
        sender_name: str,
        sender_type: ParticipantType,
        body: str,
        conv: str,
        *,
        recipients: list[str] | None = None,
        reply_to: str | None = None,
    ) -> Message:
        """Build a Message with auto-generated id and timestamp."""
        return cls(
            sender=Sender(key=sender_key, name=sender_name, type=sender_type),
            body=body,
            conv=conv,
            recipients=recipients,
            reply_to=reply_to,
        )

    # -- MQTT serialization -----------------------------------------------

    def to_mqtt_payload(self) -> str:
        """Serialize to a JSON string for MQTT publishing."""
        return self.model_dump_json()

    @classmethod
    def from_mqtt_payload(cls, payload: str | bytes) -> Message:
        """Deserialize from an MQTT message payload."""
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        return cls.model_validate_json(payload)

    # -- MQTT topic -------------------------------------------------------

    @property
    def topic(self) -> str:
        """MQTT topic this message should be published to."""
        return f"claude-comms/conv/{self.conv}/messages"

    # -- Display helpers --------------------------------------------------

    @property
    def is_broadcast(self) -> bool:
        """True when the message targets all conversation participants."""
        return self.recipients is None

    def is_for(self, participant_key: str) -> bool:
        """Check whether *participant_key* should receive this message."""
        if self.is_broadcast:
            return True
        return participant_key in (self.recipients or [])
