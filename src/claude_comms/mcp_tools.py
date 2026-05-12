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
from datetime import datetime
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
from claude_comms.reactions import (
    ReactionEvent,
    ReactionsStore,
    reactions_topic,
)
from claude_comms.mention import build_mention_prefix
from claude_comms.message import Message, Sender, now_iso, validate_conv_id
from claude_comms.participant import (
    Activity,
    ConnectionInfo,
    Participant,
    ParticipantType,
    validate_key,
    validate_name,
)
from claude_comms.registry_store import RegistryStore


class PublishFn(Protocol):
    """Async callable that publishes a message to an MQTT topic.

    ``retain`` defaults to False; pass True for presence / membership state
    that should reach late-arriving subscribers via the broker's retained-
    message store. Matches ``aiomqtt.Client.publish``'s ``retain`` kwarg.
    """

    async def __call__(
        self, topic: str, payload: bytes, retain: bool = False
    ) -> None: ...


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


def _ts_after(msg_ts: str, anchor: str) -> bool:
    """Return True iff *msg_ts* is strictly after *anchor* in real time.

    ISO-8601 timestamps with mixed timezone notations (e.g. ``...-05:00`` vs
    ``...Z``) cannot be compared as strings — naive ``>`` would say
    ``2026-05-06T11:55:49-05:00 < 2026-05-06T16:49:01Z`` even though the
    former is six minutes *later* in UTC.  Parse both as ``datetime`` and
    compare in real time; fall back to string comparison if either side
    fails to parse so a malformed record never silently breaks the read
    pipeline.
    """
    try:
        return datetime.fromisoformat(msg_ts) > datetime.fromisoformat(anchor)
    except (ValueError, TypeError):
        return msg_ts > anchor


# ---------------------------------------------------------------------------
# Participant registry  (in-memory, thread-safe)
# ---------------------------------------------------------------------------


class ParticipantRegistry:
    """Registry of participants keyed by their 8-hex key.

    Maintains per-conversation membership and per-participant read cursors
    for unread tracking. When constructed with a :class:`RegistryStore`,
    state is rehydrated on init and every mutating method writes through
    to the store atomically so participant keys survive daemon restart.

    When constructed without a store (``store=None``), behaves as a pure
    in-memory registry — the legacy contract preserved for tests that
    don't need persistence.

    ``Participant.connections`` is NEVER persisted: it's ephemeral presence
    state populated by MQTT presence events and ``_ensure_mcp_connection``.
    Rehydrated participants come back with empty ``connections`` (offline)
    and re-populate on next interaction.
    """

    def __init__(self, store: RegistryStore | None = None) -> None:
        self._lock = threading.Lock()
        self._store = store
        if store is not None:
            snapshot = store.load_all()
            # key -> Participant
            self._participants: dict[str, Participant] = dict(snapshot.participants)
            # key -> set of conversation IDs
            self._memberships: dict[str, set[str]] = {
                k: set(v) for k, v in snapshot.memberships.items()
            }
            # (key, conv_id) -> ISO timestamp of last read
            self._read_cursors: dict[tuple[str, str], str] = dict(snapshot.read_cursors)
            # (key, conv_id, root_id) -> ISO timestamp of last in-thread read.
            self._thread_read_cursors: dict[tuple[str, str, str], str] = dict(
                snapshot.thread_read_cursors
            )
            # name (lower) -> key  (for name resolution)
            self._name_index: dict[str, str] = {
                p.name.lower(): k for k, p in snapshot.participants.items()
            }
        else:
            # Pure in-memory registry — preserves legacy test contract.
            self._participants = {}
            self._memberships = {}
            # (key, conv_id) -> ISO timestamp of last read
            self._read_cursors = {}
            # (key, conv_id, root_id) -> ISO timestamp of last in-thread read.
            # Separate keyspace from _read_cursors so per-conv mark_seen never
            # silently masks per-thread unread (plan §4.2 cursor model —
            # phoenix review v3). Lazily populated on first comms_thread_read
            # call.
            self._thread_read_cursors = {}
            # name (lower) -> key  (for name resolution)
            self._name_index = {}

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
                memberships = self._memberships.setdefault(key, set())
                newly_added = conversation not in memberships
                memberships.add(conversation)
                if self._store is not None and newly_added:
                    self._store.add_membership(key, conversation)
                return p

            # Name-based lookup (idempotent re-join)
            existing_key = self._name_index.get(name.lower())
            if existing_key and existing_key in self._participants:
                p = self._participants[existing_key]
                memberships = self._memberships.setdefault(existing_key, set())
                newly_added = conversation not in memberships
                memberships.add(conversation)
                if self._store is not None and newly_added:
                    self._store.add_membership(existing_key, conversation)
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
            if self._store is not None:
                # Persist participant row first so the membership FK resolves.
                self._store.upsert_participant(p)
                self._store.add_membership(p.key, conversation)
            return p

    def leave(self, key: str, conversation: str) -> bool:
        """Remove *key* from *conversation*.  Returns True if they were a member."""
        with self._lock:
            convs = self._memberships.get(key)
            if convs and conversation in convs:
                convs.discard(conversation)
                if self._store is not None:
                    self._store.remove_membership(key, conversation)
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
            if self._store is not None:
                self._store.update_participant_name(key, new_name)
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

    def resolve_for_mentions(self, mentions: list[str]) -> list[str]:
        """Resolve a mixed list of names and keys to keys for the `mentions` field.

        Symmetric with :meth:`resolve_recipients` for name resolution, with one
        added discipline: hex8-format entries are validated against the global
        registry (``self._participants``) and unknowns are dropped. The
        recipients path's lenient hex8 pass-through is intentional and remains
        unchanged; defense in depth is applied only on the mentions path so
        legacy/external-MCP messages can't trigger agents on stale or fabricated
        keys (see plans/mentions-vs-whisper-separation.md §11 Phase A R2-M3).

        Scope is the GLOBAL registry, not per-conversation membership —
        symmetric with ``resolve_recipients``. A user who has left the
        conversation but is still globally registered remains a valid mention
        target.
        """
        hex8 = re.compile(r"^[0-9a-f]{8}$")
        keys: list[str] = []
        seen: set[str] = set()
        with self._lock:
            for entry in mentions:
                if hex8.match(entry):
                    # Hex8 entries must reference an actually-registered participant.
                    if entry not in self._participants:
                        continue
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
            if self._store is not None:
                self._store.upsert_read_cursor(key, conversation, ts)

    def get_cursor(self, key: str, conversation: str) -> str | None:
        """Return the read cursor (ISO timestamp) or None."""
        with self._lock:
            return self._read_cursors.get((key, conversation))

    # -- Per-thread read cursors (plan §4.2) -------------------------------

    def update_thread_cursor(
        self, key: str, conversation: str, root_id: str, ts: str
    ) -> None:
        """Update the per-thread read cursor for *key*'s view of *root_id*."""
        with self._lock:
            self._thread_read_cursors[(key, conversation, root_id)] = ts
            if self._store is not None:
                self._store.upsert_thread_read_cursor(key, conversation, root_id, ts)

    def get_thread_cursor(
        self, key: str, conversation: str, root_id: str
    ) -> str | None:
        """Return the per-thread read cursor (ISO timestamp) or None."""
        with self._lock:
            return self._thread_read_cursors.get((key, conversation, root_id))

    def thread_cursors_for(self, key: str, conversation: str) -> dict[str, str]:
        """Return ``{root_id: ts}`` for every thread cursor *key* holds in *conversation*.

        Used by ``tool_comms_check`` to compute ``thread_unread`` per root.
        """
        with self._lock:
            return {
                root: ts
                for (k, c, root), ts in self._thread_read_cursors.items()
                if k == key and c == conversation
            }

    def advance_thread_cursors_to(
        self,
        key: str,
        conversation: str,
        root_to_ts: dict[str, str],
    ) -> None:
        """Bulk-advance per-thread cursors for *key* in *conversation*.

        Used by ``tool_comms_check(mark_seen=True)`` to clear ``thread_unread``
        in one shot — same single-shot acknowledge contract as the per-conv
        cursor advance.
        """
        with self._lock:
            for root_id, ts in root_to_ts.items():
                self._thread_read_cursors[(key, conversation, root_id)] = ts
                if self._store is not None:
                    self._store.upsert_thread_read_cursor(
                        key, conversation, root_id, ts
                    )


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


def _ensure_mcp_connection(p: Participant) -> None:
    """Ensure a Claude-typed participant has a synthetic ``mcp`` ConnectionInfo.

    Web/TUI clients populate ``ConnectionInfo`` entries via MQTT presence
    messages, but MCP-Claude clients have no MQTT presence layer — they're
    only visible to the registry through their tool calls.  Without a
    connection entry the per-connection ``activity`` field has nowhere to
    land, and ``comms_status_set`` becomes a silent no-op.

    Idempotent: if a Claude already has any ``mcp`` connection, this is a
    no-op.  We do NOT touch human participants — humans always come in
    via web/TUI presence and have real conn_keys.
    """
    if p.type != "claude":
        return
    # Any existing mcp-* connection counts as "already there"
    if any(
        ck == "mcp" or ck.startswith("mcp-") or ci.client == "mcp"
        for ck, ci in p.connections.items()
    ):
        return
    ts = now_iso()
    p.connections["mcp"] = ConnectionInfo(
        client="mcp",
        instance_id=None,
        since=ts,
        last_seen=ts,
    )


def _auto_join_humans(registry: ParticipantRegistry, conversation: str) -> list[str]:
    """Auto-join all human-type participants to a conversation. Returns list of auto-joined keys."""
    joined_keys: list[str] = []
    # Use members of "general" as proxy (all humans are in general)
    general_members = registry.members("general")
    for member in general_members:
        if member.type == "human":
            registry.join(
                member.name, conversation, key=member.key, participant_type="human"
            )
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
            # Synthesize an MCP connection for Claude clients so that
            # per-connection state (activity, last_seen) has somewhere to land.
            _ensure_mcp_connection(p)

            # Implicit creation: if conv_data_dir provided, try atomic create
            if conv_data_dir is not None:
                meta = create_conversation_atomic(
                    conversation,
                    topic="",
                    created_by=existing.name,
                    data_dir=conv_data_dir,
                )
                if meta is not None:
                    # New conversation was created — run side effects
                    _auto_join_humans(registry, conversation)
                    if publish_fn is not None:
                        body = f"[system] {existing.name} created #{conversation}"
                        system_msg = {
                            "id": str(uuid4()),
                            "ts": now_iso(),
                            "sender": {
                                "key": "00000000",
                                "name": "system",
                                "type": "system",
                            },
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
    # Synthesize an MCP connection for Claude clients so that per-connection
    # state (activity, last_seen) has somewhere to land.
    _ensure_mcp_connection(p)

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
    store: MessageStore | None = None,
    *,
    key: str,
    conversation: str,
    message: str,
    mentions: list[str] | None = None,
    recipients: list[str] | None = None,
    reply_to: str | None = None,
) -> dict[str, Any]:
    """Send a message to a conversation.

    ``mentions`` carries broadcast highlight intent (visible to all members;
    named users get a notification cue). ``recipients`` carries whisper intent
    (visible only to sender + listed recipients). Both accept names or 8-hex
    keys and are independent: setting only ``mentions`` produces a broadcast
    with highlight metadata; setting only ``recipients`` produces a whisper;
    setting both produces a whisper with named highlights inside.

    ``reply_to`` carries thread intent (per plans/threaded-replies-plan §3-§4.2).
    When non-null, the server validates that:
      1. the parent message exists in the same conversation,
      2. the parent's own ``reply_to`` is null (depth-2 hard limit), and
      3. the parent is not a system message (``sender.key == "00000000"``).
    When ``store`` is None (legacy call sites that don't pass the message
    store), ``reply_to`` is ignored — validation requires read access to the
    in-memory store. Production wiring in ``mcp_server.py`` always passes it.

    Sender-key dedup discipline (per plans/mentions-vs-whisper-separation.md
    §11 Phase A): the sender's own key is dropped from ``recipients`` (defense
    in depth — composer also dedups at parse-time). It is NOT dropped from
    ``mentions``, because ``mentions`` is presentation metadata and the
    renderer's sender-self special case handles display.

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

    # Thread (reply_to) validation. When `store` is provided and reply_to
    # is non-null, enforce the three rules from plans/threaded-replies-plan
    # §3: parent-exists, depth-2, no-system-parent. Skipped when `store` is
    # None (legacy / test call sites).
    if reply_to is not None and store is not None:
        parent = store.find_by_id(conversation, reply_to)
        if parent is None:
            return _error(
                f"reply_to references unknown message {reply_to!r} "
                f"in conversation {conversation!r}."
            )
        # Depth-2 rule: a reply may not point at another reply.
        if parent.get("reply_to") is not None:
            return _error(
                "reply_to depth limit exceeded: parent is itself a reply. "
                "Threads are flat (depth = 2)."
            )
        # No system-message parents: artifact events, joins, etc. carry
        # sender.key == "00000000" / sender.type == "system".
        parent_sender = parent.get("sender") or {}
        if (
            parent_sender.get("key") == "00000000"
            or parent_sender.get("type") == "system"
        ):
            return _error("reply_to may not target a system message.")

    # Resolve recipients (names or keys -> keys). Sender-key dedup applied
    # post-resolve as defense in depth; the composer also dedups at parse-time.
    resolved_recipients: list[str] | None = None
    if recipients:
        resolved_recipients = registry.resolve_recipients(recipients)
        # Drop sender's own key — self-DM is degenerate; sender always sees
        # own messages via _is_visible's sender-key check anyway.
        resolved_recipients = [k for k in resolved_recipients if k != sender.key]
        if not resolved_recipients:
            return _error(
                "None of the specified recipients could be resolved. "
                "Check names/keys and ensure they have joined the conversation."
            )

    # Resolve mentions (names or keys -> keys) via the mentions-specific
    # variant: hex8 entries are validated against the global registry; unknowns
    # are dropped. Sender-key is NOT dedup'd here — see docstring + §11 Phase A.
    resolved_mentions: list[str] | None = None
    if mentions:
        resolved_mentions = registry.resolve_for_mentions(mentions)
        if not resolved_mentions:
            # Empty after resolution → treat as if mentions wasn't passed.
            # (Don't error: mentions is optional metadata, not a routing field.)
            resolved_mentions = None

    # Body-prefix policy: prepend `[@name1, @name2] ` ONLY when recipients is
    # non-empty (whisper intent). Mentions-only sends never get a server-injected
    # prefix — the wire-format `mentions` field carries highlight intent on its
    # own; the prefix is reserved as the visibility marker for whispers.
    if resolved_recipients:
        members = registry.members(conversation)
        key_to_name = {m.key: m.name for m in members}
        mentioned_names = [
            key_to_name[k] for k in resolved_recipients if k in key_to_name
        ]
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
        recipients=resolved_recipients,
        mentions=resolved_mentions,
        reply_to=reply_to,
    )

    try:
        await publish_fn(msg.topic, msg.to_mqtt_payload().encode("utf-8"))
    except Exception as exc:
        logger.exception("Failed to publish message")
        return _error(
            f"Failed to send message: {exc}. "
            "Ensure the MQTT broker is running ('claude-comms start')."
        )

    # Per-thread fanout topic (plan §4.3): when this message is a reply,
    # additionally publish to `claude-comms/conv/{conv}/threads/{root_id}` so
    # clients that want to follow a single thread without the firehose can
    # subscribe there. Canonical channel for replies stays the
    # `messages` topic above — clients MUST pick one to avoid double-render.
    # Per the depth-2 rule already validated, parent IS root, so reply_to
    # equals the root_id. Failure here is non-fatal: the canonical publish
    # already succeeded, and the firehose subscriber will store + deliver.
    if reply_to is not None:
        thread_topic = f"claude-comms/conv/{conversation}/threads/{reply_to}"
        try:
            await publish_fn(thread_topic, msg.to_mqtt_payload().encode("utf-8"))
        except Exception:
            # Convenience topic only — log and continue.
            logger.warning(
                "Failed to publish per-thread fanout to %s",
                thread_topic,
                exc_info=True,
            )

    return {
        "status": "sent",
        "id": msg.id,
        "conversation": conversation,
        "recipients": resolved_recipients,
        "mentions": resolved_mentions,
        "reply_to": reply_to,
    }


def tool_comms_read(
    registry: ParticipantRegistry,
    store: MessageStore,
    *,
    key: str,
    conversation: str,
    count: int = 20,
    since: str | None = None,
    top_level_only: bool = False,
) -> dict[str, Any]:
    """Read recent messages from a conversation with token-aware pagination.

    ``top_level_only`` (plan §4.2): when True, filter the visible/since-filtered
    list to messages whose ``reply_to`` is None (i.e. thread roots and untyped
    top-level messages), and decorate each retained message with a
    ``thread_summary`` field synthesized from the flat thread metadata fields
    on the message dict (populated by the broker dispatcher / replay
    second-pass — see ``broker.py:_rebuild_thread_metadata``). Default False
    preserves existing non-breaking behaviour for clients that haven't opted
    in. UI passes ``top_level_only=True`` for the channel feed.
    """
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
        all_msgs = [m for m in all_msgs if _ts_after(m.get("ts", ""), since)]

    # Apply top_level_only filter AFTER visibility/since but BEFORE count clamp,
    # so callers asking for "last 20 top-level" don't get a 20-message window
    # that's mostly replies. Plan §4.2.
    if top_level_only:
        all_msgs = [m for m in all_msgs if m.get("reply_to") is None]

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

    # Decorate top-level results with thread_summary synthesized from the flat
    # thread metadata fields (plan §4.2). Only applied when top_level_only=True
    # — otherwise the caller is reading the firehose and doesn't need root-only
    # presentation. We build shallow copies so the decoration never mutates the
    # live store dicts (find_by_id returns live refs; same dicts land here).
    if top_level_only and formatted:
        decorated: list[dict[str, Any]] = []
        for m in formatted:
            reply_count = m.get("thread_reply_count")
            if reply_count:
                # Only attach thread_summary on roots that actually have replies
                # — leaves childless top-levels untouched, no churn.
                copy = dict(m)
                copy["thread_summary"] = {
                    "reply_count": reply_count,
                    "last_ts": m.get("thread_last_ts"),
                    "last_author": m.get("thread_last_author"),
                }
                decorated.append(copy)
            else:
                decorated.append(m)
        formatted = decorated

    return {
        "conversation": conversation,
        "messages": formatted,
        "count": len(formatted),
        "has_more": has_more,
    }


def tool_comms_thread_read(
    registry: ParticipantRegistry,
    store: MessageStore,
    *,
    key: str,
    conversation: str,
    root_id: str,
    count: int = 20,
    since: str | None = None,
) -> dict[str, Any]:
    """Read replies inside a single thread (plan §4.2).

    Returns ``{conversation, root, replies, count, has_more}``. The ``root``
    field is **always populated** with the thread root message dict regardless
    of ``since`` — incremental fetches must never lose context (plan §4.2,
    v2 phoenix review #3). The ``replies`` list is the visibility-filtered,
    ``since``-filtered, count-clamped slice of messages whose ``reply_to``
    chain resolves to ``root_id``.

    Validation:
    - ``root_id`` must reference a message in the conversation.
    - The root itself must be visible to ``key``; otherwise the thread is
      treated as not-found (a whisper-root is private to its recipients).

    Side effect: advances the per-thread read cursor (registry-side change,
    plan §4.2 cursor model — phoenix review v3) so subsequent
    ``comms_check`` calls reflect the new ``thread_unread`` for this root.
    """
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")
    if not root_id or not isinstance(root_id, str):
        return _error("Parameter 'root_id' is required.")

    count = max(1, min(count, 200))

    root = store.find_by_id(conversation, root_id)
    if root is None:
        return _error(f"Root message {root_id!r} not found in {conversation!r}.")
    # Visibility check: a whisper-root is invisible to non-recipients, so the
    # whole thread is private. Match the contract of comms_read's _is_visible.
    if not _is_visible(root, key):
        return _error(f"Root message {root_id!r} not found in {conversation!r}.")

    # Collect replies. Threads are depth-2 by validation, so a reply has
    # `reply_to == root_id` directly; no transitive chain traversal needed.
    all_msgs = store.get(conversation)
    replies = [
        m for m in all_msgs if m.get("reply_to") == root_id and _is_visible(m, key)
    ]

    if since:
        replies = [m for m in replies if _ts_after(m.get("ts", ""), since)]

    selected = replies[-count:] if len(replies) > count else replies
    has_more = len(replies) > len(selected)

    # Token-aware truncation, mirrors tool_comms_read.
    formatted: list[dict[str, Any]] = []
    total_chars = len(str(root))  # Account for root in the budget.
    for msg in reversed(selected):
        msg_chars = len(str(msg))
        if total_chars + msg_chars > MAX_OUTPUT_CHARS and formatted:
            has_more = True
            break
        formatted.append(msg)
        total_chars += msg_chars
    formatted.reverse()

    # Advance per-thread cursor to the latest reply's ts. Cursor scope is
    # (key, conversation, root_id) — a separate keyspace from the per-conv
    # cursor used by tool_comms_read / tool_comms_check.
    if formatted:
        latest_ts = formatted[-1].get("ts", "")
        if latest_ts:
            registry.update_thread_cursor(key, conversation, root_id, latest_ts)

    return {
        "conversation": conversation,
        "root": root,
        "replies": formatted,
        "count": len(formatted),
        "has_more": has_more,
    }


def tool_comms_check(
    registry: ParticipantRegistry,
    store: MessageStore,
    *,
    key: str,
    conversation: str | None = None,
    mark_seen: bool = False,
) -> dict[str, Any]:
    """Check for unread messages.

    Visibility-filter discipline (R2-M1 defect-fix): ``total_unread`` only
    counts messages visible to *key*'s viewer, matching ``comms_read``'s
    actual visibility model. Whispers addressed to other participants no
    longer inflate the count.

    ``mark_seen`` (Q4 9.G.2): when ``True``, after computing the response
    the registry cursor for each scanned conversation is advanced to the
    latest VISIBLE-to-viewer message's ``ts``. The response carries the
    PRE-advance ``total_unread`` count so the caller sees what they
    acknowledged. Default ``False`` preserves the peek-only contract.

    ``thread_unread`` (plan §4.2 + v3 phoenix cursor note): each per-conv
    summary entry includes a ``thread_unread: {root_id: count}`` map of
    visible thread replies whose ``ts`` is after the viewer's per-thread
    cursor (``registry.get_thread_cursor``). When ``mark_seen=True``, both
    the per-conv cursor AND every per-thread cursor advance in one shot —
    same single-shot acknowledge contract.

    Concrete order: filter visible → compute counts (top-level + per-thread)
    → build response → advance cursors (per-conv + per-thread) → return.
    """
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if conversation:
        convs = [conversation]
    else:
        convs = registry.conversations_for(key)

    unread_summary: list[dict[str, Any]] = []
    total_unread = 0
    # Track per-conv latest visible ts for the optional cursor advance below.
    # Stored separately from the response so we advance AFTER the response is
    # built (per §11 Phase A R4-mi2 ordering rule).
    latest_visible_ts: dict[str, str] = {}
    # Per-conv map of {root_id -> latest_reply_ts} for the optional per-thread
    # cursor advance under mark_seen. Same ordering rule as latest_visible_ts.
    thread_advance: dict[str, dict[str, str]] = {}

    for conv_id in convs:
        cursor = registry.get_cursor(key, conv_id)
        msgs = store.get(conv_id)
        # Apply _is_visible filter so total_unread reflects only messages the
        # viewer can actually see (R2-M1 defect-fix).
        visible_msgs = [m for m in msgs if _is_visible(m, key)]
        if cursor:
            unread = [m for m in visible_msgs if _ts_after(m.get("ts", ""), cursor)]
        else:
            unread = visible_msgs

        # Per-thread unread: walk visible messages once, gather replies per
        # root (key by reply_to), drop those whose ts is before the per-thread
        # cursor for that root.
        thread_unread: dict[str, int] = {}
        thread_latest_ts: dict[str, str] = {}
        for m in visible_msgs:
            root_id = m.get("reply_to")
            if root_id is None:
                continue
            t_cursor = registry.get_thread_cursor(key, conv_id, root_id)
            ts = m.get("ts", "")
            if t_cursor and not _ts_after(ts, t_cursor):
                continue
            thread_unread[root_id] = thread_unread.get(root_id, 0) + 1
            # Track latest reply per root for mark_seen advance.
            if root_id not in thread_latest_ts or _ts_after(
                ts, thread_latest_ts[root_id]
            ):
                thread_latest_ts[root_id] = ts

        if thread_latest_ts:
            thread_advance[conv_id] = thread_latest_ts

        if unread or thread_unread:
            entry: dict[str, Any] = {
                "conversation": conv_id,
                "unread_count": len(unread),
                "latest": unread[-1] if unread else None,
            }
            if thread_unread:
                entry["thread_unread"] = thread_unread
            if unread:
                total_unread += len(unread)
            unread_summary.append(entry)
        # Capture the latest-visible ts whether or not the conv has unread,
        # so mark_seen still no-ops cleanly when there's nothing to advance to.
        if visible_msgs:
            ts = visible_msgs[-1].get("ts", "")
            if ts:
                latest_visible_ts[conv_id] = ts

    response = {
        "total_unread": total_unread,
        "conversations": unread_summary,
    }

    # Advance cursor as a side-effect AFTER the response is built. The
    # response thus reports the PRE-advance count — caller sees what they
    # acknowledged. Cursor advances to the latest VISIBLE-to-viewer message,
    # intentionally ahead of comms_read's per-page advance: caller chose
    # acknowledge-without-read, so we skip past everything visible in one
    # shot. Per-thread cursors advance in lockstep (plan §4.2).
    if mark_seen:
        for conv_id, ts in latest_visible_ts.items():
            registry.update_cursor(key, conv_id, ts)
        for conv_id, root_to_ts in thread_advance.items():
            registry.advance_thread_cursors_to(key, conv_id, root_to_ts)

    return response


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


# ---------------------------------------------------------------------------
# Activity / status (Phase B+C: ephemeral presence signal)
# ---------------------------------------------------------------------------

# Activity TTL constants
DEFAULT_ACTIVITY_TTL_SECONDS = 30
MAX_ACTIVITY_TTL_SECONDS = 300  # 5 min hard cap

# Throttle: max one activity update per N seconds per participant.  Burst above
# is silently dropped (last write wins).  Spec is "per connection" but the MCP
# tool layer writes across all of a participant's connections, so we throttle
# at the participant level.
ACTIVITY_THROTTLE_SECONDS = 2.0
_activity_last_write: dict[str, float] = {}
_activity_throttle_lock = threading.Lock()


def _activity_throttled(key: str) -> bool:
    """Return True if *key* has written an activity update within the throttle window.

    Updates the last-write timestamp on the False path so the next call enforces
    the throttle.  Thread-safe via a small dedicated lock.
    """
    now = time.monotonic()
    with _activity_throttle_lock:
        last = _activity_last_write.get(key, 0.0)
        if now - last < ACTIVITY_THROTTLE_SECONDS:
            return True
        _activity_last_write[key] = now
        return False


def _compute_expires_at(ttl_seconds: int) -> str:
    """Return an ISO 8601 timestamp ttl_seconds in the future."""
    from datetime import datetime, timedelta, timezone

    return (
        datetime.now(timezone.utc).astimezone() + timedelta(seconds=ttl_seconds)
    ).isoformat()


def activity_topic(conversation: str) -> str:
    """MQTT topic where activity change events are published for a conversation."""
    return f"claude-comms/conv/{conversation}/activity"


async def tool_comms_status_set(
    registry: ParticipantRegistry,
    *,
    key: str,
    conversation: str,
    label: str,
    ttl_seconds: int = DEFAULT_ACTIVITY_TTL_SECONDS,
    publish_fn: PublishFn | None = None,
) -> dict[str, Any]:
    """Set an ephemeral activity signal on the caller's connections.

    The activity describes what the participant is doing right now (e.g.
    "thinking", "reading", "drafting", or for Claude clients the reserved
    labels "typing" / "working").  It is NOT persisted in the message log; it
    lives on the presence record and decays on its own clock.

    Visibility: status is always per-conversation broadcast.  We write the
    activity onto every active ConnectionInfo for the participant.  TTL is
    clamped to the server-enforced range [1, MAX_ACTIVITY_TTL_SECONDS].

    Throttle: at most one update per ACTIVITY_THROTTLE_SECONDS per participant.
    Bursts above the throttle silently last-write-wins.
    """
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    p = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    if conversation not in registry.conversations_for(key):
        return _error(
            f"Not a member of conversation {conversation!r}. Call comms_join first."
        )

    label = (label or "").strip()
    if not label:
        return _error("label must be a non-empty string.")
    if len(label) > 32:
        return _error("label must be <= 32 characters.")

    # Clamp TTL into [1, MAX]
    if ttl_seconds < 1:
        ttl_seconds = 1
    if ttl_seconds > MAX_ACTIVITY_TTL_SECONDS:
        ttl_seconds = MAX_ACTIVITY_TTL_SECONDS

    if _activity_throttled(key):
        return {
            "status": "throttled",
            "key": key,
            "label": label,
            "throttle_seconds": ACTIVITY_THROTTLE_SECONDS,
        }

    set_at = now_iso()
    expires_at = _compute_expires_at(ttl_seconds)
    activity = Activity(label=label, set_at=set_at, expires_at=expires_at)

    # Apply to every active connection.  ConnectionInfo is non-frozen, so
    # direct mutation is safe and matches the convention used by presence.touch().
    for conn in p.connections.values():
        conn.activity = activity

    # Broadcast the activity change so subscribers (web UI, TUI) can render
    # without polling /api/participants.  retain=False — activity is event-shaped,
    # last-write-wins state lives on the registry.  Failures are swallowed so
    # the tool keeps working even if the broker hiccups.
    if publish_fn is not None:
        payload = {
            "key": key,
            "name": p.name,
            "type": p.type,
            "conversation": conversation,
            "op": "set",
            "activity": {
                "label": label,
                "set_at": set_at,
                "expires_at": expires_at,
            },
        }
        try:
            await publish_fn(activity_topic(conversation), json.dumps(payload).encode())
        except Exception:
            logger.exception(
                "Failed to publish activity_set event for key %s in %s",
                key,
                conversation,
            )

    return {
        "status": "set",
        "key": key,
        "label": label,
        "set_at": set_at,
        "expires_at": expires_at,
        "ttl_seconds": ttl_seconds,
        "applied_to_connections": list(p.connections.keys()),
    }


async def tool_comms_status_clear(
    registry: ParticipantRegistry,
    *,
    key: str,
    conversation: str,
    publish_fn: PublishFn | None = None,
) -> dict[str, Any]:
    """Clear any active activity signal on the caller's connections.

    Idempotent: returns ``{status: "cleared", count: N}`` where N is the number
    of connections that actually had an activity to clear (zero is fine).
    """
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    p = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    if conversation not in registry.conversations_for(key):
        return _error(
            f"Not a member of conversation {conversation!r}. Call comms_join first."
        )

    cleared = 0
    for conn in p.connections.values():
        if conn.activity is not None:
            conn.activity = None
            cleared += 1

    # Broadcast a clear event regardless of whether anything changed locally,
    # so subscribers can drop a stale ghost-row even if their cached view
    # disagrees with the server.
    if publish_fn is not None:
        payload = {
            "key": key,
            "name": p.name,
            "type": p.type,
            "conversation": conversation,
            "op": "clear",
            "activity": None,
        }
        try:
            await publish_fn(activity_topic(conversation), json.dumps(payload).encode())
        except Exception:
            logger.exception(
                "Failed to publish activity_clear event for key %s in %s",
                key,
                conversation,
            )

    return {"status": "cleared", "key": key, "count": cleared}


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
            unread_count = sum(1 for m in msgs if _ts_after(m.get("ts", ""), cursor))
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
        return _error(f"Artifact {name!r} not found in conversation {conversation!r}.")

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
        return _error(f"Artifact {name!r} not found in conversation {conversation!r}.")

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
        return _error(f"Artifact {name!r} not found in conversation {conversation!r}.")
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
    registry.join(
        participant.name, conversation, key=key, participant_type=participant.type
    )

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


# ---------------------------------------------------------------------------
# Reactions tools (Phase A — claude-phoenix)
# ---------------------------------------------------------------------------


# Per-actor rate limiter for reaction events. Resolution-key is (actor_key, conv).
# Limits enforced: max REACTIONS_PER_ACTOR_PER_MINUTE events per actor per minute
# per conversation. Bursts above are returned as throttled errors.
REACTIONS_PER_ACTOR_PER_MINUTE: int = 30
MAX_REACTIONS_PER_MESSAGE_PER_ACTOR: int = 10
_reaction_rate_lock = threading.Lock()
_reaction_event_log: dict[tuple[str, str], list[float]] = {}


def _reaction_rate_check(actor_key: str, conv: str) -> bool:
    """Return True if the (actor, conv) pair is under the per-minute limit.

    Side effect: records the current event timestamp on success.
    """
    now = time.monotonic()
    cutoff = now - 60.0
    bucket = (actor_key, conv)
    with _reaction_rate_lock:
        events = _reaction_event_log.setdefault(bucket, [])
        # Drop events older than 60s
        while events and events[0] < cutoff:
            events.pop(0)
        if len(events) >= REACTIONS_PER_ACTOR_PER_MINUTE:
            return False
        events.append(now)
        return True


class ReactionsStoreFactory(Protocol):
    """Resolve (or lazily create) the :class:`ReactionsStore` for a conversation."""

    def __call__(self, conversation: str) -> ReactionsStore: ...


async def tool_comms_react(
    registry: ParticipantRegistry,
    publish_fn: PublishFn,
    get_reactions_store: ReactionsStoreFactory,
    *,
    key: str,
    conversation: str,
    message_id: str,
    emoji: str,
    op: str = "toggle",
) -> dict[str, Any]:
    """Add, remove, or toggle a reaction on a message.

    The server resolves ``op="toggle"`` to a terminal ``add`` or ``remove``
    based on the current state, persists the event to the per-conversation
    JSONL log, and publishes the resulting :class:`ReactionEvent` to the
    reactions topic. No-ops (e.g. add when already present) return
    ``{"status": "no_op"}`` without publishing.
    """
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    actor: Participant = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    if conversation not in registry.conversations_for(key):
        return _error(
            f"Not a member of conversation {conversation!r}. Call comms_join first."
        )

    if op not in ("add", "remove", "toggle"):
        return _error(f"op must be 'add', 'remove', or 'toggle' (got {op!r}).")

    if not message_id or not isinstance(message_id, str):
        return _error("message_id must be a non-empty string.")

    if not emoji or not isinstance(emoji, str) or not emoji.strip():
        return _error("emoji must be a non-empty string.")

    if not _reaction_rate_check(actor.key, conversation):
        return {
            "status": "throttled",
            "limit_per_minute": REACTIONS_PER_ACTOR_PER_MINUTE,
        }

    store = get_reactions_store(conversation)

    # Per-message-per-actor cap: count distinct emojis the actor currently has
    # on this message. Only enforced for add/toggle->add transitions.
    if op in ("add", "toggle"):
        current = store.get(message_id)
        actor_emojis_here = sum(1 for actors in current.values() if actor.key in actors)
        # If this is a toggle that will turn into a remove, we don't cap.
        # Determine that without mutating state.
        will_be_add = True
        if op == "toggle":
            will_be_add = not store.has(message_id, emoji.strip(), actor.key)
        if will_be_add and actor_emojis_here >= MAX_REACTIONS_PER_MESSAGE_PER_ACTOR:
            return _error(
                f"Reaction limit reached for this message "
                f"(max {MAX_REACTIONS_PER_MESSAGE_PER_ACTOR} per actor per message)."
            )

    try:
        event: ReactionEvent | None = store.apply(
            message_id=message_id,
            emoji=emoji,
            actor_key=actor.key,
            op=op,  # type: ignore[arg-type]
        )
    except ValueError as exc:
        return _error(str(exc))
    except OSError as exc:
        logger.exception("Failed to persist reaction event")
        return _error(f"Failed to persist reaction: {exc}.")

    if event is None:
        # No state change (e.g. add when already present, or remove when absent).
        return {
            "status": "no_op",
            "message_id": message_id,
            "emoji": emoji.strip(),
        }

    # Publish to the reactions topic. retain=false is the default for
    # publish_fn callers (set by aiomqtt at the broker level).
    try:
        await publish_fn(
            reactions_topic(conversation),
            event.model_dump_json().encode("utf-8"),
        )
    except Exception as exc:
        logger.exception("Failed to publish reaction event over MQTT")
        # State is already persisted on disk, but clients won't see the
        # event live. Return a partial-success status so the caller can
        # distinguish persistence-only from full success.
        return {
            "status": "persisted_publish_failed",
            "id": event.message_id,
            "emoji": event.emoji,
            "op": event.op,
            "actor_key": event.actor_key,
            "ts": event.ts,
            "error": str(exc),
        }

    return {
        "status": "applied",
        "message_id": event.message_id,
        "emoji": event.emoji,
        "op": event.op,
        "actor_key": event.actor_key,
        "ts": event.ts,
    }


def tool_comms_reactions_get(
    registry: ParticipantRegistry,
    get_reactions_store: ReactionsStoreFactory,
    *,
    key: str,
    conversation: str,
    message_id: str,
) -> dict[str, Any]:
    """List current reactions for *message_id* in *conversation*.

    Returns ``{"reactions": {emoji: [actor_key, ...]}, ...}``. The map is
    empty when the message has never received a reaction.
    """
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    if conversation not in registry.conversations_for(key):
        return _error(
            f"Not a member of conversation {conversation!r}. Call comms_join first."
        )

    if not message_id or not isinstance(message_id, str):
        return _error("message_id must be a non-empty string.")

    store = get_reactions_store(conversation)
    return {
        "conversation": conversation,
        "message_id": message_id,
        "reactions": store.get(message_id),
    }


# ---------------------------------------------------------------------------
# v0.4.0 step 2.2 — conversation soft-delete
# ---------------------------------------------------------------------------


async def tool_comms_conversation_delete(
    registry: ParticipantRegistry,
    store: MessageStore,
    publish_fn: PublishFn,
    *,
    key: str,
    conversation: str,
    confirm: bool = False,
    conv_data_dir: Path,
) -> dict[str, Any]:
    """Soft-delete a conversation (v0.4.0 step 2.2).

    Two-phase contract:

    - ``confirm=False`` (the default) returns the structured pre-flight
      payload ``{"error": "confirm_required", "message_count": <int>,
      "member_count": <int>}`` so the web client can render a type-name
      confirmation modal per Design Spec §4.5 before the user double-
      commits.  No state changes and no MQTT publishes happen on this
      branch.

    - ``confirm=True`` runs the full 5-step soft-delete:

      1. Publish a final RETAINED ``{"type": "deleted", "conversationId":
         ..., "deletedBy": ..., "timestamp": ...}`` system message on
         ``claude-comms/conv/{id}/messages`` so live subscribers can
         render an orphan banner the moment the conversation goes away.
      2. Publish a ``{"type": "conversation_deleted", "name": ...,
         "deleted_by": ..., "ts": ...}`` event on the global
         ``claude-comms/system/conversations`` topic so sidebars purge
         the row without a page reload.  Wire-format matches the v0.3.2
         ``publish_conversation_event`` helper's ``type`` discriminator
         contract, with ``deleted_by`` as the v0.4.0 extension field.
      3. Persist the soft-delete on the conversation's ``meta.json``
         (``deleted_at`` + ``deleted_by`` via :meth:`ConversationMeta.
         mark_deleted`).  History on disk is preserved -- only a future
         purge job hard-deletes it.
      4. Eject every member at the protocol level: publish a
         retained-clear (empty payload, ``retain=True``) on
         ``claude-comms/conv/{id}/presence/{key}`` for each member key
         currently registered against the conversation.  Without this,
         late subscribers would still see the deleted conversation's
         retained presence rows on next connect.
      5. Return ``{"deleted": True, "conversation_id": ...}``.

    Authorization (v0.4.0): **creator-only**.  The caller's resolved
    ``Participant.name`` must match ``ConversationMeta.created_by``.  A
    v0.4.1 admin pass will broaden this to "creator OR any active human
    member" -- see plans/v0.4.0-release.md §I.6 future work.

    Idempotence: re-calling on an already-deleted conversation returns a
    plain ``not_found`` error because the meta read short-circuits.  The
    web client treats ``not_found`` the same as a successful delete from
    its sidebar's perspective, so the user-visible behavior is
    idempotent even though the protocol response is not.
    """
    # --- Validation -------------------------------------------------------
    result = _validate_key_registered(registry, key)
    if isinstance(result, dict):
        return result
    participant: Participant = result

    if not validate_conv_id(conversation):
        return _error(f"Invalid conversation ID {conversation!r}.")

    if conversation in RESERVED_CONVERSATION_NAMES:
        return _error(
            f"Conversation {conversation!r} is reserved and cannot be deleted."
        )

    meta = load_meta(conversation, conv_data_dir)
    if meta is None:
        return _error(f"Conversation {conversation!r} not found.")

    if meta.is_deleted:
        # Already soft-deleted -- treat as a no-op so a flaky network /
        # retried call doesn't republish the lifecycle events and double-
        # post the orphan banner in connected clients.
        return _error(
            f"Conversation {conversation!r} is already deleted "
            f"(at {meta.deleted_at} by {meta.deleted_by!r})."
        )

    # --- Authorization: creator-only for v0.4.0 ---------------------------
    if participant.name != meta.created_by:
        return _error(
            f"Only the creator ({meta.created_by!r}) may delete conversation "
            f"{conversation!r}."
        )

    # --- confirm=False pre-flight ----------------------------------------
    members = registry.members(conversation)
    message_count = len(store.get(conversation))
    if not confirm:
        return {
            "error": "confirm_required",
            "message_count": message_count,
            "member_count": len(members),
        }

    # --- confirm=True: 5-step soft-delete --------------------------------
    ts = now_iso()

    # Step 1: final retained orphan-banner system message on the per-conv
    # messages topic.  Wire-format intentionally distinct from the regular
    # ``Message`` shape so subscribers can branch on ``type == "deleted"``
    # without false-matching real chat content.
    orphan_payload = {
        "type": "deleted",
        "conversationId": conversation,
        "deletedBy": participant.name,
        "timestamp": ts,
    }
    messages_topic = f"claude-comms/conv/{conversation}/messages"
    await publish_fn(messages_topic, json.dumps(orphan_payload).encode(), retain=True)

    # Step 2: global lifecycle event on ``system/conversations``.  Reuses
    # the v0.3.2 ``publish_conversation_event`` wire-format (type
    # discriminator + ``name`` + ``ts``) so existing sidebar subscribers
    # work unchanged; ``deleted_by`` is the v0.4.0 extension field.
    lifecycle_payload = {
        "type": "conversation_deleted",
        "name": conversation,
        "deleted_by": participant.name,
        "ts": ts,
    }
    await publish_fn(
        "claude-comms/system/conversations",
        json.dumps(lifecycle_payload).encode(),
    )

    # Step 3: persist the soft-delete to disk.  ``mark_deleted`` stamps
    # ``deleted_at`` + ``deleted_by`` in memory; ``save_meta`` does the
    # atomic write-and-rename so a crash mid-flush can't leave a torn
    # meta.json.
    meta.mark_deleted(participant.name)
    save_meta(meta, conv_data_dir)

    # Step 4: retained-clear every member's presence row on the
    # per-conversation presence topic.  Empty payload + retain=True is the
    # MQTT idiom for "drop the retained message", per MQTT 5 spec §3.3.1.
    # We use the registry's pre-deletion member snapshot so the eject
    # publishes go out even though we're about to drop memberships.
    for member in members:
        presence_topic = f"claude-comms/conv/{conversation}/presence/{member.key}"
        await publish_fn(presence_topic, b"", retain=True)

    # Drop memberships in the registry so future ``conversations_for()``
    # reads don't keep the deleted conversation in sidebars built from the
    # registry instead of meta.json.  Best-effort: if a member was removed
    # concurrently the ``leave`` call is a no-op.
    for member in members:
        registry.leave(member.key, conversation)

    return {"deleted": True, "conversation_id": conversation}
