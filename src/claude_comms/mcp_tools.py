"""MCP tool definitions for claude-comms.

Each tool function is pure logic that operates on shared state objects
(participant registry, message store, MQTT publish callback).  The MCP
server module wires these to ``FastMCP`` decorators and provides the
runtime dependencies.

All tools accept a ``key`` parameter for caller identity (since the MCP
server uses ``stateless_http=True`` -- each request is independent).
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from claude_comms.conversation import (
    RESERVED_CONVERSATION_NAMES,
    create_conversation_atomic,
    list_all_conversations,
    load_meta,
    save_meta,
)

from claude_comms.artifact import (
    Artifact,
    ArtifactVersion,
    DEFAULT_GET_CHUNK_SIZE,
    MAX_VERSIONS,
    delete_artifact,
    list_artifacts,
    load_artifact,
    save_artifact,
    validate_artifact_name,
)
from claude_comms.broker import MessageStore
from claude_comms.mention import build_mention_prefix
from claude_comms.message import Message, Sender, now_iso, validate_conv_id
from claude_comms.participant import (
    Participant,
    ParticipantType,
    validate_key,
    validate_name,
)


class PublishFn(Protocol):
    """Async callable that publishes a message to an MQTT topic."""

    async def __call__(self, topic: str, payload: bytes) -> None: ...


logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Token-aware pagination constants
# ---------------------------------------------------------------------------

# Rough estimate: 1 token ~= 4 characters.  MCP output cap is 25,000 tokens.
# We target 20,000 tokens to leave headroom for wrapper JSON.
MAX_OUTPUT_CHARS = 80_000  # 20k tokens * 4 chars/token


# ---------------------------------------------------------------------------
# Recipient visibility filter
# ---------------------------------------------------------------------------


def _is_visible(msg: dict[str, Any], viewer_key: str) -> bool:
    """Return True if *msg* should be visible to *viewer_key*.

    Broadcast messages (recipients is null/empty) are visible to everyone.
    Targeted messages are visible only to the sender and listed recipients.
    """
    recipients = msg.get("recipients")
    if not recipients:  # null or empty list = broadcast
        return True
    sender_key = msg.get("sender", {}).get("key", "")
    return viewer_key in recipients or viewer_key == sender_key


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
        participant_type: ParticipantType = "claude",
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

            # New participant — honor provided key if valid, else generate.
            # Honoring the caller's key keeps the server registry aligned with
            # clients that derive their identity from config (web UI, CLI).
            if key and validate_key(key):
                p = Participant(key=key, name=name, type=participant_type)
            else:
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


def _auto_join_humans(registry: ParticipantRegistry, conversation: str) -> list[str]:
    """Auto-join all human-type participants to a conversation. Returns list of auto-joined keys."""
    joined_keys: list[str] = []
    # Use members of "general" as proxy (all humans are in general)
    general_members = registry.members("general")
    for member in general_members:
        if member.type == "human":
            registry.join(member.name, conversation, key=member.key, participant_type="human")
            joined_keys.append(member.key)
    return joined_keys


async def tool_comms_join(
    registry: ParticipantRegistry,
    *,
    key: str | None = None,
    conversation: str = "general",
    name: str | None = None,
    publish_fn: PublishFn | None = None,
    conv_data_dir: Path | None = None,
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

            # Implicit creation: if conv_data_dir provided, try atomic create
            if conv_data_dir is not None:
                meta = create_conversation_atomic(
                    conversation, topic="", created_by=existing.name, data_dir=conv_data_dir
                )
                if meta is not None:
                    # New conversation was created — run side effects
                    _auto_join_humans(registry, conversation)
                    if publish_fn is not None:
                        body = f"[system] {existing.name} created #{conversation}"
                        system_msg = {
                            "id": str(uuid4()),
                            "ts": now_iso(),
                            "sender": {"key": "00000000", "name": "system", "type": "system"},
                            "body": body,
                            "conv": "general",
                            "recipients": None,
                            "reply_to": None,
                        }
                        topic = "claude-comms/conv/general/messages"
                        await publish_fn(topic, json.dumps(system_msg).encode())

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

    # Implicit creation: if conv_data_dir provided, try atomic create
    if conv_data_dir is not None:
        meta = create_conversation_atomic(
            conversation, topic="", created_by=p.name, data_dir=conv_data_dir
        )
        if meta is not None:
            # New conversation was created — run side effects
            _auto_join_humans(registry, conversation)
            if publish_fn is not None:
                body = f"[system] {p.name} created #{conversation}"
                system_msg = {
                    "id": str(uuid4()),
                    "ts": now_iso(),
                    "sender": {"key": "00000000", "name": "system", "type": "system"},
                    "body": body,
                    "conv": "general",
                    "recipients": None,
                    "reply_to": None,
                }
                topic = "claude-comms/conv/general/messages"
                await publish_fn(topic, json.dumps(system_msg).encode())

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
    publish_fn: PublishFn,
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
    store: MessageStore,
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

    # Filter out targeted messages not visible to this participant
    all_msgs = [m for m in all_msgs if _is_visible(m, key)]

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
    store: MessageStore,
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
            unread_summary.append(
                {
                    "conversation": conv_id,
                    "unread_count": len(unread),
                    "latest": unread[-1] if unread else None,
                }
            )

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
            {
                "key": m.key,
                "name": m.name,
                "type": m.type,
                # New: connection-aware fields
                "connections": {k: v.model_dump() for k, v in m.connections.items()},
                "online": m.is_online,
                # Backward compat: top-level client and status
                "client": m.client
                or (m.active_client_types[0] if m.active_client_types else None),
                "status": "online" if m.is_online else "offline",
            }
            for m in members
        ],
        "count": len(members),
    }


def tool_comms_conversations(
    registry: ParticipantRegistry,
    store: MessageStore,
    *,
    key: str,
    all: bool = False,
    conv_data_dir: Path | None = None,
) -> dict[str, Any]:
    """List conversations the participant has joined, with unread counts.

    When *all* is True and *conv_data_dir* is provided, also returns all
    known conversations (including ones the caller hasn't joined).
    """
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
        conv_list.append(
            {
                "conversation": conv_id,
                "unread_count": unread_count,
                "total_messages": len(msgs),
            }
        )

    response: dict[str, Any] = {"conversations": conv_list}

    if all and conv_data_dir is not None:
        joined_set = set(convs)
        all_metas = list_all_conversations(conv_data_dir)
        all_convs: list[dict[str, Any]] = []
        for meta in all_metas:
            members = registry.members(meta.name)
            msgs = store.get(meta.name)
            all_convs.append(
                {
                    "name": meta.name,
                    "topic": meta.topic,
                    "member_count": len(members),
                    "message_count": len(msgs),
                    "last_activity": meta.last_activity,
                    "joined": meta.name in joined_set,
                }
            )
        response["all_conversations"] = all_convs

    return response


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
    store: MessageStore,
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


# ---------------------------------------------------------------------------
# Artifact tool implementations
# ---------------------------------------------------------------------------


async def tool_comms_artifact_create(
    registry: ParticipantRegistry,
    publish_fn: PublishFn,
    *,
    key: str,
    conversation: str,
    name: str,
    title: str,
    type: str,
    content: str,
    data_dir: Path,
) -> dict[str, Any]:
    """Create a new shared artifact in a conversation."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    participant: Participant = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    ok, err = validate_artifact_name(name)
    if not ok:
        return _error(f"Invalid artifact name {name!r}: {err}")

    if type not in ("plan", "doc", "code"):
        return _error(
            f"Invalid artifact type {type!r}. Must be one of: plan, doc, code."
        )

    convs = registry.conversations_for(key)
    if conversation not in convs:
        return _error(f"Not a member of conversation {conversation!r}. Join first.")

    # Case-collision protection (R1-6): NTFS / HFS+ treat `Foo` and `foo` as the
    # same file. Reject a case-insensitive collision at create time so the
    # second creator sees an error instead of silently clobbering.
    existing_lower = {a["name"].lower() for a in list_artifacts(conversation, data_dir)}
    if name.lower() in existing_lower:
        return _error(
            f"Artifact name {name!r} collides (case-insensitive) with an existing artifact."
        )

    # Check if artifact already exists
    existing = load_artifact(conversation, name, data_dir)
    if existing is not None:
        return _error(
            f"Artifact {name!r} already exists in conversation {conversation!r}. "
            "Use comms_artifact_update to modify it."
        )

    sender = Sender(key=participant.key, name=participant.name, type=participant.type)
    version = ArtifactVersion(
        version=1,
        content=content,
        author=sender,
        timestamp=now_iso(),
        summary="Initial version",
    )
    artifact = Artifact(
        id=str(uuid4()),
        name=name,
        title=title,
        type=type,
        conversation_id=conversation,
        created_by=sender,
        versions=[version],
    )
    save_artifact(artifact, data_dir)

    # Publish system message
    system_msg = {
        "id": str(uuid4()),
        "ts": now_iso(),
        "sender": {"key": "00000000", "name": "system", "type": "system"},
        "body": f"[artifact] {participant.name} created '{title}' (v1)",
        "conv": conversation,
        "recipients": None,
        "reply_to": None,
        "artifact_ref": name,
    }
    topic = f"claude-comms/conv/{conversation}/messages"
    await publish_fn(topic, json.dumps(system_msg).encode())

    return {"status": "created", "name": name, "title": title, "version": 1}


async def tool_comms_artifact_update(
    registry: ParticipantRegistry,
    publish_fn: PublishFn,
    *,
    key: str,
    conversation: str,
    name: str,
    content: str,
    summary: str = "",
    base_version: int | None = None,
    data_dir: Path,
) -> dict[str, Any]:
    """Update an existing artifact with a new version."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    participant: Participant = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    ok, err = validate_artifact_name(name)
    if not ok:
        return _error(f"Invalid artifact name {name!r}: {err}")

    convs = registry.conversations_for(key)
    if conversation not in convs:
        return _error(f"Not a member of conversation {conversation!r}. Join first.")

    artifact = load_artifact(conversation, name, data_dir)
    if artifact is None:
        return _error(
            f"Artifact {name!r} not found in conversation {conversation!r}."
        )

    # Optimistic concurrency check.
    # R1-2 fix: use max(v.version) instead of len(versions). After the versions
    # list is pruned past MAX_VERSIONS, len() stops advancing and every new
    # update would re-use the same number, and the base_version check would
    # report the wrong "current" version to clients.
    current_version = max((v.version for v in artifact.versions), default=0)
    if base_version is not None and base_version != current_version:
        return _error(
            f"Version conflict: you based your edit on v{base_version}, "
            f"but current version is v{current_version}. "
            "Re-read the artifact and try again."
        )

    sender = Sender(key=participant.key, name=participant.name, type=participant.type)
    new_version = current_version + 1
    version = ArtifactVersion(
        version=new_version,
        content=content,
        author=sender,
        timestamp=now_iso(),
        summary=summary,
    )
    artifact.versions.append(version)

    # Prune if versions exceed MAX_VERSIONS (keep newest)
    if len(artifact.versions) > MAX_VERSIONS:
        artifact.versions = artifact.versions[-MAX_VERSIONS:]

    save_artifact(artifact, data_dir)

    # Publish system message
    body = f"[artifact] {participant.name} updated '{artifact.title}' to v{new_version}"
    if summary:
        body += f": {summary}"
    system_msg = {
        "id": str(uuid4()),
        "ts": now_iso(),
        "sender": {"key": "00000000", "name": "system", "type": "system"},
        "body": body,
        "conv": conversation,
        "recipients": None,
        "reply_to": None,
        "artifact_ref": name,
    }
    topic = f"claude-comms/conv/{conversation}/messages"
    await publish_fn(topic, json.dumps(system_msg).encode())

    return {"status": "updated", "name": name, "version": new_version}


def tool_comms_artifact_get(
    registry: ParticipantRegistry,
    *,
    key: str,
    conversation: str,
    name: str,
    version: int | None = None,
    offset: int = 0,
    limit: int | None = None,
    data_dir: Path,
) -> dict[str, Any]:
    """Read an artifact's content with chunked pagination."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    ok, err = validate_artifact_name(name)
    if not ok:
        return _error(f"Invalid artifact name {name!r}: {err}")

    convs = registry.conversations_for(key)
    if conversation not in convs:
        return _error(f"Not a member of conversation {conversation!r}. Join first.")

    artifact = load_artifact(conversation, name, data_dir)
    if artifact is None:
        return _error(
            f"Artifact {name!r} not found in conversation {conversation!r}."
        )

    # Select version
    if version is not None:
        selected_version = None
        for v in artifact.versions:
            if v.version == version:
                selected_version = v
                break
        if selected_version is None:
            return _error(
                f"Version {version} not found for artifact {name!r}. "
                f"Available versions: {[v.version for v in artifact.versions]}."
            )
    else:
        selected_version = artifact.versions[-1]

    # Chunked content retrieval
    if limit is None:
        limit = DEFAULT_GET_CHUNK_SIZE
    full_content = selected_version.content
    total_chars = len(full_content)
    chunk = full_content[offset : offset + limit]
    has_more = (offset + limit) < total_chars
    next_offset = offset + limit if has_more else None

    # Version metadata (all versions, no content)
    version_metadata = [
        {
            "version": v.version,
            "author": v.author.model_dump(),
            "timestamp": v.timestamp,
            "summary": v.summary,
        }
        for v in artifact.versions
    ]

    return {
        "name": artifact.name,
        "title": artifact.title,
        "type": artifact.type,
        "version": selected_version.version,
        "content": chunk,
        "total_chars": total_chars,
        "offset": offset,
        "has_more": has_more,
        "next_offset": next_offset,
        "versions": version_metadata,
    }


def tool_comms_artifact_list(
    registry: ParticipantRegistry,
    *,
    key: str,
    conversation: str,
    data_dir: Path,
) -> dict[str, Any]:
    """List all artifacts in a conversation."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    convs = registry.conversations_for(key)
    if conversation not in convs:
        return _error(f"Not a member of conversation {conversation!r}. Join first.")

    artifacts = list_artifacts(conversation, data_dir)
    return {
        "conversation": conversation,
        "artifacts": artifacts,
        "count": len(artifacts),
    }


async def tool_comms_artifact_delete(
    registry: ParticipantRegistry,
    publish_fn: PublishFn,
    *,
    key: str,
    conversation: str,
    name: str,
    data_dir: Path,
) -> dict[str, Any]:
    """Delete an artifact from a conversation."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    participant: Participant = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    ok, err = validate_artifact_name(name)
    if not ok:
        return _error(f"Invalid artifact name {name!r}: {err}")

    convs = registry.conversations_for(key)
    if conversation not in convs:
        return _error(f"Not a member of conversation {conversation!r}. Join first.")

    # Load first to get title for the system message
    artifact = load_artifact(conversation, name, data_dir)
    if artifact is None:
        return _error(
            f"Artifact {name!r} not found in conversation {conversation!r}."
        )
    title = artifact.title

    deleted = delete_artifact(conversation, name, data_dir)
    if not deleted:
        return _error(f"Failed to delete artifact {name!r}.")

    # Publish system message
    system_msg = {
        "id": str(uuid4()),
        "ts": now_iso(),
        "sender": {"key": "00000000", "name": "system", "type": "system"},
        "body": f"[artifact] {participant.name} deleted '{title}'",
        "conv": conversation,
        "recipients": None,
        "reply_to": None,
        "artifact_ref": name,
    }
    topic = f"claude-comms/conv/{conversation}/messages"
    await publish_fn(topic, json.dumps(system_msg).encode())

    return {"status": "deleted", "name": name}


# ---------------------------------------------------------------------------
# Conversation discovery tool implementations
# ---------------------------------------------------------------------------


async def tool_comms_conversation_create(
    registry: ParticipantRegistry,
    publish_fn: PublishFn,
    *,
    key: str,
    conversation: str,
    topic: str = "",
    conv_data_dir: Path,
) -> dict[str, Any]:
    """Create a new named conversation with optional topic."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    participant: Participant = result

    if not validate_conv_id(conversation):
        return _error(
            f"Invalid conversation ID {conversation!r}. "
            "Use lowercase alphanumeric + hyphens, 1-64 chars."
        )

    if conversation in RESERVED_CONVERSATION_NAMES:
        return _error(
            f"Conversation name {conversation!r} is reserved and cannot be created explicitly."
        )

    meta = create_conversation_atomic(
        conversation, topic=topic, created_by=participant.name, data_dir=conv_data_dir
    )
    if meta is None:
        return _error(
            f"Conversation {conversation!r} already exists. "
            "Use comms_join to join it, or comms_conversation_update to change its topic."
        )

    # Auto-join creator
    registry.join(participant.name, conversation, key=key, participant_type=participant.type)

    # Auto-join humans
    _auto_join_humans(registry, conversation)

    # Publish system message to both the new conversation and "general"
    body = f"[system] {participant.name} created #{conversation}"
    if topic:
        body += f": '{topic}'"

    system_msg_base = {
        "ts": now_iso(),
        "sender": {"key": "00000000", "name": "system", "type": "system"},
        "body": body,
        "recipients": None,
        "reply_to": None,
    }

    for target_conv in (conversation, "general"):
        msg = {**system_msg_base, "id": str(uuid4()), "conv": target_conv}
        mqtt_topic = f"claude-comms/conv/{target_conv}/messages"
        await publish_fn(mqtt_topic, json.dumps(msg).encode())

    return {"status": "created", "conversation": conversation, "topic": topic}


async def tool_comms_conversation_update(
    registry: ParticipantRegistry,
    publish_fn: PublishFn,
    *,
    key: str,
    conversation: str,
    topic: str,
    conv_data_dir: Path,
    rate_limit_state: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Update a conversation's topic."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    participant: Participant = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    # Check caller is a member
    convs = registry.conversations_for(key)
    if conversation not in convs:
        return _error(f"Not a member of conversation {conversation!r}. Join first.")

    meta = load_meta(conversation, conv_data_dir)
    if meta is None:
        return _error(f"Conversation {conversation!r} not found.")

    # Update topic and save
    meta.topic = topic
    save_meta(meta, conv_data_dir)

    # Rate limiting for system messages
    system_message_status = "sent"
    now = time.monotonic()
    rate_limited = False
    if rate_limit_state is not None:
        last_time = rate_limit_state.get(conversation, 0.0)
        if (now - last_time) < 60.0:
            rate_limited = True
            system_message_status = "suppressed (rate limited)"

    if not rate_limited:
        body = f"[system] {participant.name} updated #{conversation} topic: '{topic}'"
        system_msg = {
            "id": str(uuid4()),
            "ts": now_iso(),
            "sender": {"key": "00000000", "name": "system", "type": "system"},
            "body": body,
            "conv": "general",
            "recipients": None,
            "reply_to": None,
        }
        mqtt_topic = "claude-comms/conv/general/messages"
        await publish_fn(mqtt_topic, json.dumps(system_msg).encode())
        if rate_limit_state is not None:
            rate_limit_state[conversation] = now

    return {
        "status": "updated",
        "conversation": conversation,
        "topic": topic,
        "system_message": system_message_status,
    }


async def tool_comms_invite(
    registry: ParticipantRegistry,
    publish_fn: PublishFn,
    *,
    key: str,
    conversation: str,
    target_name: str,
    message: str = "",
    conv_data_dir: Path,
) -> dict[str, Any]:
    """Invite a participant to a conversation."""
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    participant: Participant = result

    # Validate caller is a member
    convs = registry.conversations_for(key)
    if conversation not in convs:
        return _error(f"Not a member of conversation {conversation!r}. Join first.")

    # Validate conversation exists
    meta = load_meta(conversation, conv_data_dir)
    if meta is None:
        return _error(f"Conversation {conversation!r} not found.")

    # Resolve target
    target_key = registry.resolve_name(target_name)
    if target_key is None:
        return _error(f"Unknown participant '{target_name}'.")

    # Check if target is already a member
    target_convs = registry.conversations_for(target_key)
    if conversation in target_convs:
        return {"status": "already_member"}

    # Post system message to "general"
    body = f"[system] {participant.name} invited {target_name} to #{conversation}"
    if message:
        body += f': "{message}"'
    system_msg = {
        "id": str(uuid4()),
        "ts": now_iso(),
        "sender": {"key": "00000000", "name": "system", "type": "system"},
        "body": body,
        "conv": "general",
        "recipients": None,
        "reply_to": None,
    }
    mqtt_topic = "claude-comms/conv/general/messages"
    await publish_fn(mqtt_topic, json.dumps(system_msg).encode())

    return {"status": "invited"}
