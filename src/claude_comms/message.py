"""Message dataclass/Pydantic model, serialization, deserialization."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from claude_comms.participant import KEY_PATTERN


# Conversation ID validation — prevents path traversal in log paths
CONV_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$")

# Reserved conversation names that conflict with MQTT topic structure
RESERVED_CONV_IDS = frozenset({"system", "meta"})

# Reserved sentinel sender key stamped on every server-authored ``[system]``
# message. Single source of truth — imported by the producers (mcp_tools,
# mcp_server, cli) that stamp it and by ``notifier`` whose suppression rule
# ("never cue a system message") depends on producers using exactly this
# value. See the cross-file DRY audit.
SYSTEM_SENDER_KEY = "00000000"

# ``"system"`` covers the daemon-authored ``[system]`` messages whose sender
# key is :data:`SYSTEM_SENDER_KEY`; ``Sender`` must accept them so the TUI /
# web clients can render server notifications (conv created, artifact
# changes, joins/leaves). It is NOT a joinable participant type — the
# registry's ``Participant.type`` (participant.ParticipantType) stays
# ``claude``/``human``.
ParticipantType = Literal["claude", "human", "system"]


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
        description="Whisper recipients; null means broadcast visibility",
    )
    mentions: list[str] | None = Field(
        default=None,
        description=(
            "Broadcast highlight intent — named participants get a notification "
            "cue but visibility is unrestricted. Does NOT participate in the "
            "_is_visible filter. See plans/mentions-vs-whisper-separation.md."
        ),
    )
    body: str = Field(..., min_length=1, description="Message content")
    reply_to: str | None = Field(
        default=None,
        description="Parent message UUID for threading",
    )
    conv: str = Field(..., description="Conversation ID")

    # -- Thread metadata (derived; populated by broker dispatcher and replay) ---
    # These fields are computed read-side state, not user-supplied. They live on
    # the root dict of a thread (the message whose `reply_to is None` and which
    # has at least one descendant), and are recomputed at JSONL replay time.
    # See plans/threaded-replies-plan §4.1.
    thread_root_id: str | None = Field(
        default=None,
        description=(
            "On a reply: id of the thread root. On a top-level message: None. "
            "Derived; populated by the broker dispatcher on reply ingest."
        ),
    )
    thread_reply_count: int | None = Field(
        default=None,
        description=(
            "On a thread root with at least one reply: count of replies. "
            "None on top-level messages with no replies and on reply messages."
        ),
    )
    thread_last_ts: str | None = Field(
        default=None,
        description=(
            "On a thread root: ts of the most recent reply. None when no "
            "replies. Used for thread_summary.last_ts in comms_read."
        ),
    )
    thread_last_author: str | None = Field(
        default=None,
        description=(
            "On a thread root: display name of the author of the most recent "
            "reply. None when no replies. Stored at dispatcher / replay time "
            "so the chip can render 'N replies, last by @X' without a "
            "read-time scan."
        ),
    )
    thread_participants: list[str] | None = Field(
        default=None,
        description=(
            "On a thread root: ordered, deduped list of participant keys "
            "who have replied OR been @mentioned inside the thread. None "
            "when the message has no replies."
        ),
    )

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
            for key in v:
                if not KEY_PATTERN.match(key):
                    raise ValueError(
                        f"recipient key must be 8 lowercase hex chars, got {key!r}"
                    )
        return v

    @field_validator("mentions")
    @classmethod
    def _validate_mentions(cls, v: list[str] | None) -> list[str] | None:
        # Mirrors `_validate_recipients` (per-key 8-lowercase-hex regex,
        # null-passes-through). `mentions` is presentation metadata, not a
        # visibility filter — see plans/mentions-vs-whisper-separation.md §5.
        if v is not None:
            for key in v:
                if not KEY_PATTERN.match(key):
                    raise ValueError(
                        f"mention key must be 8 lowercase hex chars, got {key!r}"
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
        mentions: list[str] | None = None,
        reply_to: str | None = None,
    ) -> Message:
        """Build a Message with auto-generated id and timestamp."""
        return cls(
            sender=Sender(key=sender_key, name=sender_name, type=sender_type),
            body=body,
            conv=conv,
            recipients=recipients,
            mentions=mentions,
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
