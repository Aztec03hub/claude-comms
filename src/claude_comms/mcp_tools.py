"""MCP tool definitions for claude-comms.

Each tool function is pure logic that operates on shared state objects
(participant registry, message store, MQTT publish callback).  The MCP
server module wires these to ``FastMCP`` decorators and provides the
runtime dependencies.

All tools accept a ``key`` parameter for caller identity (since the MCP
server uses ``stateless_http=True`` -- each request is independent).
"""

from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timezone
from typing import Any

from claude_comms.mention import build_mention_prefix
from claude_comms.message import Message, now_iso, validate_conv_id
from claude_comms.participant import Participant, validate_key, validate_name

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Token-aware pagination constants
# ---------------------------------------------------------------------------

# Rough estimate: 1 token ~= 4 characters.  MCP output cap is 25,000 tokens.
# We target 20,000 tokens to leave headroom for wrapper JSON.
MAX_OUTPUT_CHARS = 80_000  # 20k tokens * 4 chars/token


# ---------------------------------------------------------------------------
# Participant registry  (in-memory, thread-safe)
# ---------------------------------------------------------------------------


class ParticipantRegistry:
    """In-memory registry of participants keyed by their 8-hex key.

    Also maintains per-conversation membership and per-participant
    read cursors for unread tracking.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # key -> Participant
        self._participants: dict[str, Participant] = {}
        # key -> set of conversation IDs
        self._memberships: dict[str, set[str]] = {}
        # (key, conv_id) -> ISO timestamp of last read
        self._read_cursors: dict[tuple[str, str], str] = {}
        # name (lower) -> key  (for name resolution)
        self._name_index: dict[str, str] = {}

    # -- Registration ------------------------------------------------------

    def join(
        self,
        name: str,
        conversation: str,
        *,
        participant_type: str = "claude",
        key: str | None = None,
    ) -> Participant:
        """Register or re-register a participant in a conversation.

        If *key* is provided and already registered, the participant is
        re-joined (idempotent).  If *key* is ``None`` but a participant
        with the same *name* already exists, the existing participant is
        returned (name-based idempotency for first-call convenience).

        Returns the :class:`Participant`.
        """
        with self._lock:
            # If key provided, look up existing participant
            if key and key in self._participants:
                p = self._participants[key]
                self._memberships.setdefault(key, set()).add(conversation)
                return p

            # Name-based lookup (idempotent re-join)
            existing_key = self._name_index.get(name.lower())
            if existing_key and existing_key in self._participants:
                p = self._participants[existing_key]
                self._memberships.setdefault(existing_key, set()).add(conversation)
                return p

            # New participant
            p = Participant.create(name=name, participant_type=participant_type)
            self._participants[p.key] = p
            self._name_index[name.lower()] = p.key
            self._memberships.setdefault(p.key, set()).add(conversation)
            return p

    def leave(self, key: str, conversation: str) -> bool:
        """Remove *key* from *conversation*.  Returns True if they were a member."""
        with self._lock:
            convs = self._memberships.get(key)
            if convs and conversation in convs:
                convs.discard(conversation)
                return True
            return False

    def get(self, key: str) -> Participant | None:
        """Look up a participant by key."""
        with self._lock:
            return self._participants.get(key)

    def update_name(self, key: str, new_name: str) -> Participant | None:
        """Change a participant's display name.  Returns updated participant or None."""
        with self._lock:
            p = self._participants.get(key)
            if p is None:
                return None
            # Remove old name index entry
            old_lower = p.name.lower()
            if self._name_index.get(old_lower) == key:
                del self._name_index[old_lower]
            # Update
            updated = p.with_name(new_name)
            self._participants[key] = updated
            self._name_index[new_name.lower()] = key
            return updated

    def members(self, conversation: str) -> list[Participant]:
        """Return participants currently in *conversation*."""
        with self._lock:
            result = []
            for key, convs in self._memberships.items():
                if conversation in convs:
                    p = self._participants.get(key)
                    if p:
                        result.append(p)
            return result

    def conversations_for(self, key: str) -> list[str]:
        """Return conversation IDs that *key* is a member of."""
        with self._lock:
            return list(self._memberships.get(key, set()))

    def resolve_name(self, name: str) -> str | None:
        """Resolve a display name to a participant key (case-insensitive)."""
        with self._lock:
            return self._name_index.get(name.lower())

    def resolve_recipients(self, recipients: list[str]) -> list[str]:
        """Resolve a mixed list of names and keys to keys only.

        Entries that are already valid 8-hex keys are kept as-is.
        Names are resolved via the name index.  Unresolvable entries
        are silently dropped.
        """
        hex8 = re.compile(r"^[0-9a-f]{8}$")
        keys: list[str] = []
        seen: set[str] = set()
        with self._lock:
            for entry in recipients:
                if hex8.match(entry):
                    k = entry
                else:
                    k = self._name_index.get(entry.lower())
                if k and k not in seen:
                    seen.add(k)
                    keys.append(k)
        return keys

    def name_to_key_map(self, conversation: str) -> dict[str, str]:
        """Return a {name: key} map for all members of *conversation*."""
        with self._lock:
            result: dict[str, str] = {}
            for key, convs in self._memberships.items():
                if conversation in convs:
                    p = self._participants.get(key)
                    if p:
                        result[p.name] = key
            return result

    # -- Read cursors ------------------------------------------------------

    def update_cursor(self, key: str, conversation: str, ts: str) -> None:
        """Update the read cursor for *key* in *conversation*."""
        with self._lock:
            self._read_cursors[(key, conversation)] = ts

    def get_cursor(self, key: str, conversation: str) -> str | None:
        """Return the read cursor (ISO timestamp) or None."""
        with self._lock:
            return self._read_cursors.get((key, conversation))


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def _error(msg: str) -> dict[str, Any]:
    """Return a structured error dict."""
    return {"error": True, "message": msg}


def _validate_key_registered(
    registry: ParticipantRegistry, key: str
) -> Participant | dict[str, Any]:
    """Validate that *key* is registered.  Returns Participant or error dict."""
    if not validate_key(key):
        return _error(f"Invalid key format: {key!r}. Must be 8 lowercase hex chars.")
    p = registry.get(key)
    if p is None:
        return _error(
            f"Unknown participant key {key!r}. Call comms_join first to register."
        )
    return p


def tool_comms_join(
    registry: ParticipantRegistry,
    *,
    key: str | None = None,
    conversation: str = "general",
    name: str | None = None,
) -> dict[str, Any]:
    """Join a conversation.  Returns participant info including key."""
    if not validate_conv_id(conversation):
        return _error(
            f"Invalid conversation ID {conversation!r}. "
            "Use lowercase alphanumeric + hyphens, 1-64 chars."
        )

    # If key provided, validate and re-join
    if key:
        if not validate_key(key):
            return _error(f"Invalid key format: {key!r}.")
        existing = registry.get(key)
        if existing:
            p = registry.join(
                existing.name, conversation, key=key, participant_type=existing.type
            )
            return {
                "key": p.key,
                "name": p.name,
                "type": p.type,
                "conversation": conversation,
                "status": "joined",
            }

    # First-time join requires name
    if not name:
        return _error("Parameter 'name' is required on first join (no existing key).")
    if not validate_name(name):
        return _error(
            f"Invalid name {name!r}. Use alphanumeric, hyphens, underscores (1-64 chars)."
        )

    p = registry.join(name, conversation)
    return {
        "key": p.key,
        "name": p.name,
        "type": p.type,
        "conversation": conversation,
        "status": "joined",
    }


def tool_comms_leave(
    registry: ParticipantRegistry,
    *,
    key: str,
    conversation: str,
) -> dict[str, Any]:
    """Leave a conversation."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    removed = registry.leave(key, conversation)
    if removed:
        return {"status": "left", "conversation": conversation}
    return {"status": "not_a_member", "conversation": conversation}


async def tool_comms_send(
    registry: ParticipantRegistry,
    publish_fn: Any,  # async callable(topic, payload)
    *,
    key: str,
    conversation: str,
    message: str,
    recipients: list[str] | None = None,
) -> dict[str, Any]:
    """Send a message to a conversation.

    *publish_fn* is an async callable ``(topic: str, payload: bytes) -> None``
    provided by the MCP server (wrapping aiomqtt publish).
    """
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    sender: Participant = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")
    if not message or not message.strip():
        return _error("Message body cannot be empty.")

    # Resolve recipients (names or keys -> keys)
    resolved_keys: list[str] | None = None
    if recipients:
        resolved_keys = registry.resolve_recipients(recipients)
        if not resolved_keys:
            return _error(
                "None of the specified recipients could be resolved. "
                "Check names/keys and ensure they have joined the conversation."
            )
        # Build human-readable mention prefix
        # Look up names for the resolved keys
        members = registry.members(conversation)
        key_to_name = {m.key: m.name for m in members}
        mentioned_names = [key_to_name[k] for k in resolved_keys if k in key_to_name]
        prefix = build_mention_prefix(mentioned_names)
        body = prefix + message
    else:
        body = message

    msg = Message.create(
        sender_key=sender.key,
        sender_name=sender.name,
        sender_type=sender.type,
        body=body,
        conv=conversation,
        recipients=resolved_keys,
    )

    try:
        await publish_fn(msg.topic, msg.to_mqtt_payload().encode("utf-8"))
    except Exception as exc:
        logger.exception("Failed to publish message")
        return _error(
            f"Failed to send message: {exc}. "
            "Ensure the MQTT broker is running ('claude-comms start')."
        )

    return {
        "status": "sent",
        "id": msg.id,
        "conversation": conversation,
        "recipients": resolved_keys,
    }


def tool_comms_read(
    registry: ParticipantRegistry,
    store: Any,  # MessageStore
    *,
    key: str,
    conversation: str,
    count: int = 20,
    since: str | None = None,
) -> dict[str, Any]:
    """Read recent messages from a conversation with token-aware pagination."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    count = max(1, min(count, 200))  # Clamp

    # Get all messages then filter
    all_msgs = store.get(conversation)

    if since:
        all_msgs = [m for m in all_msgs if m.get("ts", "") > since]

    # Take the most recent `count` messages
    selected = all_msgs[-count:] if len(all_msgs) > count else all_msgs
    has_more = len(all_msgs) > len(selected)

    # Token-aware truncation: estimate character count and trim from front
    formatted: list[dict[str, Any]] = []
    total_chars = 0
    for msg in reversed(selected):
        # Estimate this message's character contribution
        msg_chars = len(str(msg))
        if total_chars + msg_chars > MAX_OUTPUT_CHARS and formatted:
            has_more = True
            break
        formatted.append(msg)
        total_chars += msg_chars

    # Reverse back to chronological order
    formatted.reverse()

    # Update read cursor to latest message timestamp
    if formatted:
        latest_ts = formatted[-1].get("ts", "")
        if latest_ts:
            registry.update_cursor(key, conversation, latest_ts)

    return {
        "conversation": conversation,
        "messages": formatted,
        "count": len(formatted),
        "has_more": has_more,
    }


def tool_comms_check(
    registry: ParticipantRegistry,
    store: Any,  # MessageStore
    *,
    key: str,
    conversation: str | None = None,
) -> dict[str, Any]:
    """Check for unread messages."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if conversation:
        convs = [conversation]
    else:
        convs = registry.conversations_for(key)

    unread_summary: list[dict[str, Any]] = []
    total_unread = 0

    for conv_id in convs:
        cursor = registry.get_cursor(key, conv_id)
        msgs = store.get(conv_id)
        if cursor:
            unread = [m for m in msgs if m.get("ts", "") > cursor]
        else:
            unread = msgs
        if unread:
            total_unread += len(unread)
            unread_summary.append({
                "conversation": conv_id,
                "unread_count": len(unread),
                "latest": unread[-1] if unread else None,
            })

    return {
        "total_unread": total_unread,
        "conversations": unread_summary,
    }


def tool_comms_members(
    registry: ParticipantRegistry,
    *,
    key: str,
    conversation: str,
) -> dict[str, Any]:
    """List participants in a conversation."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    members = registry.members(conversation)
    return {
        "conversation": conversation,
        "members": [
            {"key": m.key, "name": m.name, "type": m.type} for m in members
        ],
        "count": len(members),
    }


def tool_comms_conversations(
    registry: ParticipantRegistry,
    store: Any,  # MessageStore
    *,
    key: str,
) -> dict[str, Any]:
    """List conversations the participant has joined, with unread counts."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    convs = registry.conversations_for(key)
    conv_list: list[dict[str, Any]] = []

    for conv_id in sorted(convs):
        cursor = registry.get_cursor(key, conv_id)
        msgs = store.get(conv_id)
        if cursor:
            unread_count = sum(1 for m in msgs if m.get("ts", "") > cursor)
        else:
            unread_count = len(msgs)
        conv_list.append({
            "conversation": conv_id,
            "unread_count": unread_count,
            "total_messages": len(msgs),
        })

    return {"conversations": conv_list}


def tool_comms_update_name(
    registry: ParticipantRegistry,
    *,
    key: str,
    new_name: str,
) -> dict[str, Any]:
    """Change a participant's display name."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_name(new_name):
        return _error(
            f"Invalid name {new_name!r}. "
            "Use alphanumeric, hyphens, underscores (1-64 chars)."
        )

    updated = registry.update_name(key, new_name)
    if updated is None:
        return _error("Failed to update name.")
    return {"key": updated.key, "name": updated.name, "status": "updated"}


def tool_comms_history(
    registry: ParticipantRegistry,
    store: Any,  # MessageStore
    *,
    key: str,
    conversation: str,
    query: str | None = None,
    count: int = 50,
) -> dict[str, Any]:
    """Search message history, optionally filtering by text query."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    count = max(1, min(count, 200))
    all_msgs = store.get(conversation)

    if query:
        query_lower = query.lower()
        all_msgs = [
            m
            for m in all_msgs
            if query_lower in m.get("body", "").lower()
            or query_lower in m.get("sender", {}).get("name", "").lower()
        ]

    selected = all_msgs[-count:]
    has_more = len(all_msgs) > count

    # Token-aware truncation
    formatted: list[dict[str, Any]] = []
    total_chars = 0
    for msg in reversed(selected):
        msg_chars = len(str(msg))
        if total_chars + msg_chars > MAX_OUTPUT_CHARS and formatted:
            has_more = True
            break
        formatted.append(msg)
        total_chars += msg_chars
    formatted.reverse()

    return {
        "conversation": conversation,
        "query": query,
        "messages": formatted,
        "count": len(formatted),
        "has_more": has_more,
    }
