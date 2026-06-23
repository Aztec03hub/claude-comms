"""MCP HTTP server for claude-comms.

Provides the ``comms_*`` tool suite via the ``mcp`` Python SDK's
``FastMCP`` with Streamable HTTP transport (``stateless_http=True``).

On startup the server:
1. Loads config from ``~/.claude-comms/config.yaml``
2. Replays JSONL logs into an in-memory ``MessageStore``
3. Connects to the MQTT broker as a subscriber (via aiomqtt)
4. Registers all ``comms_*`` tools

The server MUST bind to ``127.0.0.1`` only (localhost is the security
boundary -- there is no auth layer).

Never ``print()`` to stdout -- it corrupts JSON-RPC framing even in HTTP
mode.  Use ``logging`` exclusively.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from claude_comms.artifact import migrate_artifact_names_to_nfc
from claude_comms.broker import MessageDeduplicator, MessageStore, replay_jsonl_logs
from claude_comms.config import load_config
from claude_comms.participant import CONNECTION_TYPES, ConnectionInfo
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    PublishFn,
    tool_comms_artifact_create,
    tool_comms_artifact_update,
    tool_comms_artifact_get,
    tool_comms_artifact_list,
    tool_comms_artifact_delete,
    tool_comms_check,
    tool_comms_conversation_archive,
    tool_comms_conversation_create,
    tool_comms_conversation_delete,
    tool_comms_conversation_unarchive,
    tool_comms_conversation_update,
    tool_comms_conversations,
    tool_comms_dm_open,
    tool_comms_get_channel_role,
    tool_comms_history,
    tool_comms_invite,
    tool_comms_join,
    tool_comms_kick,
    tool_comms_leave,
    tool_comms_members,
    tool_comms_react,
    tool_comms_reactions_get,
    tool_comms_read,
    tool_comms_send,
    tool_comms_thread_read,
    tool_comms_profile_status_clear,
    tool_comms_profile_status_set,
    tool_comms_status_clear,
    tool_comms_status_set,
    tool_comms_update_name,
)
from claude_comms.reactions import ReactionsStore
from claude_comms.registry_store import RegistryStore
from claude_comms.conversation import (
    LastActivityTracker,
    backfill_missing_metadata,
    ensure_general_exists,
    list_all_conversations,
)
from claude_comms.mcp_summaries import (
    summarize_artifact_create,
    summarize_artifact_delete,
    summarize_artifact_get,
    summarize_artifact_list,
    summarize_artifact_update,
    summarize_check,
    summarize_conversation_archive,
    summarize_conversation_create,
    summarize_conversation_delete,
    summarize_conversation_unarchive,
    summarize_conversation_update,
    summarize_conversations,
    summarize_dm_open,
    summarize_get_channel_role,
    summarize_history,
    summarize_invite,
    summarize_join,
    summarize_kick,
    summarize_leave,
    summarize_members,
    summarize_profile_status_clear,
    summarize_profile_status_set,
    summarize_react,
    summarize_reactions_get,
    summarize_read,
    summarize_send,
    summarize_status_clear,
    summarize_status_set,
    summarize_thread_read,
    summarize_update_name,
)
from claude_comms.presence import PresenceManager
from claude_comms.notifier import NotificationWriter

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared state  (module-level singletons, initialised in ``create_server``)
# ---------------------------------------------------------------------------

_registry: ParticipantRegistry | None = None
_registry_store: RegistryStore | None = None
_store: MessageStore | None = None
_deduplicator: MessageDeduplicator | None = None
_publish_fn: PublishFn | None = None
_config: dict[str, Any] | None = None
_data_dir: Path | None = None
_conv_data_dir: Path | None = None
_activity_tracker: LastActivityTracker | None = None
_presence: PresenceManager | None = None
_topic_rate_limit: dict[
    str, float
] = {}  # conversation -> last system msg monotonic time
# Per-conversation reactions stores, lazily constructed on first access.
_reactions_stores: dict[str, ReactionsStore] = {}
_reactions_stores_lock = threading.Lock()


def _get_registry() -> ParticipantRegistry:
    """Return the shared participant registry, raising if uninitialised."""
    if _registry is None:
        raise RuntimeError(
            "MCP server not initialised. Call create_server() before using tools."
        )
    return _registry


def _get_store() -> MessageStore:
    """Return the shared message store, raising if uninitialised."""
    if _store is None:
        raise RuntimeError(
            "MCP server not initialised. Call create_server() before using tools."
        )
    return _store


def _get_registry_store() -> RegistryStore:
    """Return the shared RegistryStore, raising if uninitialised.

    v0.4.2 Step 3.6b: needed by ``comms_get_channel_role`` and by the
    extended ``comms_conversation_update`` transferOwnership path (which
    updates the conversation_roles table atomically with the meta.json
    write).
    """
    if _registry_store is None:
        raise RuntimeError(
            "MCP server not initialised. Call create_server() before using tools."
        )
    return _registry_store


def _get_data_dir() -> Path:
    if _data_dir is None:
        raise RuntimeError("MCP server not initialised.")
    return _data_dir


def _get_conv_data_dir() -> Path:
    if _conv_data_dir is None:
        raise RuntimeError("MCP server not initialised.")
    return _conv_data_dir


def _get_reactions_store(conversation: str) -> ReactionsStore:
    """Return (or lazily create) the :class:`ReactionsStore` for *conversation*.

    Stores live alongside ``meta.json`` under ``{conv_data_dir}/{conversation}/``.
    """
    with _reactions_stores_lock:
        store = _reactions_stores.get(conversation)
        if store is not None:
            return store
        conv_dir = _get_conv_data_dir() / conversation
        store = ReactionsStore(conv_dir)
        _reactions_stores[conversation] = store
        return store


def _touch(key: str | None) -> None:
    """Best-effort refresh of a participant's presence on tool activity.

    Uses :meth:`PresenceManager.ensure_connection` so that an MCP client
    whose connection record was already swept by the TTL sweep gets its
    record recreated on the very next tool call.  Without this, a
    participant could remain registered but show as offline indefinitely
    despite continuous tool activity (the per-tool-call refresh would only
    update existing connections, not resurrect expired ones).
    """
    if not key or _presence is None:
        return
    try:
        _presence.ensure_connection(key, client="mcp")
    except Exception:
        logger.exception("Presence ensure_connection failed for key %s", key)


def _concise(result: dict[str, Any], summary: str) -> CallToolResult:
    """Wrap *result* in a text-only ``CallToolResult`` for concise display.

    The returned tool result carries a single ``TextContent`` block whose text
    is ``<summary>\\n(ctrl+o for full)\\n---\\n<full JSON>`` and NO
    ``structuredContent``. Claude Code collapses the transcript to the leading
    summary lines (one ``ctrl+o`` keypress expands to the full JSON), while the
    model still receives the entire block, so it loses nothing (senders, bodies,
    ``directed_at_me``, mentions, thread metadata, ``has_more``, etc.).

    Omitting ``structuredContent`` is deliberate: when a FastMCP tool returns a
    bare dict, Claude Code renders that JSON blob verbatim (issue #9962). A
    text-only ``CallToolResult`` makes the prose summary the thing CC displays.
    Verified against mcp SDK 1.26.0: FastMCP's ``convert_result`` and the
    lowlevel call handler both pass a returned ``CallToolResult`` through
    untouched, leaving ``structuredContent`` as ``None``.
    """
    full_json = json.dumps(result, indent=2, ensure_ascii=False)
    text = f"{summary}\n(ctrl+o for full)\n---\n{full_json}"
    return CallToolResult(content=[TextContent(type="text", text=text)])


def get_channel_messages(channel: str, count: int = 50) -> list[dict]:
    """Return recent messages for *channel* from the shared store.

    This is the backing function for the ``/api/messages/{channel}`` REST
    endpoint added in ``cli.py``.  Returns an empty list when the store
    has not been initialised yet (daemon still starting).
    """
    if _store is None:
        return []
    return _store.get(channel, limit=count)


def get_channel_participants(channel: str) -> list[dict]:
    """Return participants for *channel* from the shared registry.

    This is the backing function for the ``/api/participants/{channel}``
    REST endpoint added in ``cli.py``.  Returns an empty list when the
    registry has not been initialised yet (daemon still starting).
    """
    if _registry is None:
        return []
    members = _registry.members(channel)
    return [
        {
            "key": m.key,
            "name": m.name,
            "type": m.type,
            "connections": {k: v.model_dump() for k, v in m.connections.items()},
            "online": m.is_online,
            # Backward compat
            "client": m.client
            or (m.active_client_types[0] if m.active_client_types else "unknown"),
            "status": "online" if m.is_online else "offline",
            # v0.3.2: the full set of conversations this participant is a
            # member of, so the web UI can render "in #X +N more" inline
            # for participants who appear in the global member list but
            # are not joined to the currently-active channel.
            "conversations": sorted(_registry.conversations_for(m.key)),
        }
        for m in members
    ]


def get_conversation_artifacts(conversation: str) -> list[dict]:
    """Return artifact summaries for a conversation (backing REST endpoint)."""
    if _data_dir is None:
        return []
    from claude_comms.artifact import list_artifacts

    return list_artifacts(conversation, _data_dir)


async def publish_conversation_event(
    publish_fn: PublishFn,
    *,
    event_type: str,
    name: str,
    topic: str | None = None,
    creator_key: str | None = None,
) -> None:
    """Publish a conversation lifecycle event to ``claude-comms/system/conversations``.

    Bug B fix from the v0.3.1 follow-up brief: prior to v0.3.2, conversation
    create / update / delete were only discoverable via the REST
    ``/api/conversations`` snapshot at page-bootstrap time. A new
    conversation created by another participant did not appear in
    connected browsers' sidebars until the user reloaded the page.

    Single broadcast topic for all conversation-lifecycle deltas; the
    payload's ``type`` field discriminates. Topic is non-conv-scoped so a
    single subscription covers every event class.

    Wire format::

        {
          "type": "conversation_created" | "conversation_topic_changed"
                  | "conversation_deleted",
          "name": "<conv-id>",
          "topic": "<optional new topic>",          # present on create + topic_changed
          "creator_key": "<8-hex>",                 # present on create
          "ts": "<ISO8601>"
        }

    Best-effort: any exception is suppressed (the user-visible mutation
    already succeeded; the broadcast is just the live-update hint).
    """
    from claude_comms.message import now_iso

    payload = {
        "type": event_type,
        "name": name,
        "ts": now_iso(),
    }
    if topic is not None:
        payload["topic"] = topic
    if creator_key is not None:
        payload["creator_key"] = creator_key
    try:
        await publish_fn(
            "claude-comms/system/conversations",
            json.dumps(payload).encode(),
        )
    except Exception:
        # Non-critical -- REST still returns authoritative state on next page load.
        pass


async def _publish_archive_event(
    publish_fn: PublishFn,
    *,
    event_type: str,
    conversation_id: str,
    archived_by: str | None = None,
    evicted_keys: list[str] | None = None,
) -> None:
    """Publish an archive / unarchive event + retained-clear evicted presence.

    v0.4.0 Step 2.3. Wraps three best-effort fan-outs around a single helper
    so the MCP tool wrapper can call us once after the registry-side
    transition completes:

    1. Non-retained ``{"type": "archived" | "unarchived", "id": ...,
       "archivedBy": ..., "timestamp": ...}`` event published on
       ``claude-comms/system/conversations``. Mirrors the create / update /
       delete event family added in v0.3.2 (see ``publish_conversation_event``).
    2. For ``"archived"`` events only: retained-clear of each evicted
       member's per-conversation presence topic
       (``claude-comms/conv/{id}/presence/{key}``) so web / TUI clients
       see the conversation disappear from their member-list on the next
       broker round-trip without waiting for a full presence sweep.

    Best-effort throughout; the on-disk meta and registry transitions
    have already committed by the time we get here, and the next page
    reload's REST snapshot is authoritative anyway. We swallow per-publish
    exceptions individually so a single broker hiccup on one member's
    presence-clear doesn't abort the rest of the fan-out.
    """
    from claude_comms.message import now_iso

    ts = now_iso()
    payload: dict[str, Any] = {
        "type": event_type,
        "id": conversation_id,
        "timestamp": ts,
    }
    if archived_by is not None:
        payload["archivedBy"] = archived_by

    try:
        await publish_fn(
            "claude-comms/system/conversations",
            json.dumps(payload).encode(),
        )
    except Exception:
        logger.exception(
            "Failed to publish %s event for conversation %s",
            event_type,
            conversation_id,
        )

    # Retained-clear per-member presence on archive. Empty bytes payload
    # with retain=True is the canonical "drop the retained value" wire
    # contract (see PresenceManager._publish_offline).
    if event_type == "archived" and evicted_keys:
        for member_key in evicted_keys:
            topic = f"claude-comms/conv/{conversation_id}/presence/{member_key}"
            try:
                await publish_fn(topic, b"", retain=True)
            except Exception:
                logger.exception(
                    "Failed to retained-clear presence on archive for %s/%s",
                    conversation_id,
                    member_key,
                )


async def publish_mcp_presence_on_join(
    publish_fn: PublishFn,
    *,
    conversation: str,
    key: str,
    name: str,
    type_: str,
) -> None:
    """Publish retained MCP-client presence after a successful ``comms_join``.

    Bug 2 fix from the v0.3.0 follow-up brief: web / TUI clients connecting
    AFTER an MCP-side ``comms_join`` need to see the participant via the
    broker's retained-message store. Without ``retain=True``, only clients
    already subscribed when the live publish landed would learn about the
    join, and any later reconnect / page-reload ghosted the MCP worker
    until the 30-second REST poll caught up.

    Publishes to BOTH:

    - ``claude-comms/conv/{conversation}/presence/{key}`` -- the conv-scoped
      presence topic the web UI subscribes to as ``conv/+/presence/+``.
    - ``claude-comms/system/participants/{key}-mcp`` -- the legacy system-
      scoped topic kept for backwards-compat with older subscribers.

    Best-effort: any ``Exception`` is suppressed because presence is not a
    correctness gate for the join itself. Surface failures via the caller's
    logger if observability matters.
    """
    from claude_comms.message import now_iso

    ts = now_iso()
    payload = json.dumps(
        {
            "key": key,
            "name": name,
            "type": type_,
            "status": "online",
            "client": "mcp",
            "ts": ts,
        }
    ).encode()
    conv_topic = f"claude-comms/conv/{conversation}/presence/{key}"
    system_topic = f"claude-comms/system/participants/{key}-mcp"
    try:
        await publish_fn(conv_topic, payload, retain=True)
        await publish_fn(system_topic, payload, retain=True)
    except Exception:
        # Non-critical -- the in-memory registry + REST API still expose
        # the participant; retained presence is just the freshness hint.
        pass


def get_artifact(
    conversation: str, name: str, version: int | None = None
) -> dict | None:
    """Return artifact data for REST endpoint. Latest version content + version metadata."""
    if _data_dir is None:
        return None
    from claude_comms.artifact import load_artifact

    artifact = load_artifact(conversation, name, _data_dir)
    if artifact is None:
        return None

    # Select version
    if version is not None:
        selected = None
        for v in artifact.versions:
            if v.version == version:
                selected = v
                break
        if selected is None:
            return None
    else:
        selected = artifact.versions[-1] if artifact.versions else None

    if selected is None:
        return None

    # Version metadata list (no content)
    version_meta = [
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
        "version": selected.version,
        "content": selected.content,
        "versions": version_meta,
    }


def get_all_conversations(key: str | None = None) -> list[dict]:
    """Return all conversations with metadata for REST API."""
    if _conv_data_dir is None:
        return []
    metas = list_all_conversations(_conv_data_dir)
    result = []
    for meta in metas:
        entry: dict[str, Any] = {
            "name": meta.name,
            "topic": meta.topic,
            "last_activity": _activity_tracker.get(meta.name)
            if _activity_tracker
            else meta.last_activity,
            "created_by": meta.created_by,
            "created_at": meta.created_at,
        }
        if _registry:
            members = _registry.members(meta.name)
            entry["member_count"] = len(members)
            if key:
                convs = _registry.conversations_for(key)
                entry["joined"] = meta.name in convs
        if _store:
            entry["message_count"] = len(_store.get(meta.name))
        result.append(entry)
    return result


# ---------------------------------------------------------------------------
# v0.4.0 full ChannelRow serialization for /api/conversations
# ---------------------------------------------------------------------------
#
# Design Spec §13.4 ChannelRow contract:
#   { id, name, topic, member, memberCount, lastActivity,
#     mode, visibility, createdAt, createdBy,
#     myUnread, myStarred, myMuted }
#
# Backward-compat fields preserved alongside (snake_case "joined",
# "member_count", "last_activity", "created_at", "created_by",
# "message_count") so v0.3.x web clients keep working during rollout.


def _serialize_conversation_full(
    meta: Any,
    caller_key: str,
    *,
    registry: Any = None,
    store: Any = None,
    activity_tracker: Any = None,
) -> dict:
    """Serialize a :class:`ConversationMeta` into the v0.4.0 ChannelRow shape.

    *caller_key* is the calling identity's 8-hex key. When empty, ``member``
    is always ``False`` and unlisted channels MUST be filtered upstream
    (this helper does NOT filter — callers do).

    *registry*, *store*, *activity_tracker* default to the module-level
    globals when omitted (production path). They're parameterized so unit
    tests can inject fakes without monkey-patching module state.
    """
    reg = registry if registry is not None else _registry
    msg_store = store if store is not None else _store
    tracker = activity_tracker if activity_tracker is not None else _activity_tracker

    # --- caller membership + total member count ---
    is_member = False
    member_count = 0
    if reg is not None:
        members = reg.members(meta.name)
        member_count = len(members)
        if caller_key:
            convs = reg.conversations_for(caller_key)
            is_member = meta.name in convs

    # --- last activity: prefer in-memory tracker (live) over disk meta ---
    # Tracker holds the most recent message ts that hasn't been flushed
    # to meta.json yet. Fall back to meta.last_activity, then created_at.
    last_activity = None
    if tracker is not None:
        last_activity = tracker.get(meta.name)
    if not last_activity:
        last_activity = meta.last_activity
    if not last_activity:
        last_activity = meta.created_at

    # --- mode / visibility: ConversationMeta tracks these as of v0.4.2 Step
    # 3.6b (additive Pydantic fields with defaults). Read defensively via
    # getattr so any future ``meta`` shape that omits them still falls
    # back to the canonical defaults from the 3.6b spec
    # (visibility='public', mode='open'). These match ChannelAdminPanel's
    # actual emissions; the pre-3.6b placeholder values ('listed'/'public')
    # were stripped when the real fields landed. ---
    mode = getattr(meta, "mode", None) or "open"
    visibility = getattr(meta, "visibility", None) or "public"

    # --- per-conv message count for back-compat ---
    message_count = 0
    if msg_store is not None:
        message_count = len(msg_store.get(meta.name))

    return {
        # New ChannelRow fields (v0.4.0)
        "id": meta.name,
        "name": meta.name,
        "topic": meta.topic,
        "member": is_member,
        "memberCount": member_count,
        "lastActivity": last_activity,
        "mode": mode,
        "visibility": visibility,
        "createdAt": meta.created_at,
        "createdBy": meta.created_by,
        # Per-user personalization — populated for real in v0.4.1 when
        # per-user state lands. Always present so the web client never
        # encounters undefined.
        "myUnread": 0,
        "myStarred": False,
        "myMuted": False,
        # Backward-compat (v0.3.x) fields — keep until v0.5.x deprecation
        "joined": is_member,
        "member_count": member_count,
        "last_activity": last_activity,
        "created_at": meta.created_at,
        "created_by": meta.created_by,
        "message_count": message_count,
    }


def get_all_conversations_full(caller_key: str = "") -> list[dict]:
    """Return the daemon's full known conversation set, ChannelRow-shaped.

    v0.4.0 S-FIX backend: the web sidebar's "Available" section bootstraps
    from this list (the prior endpoint returned only the caller's
    memberships, which is why the sidebar fell back to a hardcoded seed
    list).

    Visibility rules (v0.4.2 Step 3.6b values):
      - Public channels (``visibility == "public"``) appear for everyone.
      - Private channels (``visibility == "private"``) appear only for
        callers who are members.

    *caller_key* is the calling identity's 8-hex key. When empty, all
    private channels are filtered out and every row's ``member`` is
    ``False``.
    """
    if _conv_data_dir is None:
        return []
    metas = list_all_conversations(_conv_data_dir)

    # Pre-compute caller's membership set once (avoids O(N) per-row lookups).
    caller_memberships: set[str] = set()
    if _registry is not None and caller_key:
        caller_memberships = set(_registry.conversations_for(caller_key))

    result: list[dict] = []
    for meta in metas:
        # v0.4.2 Step 3.6b: ConversationMeta now carries an explicit
        # visibility field defaulting to 'public'. Pre-3.6b meta files
        # without the field still round-trip through Pydantic with the
        # default applied. The 'private' literal mirrors the lock-in
        # pinned by Wave B (admin panel emits 'public'/'private').
        visibility = getattr(meta, "visibility", None) or "public"
        is_member = meta.name in caller_memberships
        # Private: only members see them. Public: everyone sees them.
        if visibility == "private" and not is_member:
            continue
        row = _serialize_conversation_full(meta, caller_key)
        result.append(row)
    return result


# ---------------------------------------------------------------------------
# MQTT subscriber background task
# ---------------------------------------------------------------------------


async def _mqtt_subscriber(
    host: str,
    port: int,
    store: MessageStore,
    deduplicator: MessageDeduplicator,
    log_exporter: Any = None,
    notifier: "NotificationWriter | None" = None,
) -> None:
    """Subscribe to all conversation messages and feed them into the store.

    Also writes each message to disk via *log_exporter* (if provided)
    so messages persist across daemon restarts, and appends per-recipient
    notification cues via *notifier* (if provided) so the PostToolUse hook
    can push mid-turn messages.

    Runs as a long-lived background task.  Reconnects on failure.
    """
    import aiomqtt

    from claude_comms.broker import generate_client_id

    client_id = generate_client_id("mcp", "00000000")
    msg_topic = "claude-comms/conv/+/messages"
    presence_topic = "claude-comms/conv/+/presence/+"
    system_topic = "claude-comms/system/participants/+"
    # New presence topic: claude-comms/presence/{key}/{client}-{instanceId}
    new_presence_topic = "claude-comms/presence/+/+"

    while True:
        try:
            async with aiomqtt.Client(
                hostname=host,
                port=port,
                identifier=client_id,
            ) as client:
                _ = await client.subscribe(msg_topic, qos=1)
                _ = await client.subscribe(presence_topic, qos=1)
                _ = await client.subscribe(system_topic, qos=1)
                _ = await client.subscribe(new_presence_topic, qos=1)
                logger.info("MCP subscriber connected to %s:%d", host, port)
                async for mqtt_msg in client.messages:
                    try:
                        payload = (
                            mqtt_msg.payload.decode("utf-8")
                            if isinstance(mqtt_msg.payload, bytes)  # pyright: ignore[reportUnnecessaryIsInstance]
                            else str(mqtt_msg.payload)
                        )
                        # Skip empty retained messages (used for cleanup)
                        if not payload.strip():
                            continue
                        data = json.loads(payload)
                        topic_str = str(mqtt_msg.topic)
                        parts = topic_str.split("/")

                        # Handle messages
                        # Topic: claude-comms/conv/{channel}/messages
                        # parts: ['claude-comms', 'conv', '{channel}', 'messages']
                        if len(parts) >= 4 and parts[3] == "messages":
                            msg_id = data.get("id", "")
                            conv_id = data.get("conv", "") or parts[2]
                            if not msg_id or not conv_id:
                                continue
                            if deduplicator.is_duplicate(msg_id):
                                continue
                            store.add(conv_id, data)
                            # Thread-metadata dispatcher: when this message is
                            # a reply, locate its root in the same conversation
                            # and update the root's thread fields in place.
                            # See plans/threaded-replies-plan §4.1.
                            reply_to = data.get("reply_to")
                            if reply_to:
                                root = store.find_by_id(conv_id, reply_to)
                                if root is not None:
                                    # Walk up at most one level — depth-2 rule
                                    # is enforced at send time, so the root's
                                    # own reply_to is normally None. Defensive
                                    # walk anyway, in case a malformed reply
                                    # slipped past validation (e.g. raw MQTT
                                    # publisher bypassing tool_comms_send).
                                    if root.get("reply_to"):
                                        true_root = store.find_by_id(
                                            conv_id, root["reply_to"]
                                        )
                                        if true_root is not None:
                                            root = true_root
                                    sender_block = data.get("sender") or {}
                                    add_keys: list[str] = []
                                    sender_key = sender_block.get("key")
                                    if sender_key:
                                        add_keys.append(sender_key)
                                    # In-thread @mentions auto-add to
                                    # thread_participants per §4.4.
                                    for mk in data.get("mentions") or []:
                                        if mk and mk not in add_keys:
                                            add_keys.append(mk)
                                    new_count = (
                                        root.get("thread_reply_count") or 0
                                    ) + 1
                                    _ = store.update_thread_metadata(
                                        conv_id,
                                        root["id"],
                                        reply_count=new_count,
                                        last_ts=data.get("ts", ""),
                                        last_author=sender_block.get("name") or None,
                                        add_participants=add_keys,
                                    )
                                    # Stamp thread_root_id on the reply dict so
                                    # downstream readers can identify thread
                                    # membership without re-walking the chain.
                                    data["thread_root_id"] = root["id"]
                            if _activity_tracker is not None:
                                _activity_tracker.update(conv_id, data.get("ts", ""))
                                _activity_tracker.flush_if_due(_get_conv_data_dir())
                            # Persist to disk for replay on restart
                            if log_exporter is not None:
                                try:
                                    log_exporter.write_message(data)
                                except Exception:
                                    logger.warning(
                                        "Failed to write message to log", exc_info=True
                                    )
                            # Append per-recipient notification cues so the
                            # PostToolUse hook can push mid-turn messages. Own
                            # block (NOT nested in the log_exporter guard) so it
                            # fires even when logging is disabled / None.
                            if notifier is not None:
                                try:
                                    _ = notifier.write(data)
                                except Exception:
                                    logger.warning(
                                        "Failed to write notification cue",
                                        exc_info=True,
                                    )
                            # Refresh presence for message sender (keeps
                            # CLI/raw-MQTT publishers alive without HTTP).
                            try:
                                sender = data.get("sender") or {}
                                _touch(sender.get("key"))
                            except Exception:
                                logger.exception("Presence touch for sender failed")

                        # Handle NEW presence topic
                        # Topic: claude-comms/presence/{key}/{client}-{instanceId}
                        # parts: ['claude-comms', 'presence', '{key}', '{client}-{instanceId}']
                        elif len(parts) == 4 and parts[1] == "presence":
                            key = data.get("key", "") or parts[2]
                            name = data.get("name", "")
                            status = data.get("status", "offline")
                            client_type = data.get("client", "")
                            instance_id = data.get("instanceId")
                            p_type = data.get("type", "claude")
                            ts = data.get("ts", "")

                            # Validate client type against allowed list
                            if not client_type or client_type not in CONNECTION_TYPES:
                                continue

                            # Build connection key from topic or payload
                            conn_key = parts[3]  # e.g. "web-3f2a"

                            if not key or not name:
                                continue

                            if status == "online" and _registry:
                                # Ensure participant exists in registry
                                _ = _registry.join(
                                    name, "general", key=key, participant_type=p_type
                                )
                                p = _registry.get(key)
                                if p:
                                    p.client = client_type
                                    p.connections[conn_key] = ConnectionInfo(
                                        client=client_type,
                                        instance_id=instance_id,
                                        since=p.connections[conn_key].since
                                        if conn_key in p.connections
                                        else (ts or ""),
                                        last_seen=ts or "",
                                    )
                                # Refresh presence — heartbeat from web/TUI
                                _touch(key)
                            elif status == "offline" and _registry:
                                p = _registry.get(key)
                                if p:
                                    _ = p.connections.pop(conn_key, None)
                                    # If no connections left, clear client field
                                    if not p.connections:
                                        p.client = None

                        # Handle OLD presence — auto-register participants
                        # Topic: claude-comms/conv/{channel}/presence/{key}
                        # parts: ['claude-comms', 'conv', '{channel}', 'presence', '{key}']
                        elif (len(parts) >= 5 and parts[3] == "presence") or (
                            len(parts) >= 3 and parts[1] == "participants"
                        ):
                            key = data.get("key", "")
                            name = data.get("name", "")
                            status = data.get("status", "offline")
                            client_type = data.get("client", "unknown")
                            instance_id = data.get("instanceId")
                            p_type = data.get("type", "claude")
                            ts = data.get("ts", "")
                            # Only register participants that declare a known client type.
                            # Skip 'unknown' to avoid stale retained presence from old sessions.
                            if (
                                key
                                and name
                                and status == "online"
                                and client_type != "unknown"
                                and _registry
                            ):
                                # Register in the MCP participant registry
                                conv = (
                                    parts[2]
                                    if len(parts) > 2 and parts[1] == "conv"
                                    else "general"
                                )
                                _ = _registry.join(
                                    name, conv, key=key, participant_type=p_type
                                )
                                # Store client type and connection info
                                p = _registry.get(key)
                                if p:
                                    p.client = client_type
                                    # Track connection if client type is valid
                                    if client_type in CONNECTION_TYPES:
                                        conn_key = (
                                            f"{client_type}-{instance_id}"
                                            if instance_id
                                            else client_type
                                        )
                                        p.connections[conn_key] = ConnectionInfo(
                                            client=client_type,
                                            instance_id=instance_id,
                                            since=p.connections[conn_key].since
                                            if conn_key in p.connections
                                            else (ts or ""),
                                            last_seen=ts or "",
                                        )
                                # Refresh presence — heartbeat from web/TUI
                                _touch(key)
                            elif key and status == "offline" and _registry:
                                existing = _registry.get(key)
                                if existing:
                                    # Remove specific connection if instanceId provided
                                    if client_type in CONNECTION_TYPES:
                                        conn_key = (
                                            f"{client_type}-{instance_id}"
                                            if instance_id
                                            else client_type
                                        )
                                        _ = existing.connections.pop(conn_key, None)
                                    if not existing.connections:
                                        _ = _registry.leave(key, "general")

                    except (json.JSONDecodeError, UnicodeDecodeError):
                        logger.warning("Malformed MQTT message, skipping")
        except asyncio.CancelledError:
            logger.info("MQTT subscriber cancelled")
            return
        except Exception:
            logger.exception("MQTT subscriber error, reconnecting in 2s")
            await asyncio.sleep(2)


# ---------------------------------------------------------------------------
# Server factory
# ---------------------------------------------------------------------------


def create_server(config: dict[str, Any] | None = None) -> FastMCP:
    """Create and configure the MCP server with all comms tools.

    Parameters
    ----------
    config:
        Parsed config dict.  If *None*, loads from the default path.

    Returns
    -------
    FastMCP
        The configured server instance (not yet running).
    """
    global \
        _registry, \
        _registry_store, \
        _store, \
        _deduplicator, \
        _publish_fn, \
        _config, \
        _data_dir, \
        _conv_data_dir, \
        _activity_tracker, \
        _presence

    if config is None:
        config = load_config()
    _config = config

    _data_dir = Path(
        config.get("artifacts", {}).get("data_dir", "~/.claude-comms/artifacts")
    ).expanduser()
    _data_dir.mkdir(parents=True, exist_ok=True)

    # R5-3 / R6-2: one-time NFC migration for pre-existing NFD artifact files
    # (e.g. from macOS HFS+ fresh installs). Quarantines collisions rather
    # than leaving split-brain NFD/NFC twins. Runs BEFORE the MQTT subscriber
    # starts and before any tools are registered.
    renamed, quarantined = migrate_artifact_names_to_nfc(_data_dir)
    if renamed or quarantined:
        logger.warning(
            "Artifact NFC migration complete: %d renamed, %d quarantined",
            renamed,
            quarantined,
        )

    _conv_data_dir = Path(
        config.get("conversations", {}).get("data_dir", "~/.claude-comms/conversations")
    ).expanduser()
    _conv_data_dir.mkdir(parents=True, exist_ok=True)
    _activity_tracker = LastActivityTracker()

    # Bootstrap "general" and backfill missing metadata
    _ = ensure_general_exists(_conv_data_dir)
    log_dir = Path(
        config.get("logging", {}).get("dir", "~/.claude-comms/logs")
    ).expanduser()
    _ = backfill_missing_metadata(_conv_data_dir, log_dir)

    mcp_cfg = config.get("mcp", {})
    host = mcp_cfg.get("host", "127.0.0.1")
    port = mcp_cfg.get("port", 9920)

    # Shared state. The registry is rehydrated from a SQLite-backed
    # ``RegistryStore`` so participant keys and read cursors survive daemon
    # restarts. The DB lives next to the config at ``~/.claude-comms/registry.db``
    # by default (overridable via the ``registry`` config block's ``data_dir``).
    # ``Participant.connections`` is ephemeral and intentionally not persisted —
    # rehydrated participants come back offline and re-online on next
    # interaction via MQTT presence + ``_ensure_mcp_connection``.
    registry_cfg = config.get("registry", {})
    registry_data_dir = registry_cfg.get("data_dir")
    registry_dir = (
        Path(registry_data_dir).expanduser()
        if registry_data_dir
        else Path.home() / ".claude-comms"
    )
    _registry_store = RegistryStore.open(registry_dir)
    _registry = ParticipantRegistry(store=_registry_store)
    _deduplicator = MessageDeduplicator()
    _store = MessageStore()

    # Presence manager (TTL-based cleanup of stale connections)
    presence_cfg = config.get("presence", {})
    ttl = presence_cfg.get("connection_ttl_seconds", 180)
    sweep = presence_cfg.get("sweep_interval_seconds", 30)

    _presence = PresenceManager(
        registry=_registry,
        publish_fn=None,  # wired later once aiomqtt client is up
        ttl_seconds=ttl,
        sweep_interval_seconds=sweep,
    )

    # Replay JSONL logs
    logging_cfg = config.get("logging", {})
    log_dir = logging_cfg.get("dir", "~/.claude-comms/logs")
    log_path = Path(log_dir).expanduser()
    _ = replay_jsonl_logs(
        log_dir=log_path,
        store=_store,
        deduplicator=_deduplicator,
    )

    # Create FastMCP instance
    mcp = FastMCP(
        "claude-comms",
        stateless_http=True,
        json_response=True,
        host=host,
        port=port,
    )

    # Placeholder publish function (replaced when MQTT subscriber starts).
    # Signature MUST match `_do_publish` below — the `PublishFn` protocol
    # declares ``retain: bool = False`` and presence.set_publish_fn type-
    # checks the argument. Prior to v0.3.1 this was ``(topic, payload)``
    # only, which Pyright flagged but Python accepted at runtime; the
    # mismatch became load-bearing once MCP-side presence publishes
    # started passing retain=True (Bug 2 from the v0.3.0 follow-up brief).
    async def _noop_publish(topic: str, payload: bytes, retain: bool = False) -> None:
        del topic, payload, retain
        raise ConnectionError(
            "MQTT broker unavailable. Run 'claude-comms start' to start the daemon."
        )

    _publish_fn = _noop_publish

    # ------------------------------------------------------------------
    # Register tools
    # ------------------------------------------------------------------

    @mcp.tool(structured_output=False)
    async def comms_join(
        key: Annotated[
            str | None,
            Field(description="Your participant key (omit on first call)"),
        ] = None,
        conversation: Annotated[
            str,
            Field(description="Conversation to join (default: general)"),
        ] = "general",
        name: Annotated[
            str | None,
            Field(description="Display name (required on first call)"),
        ] = None,
    ) -> CallToolResult:
        """Join a conversation. Returns your participant key. Call with name on first use; key on subsequent calls."""
        result = await tool_comms_join(
            _get_registry(),
            key=key,
            conversation=conversation,
            name=name,
            publish_fn=_publish_fn,
            conv_data_dir=_get_conv_data_dir(),
        )
        # Publish retained MCP presence so TUI / web clients (including
        # those connecting after this join) see the participant. The
        # module-level helper is used so it can be unit-tested
        # independently of the FastMCP wiring (tests/test_mcp_presence.py).
        if not result.get("error") and _publish_fn is not None:
            await publish_mcp_presence_on_join(
                _publish_fn,
                conversation=conversation,
                key=result["key"],
                name=result["name"],
                type_=result["type"],
            )
        if not result.get("error"):
            _touch(result.get("key"))
        return _concise(result, summarize_join(result))

    @mcp.tool(structured_output=False)
    def comms_leave(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to leave")],
    ) -> CallToolResult:
        """Leave a conversation."""
        result = tool_comms_leave(_get_registry(), key=key, conversation=conversation)
        return _concise(result, summarize_leave(result))

    @mcp.tool(structured_output=False)
    async def comms_send(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        message: Annotated[str, Field(description="Message text to send")],
        mentions: Annotated[
            list[str] | None,
            Field(
                description=(
                    "Broadcast highlight intent: names or 8-hex keys. "
                    "Visible to all; named users get a notification cue. "
                    "Does NOT restrict visibility."
                )
            ),
        ] = None,
        recipients: Annotated[
            list[str] | None,
            Field(
                description=(
                    "Whisper recipients: names or 8-hex keys. "
                    "Visible only to sender + listed recipients."
                )
            ),
        ] = None,
        reply_to: Annotated[
            str | None,
            Field(
                description=(
                    "Optional id of a message in the same conversation to "
                    "thread under. Server enforces depth-2 (replies cannot "
                    "themselves be replied to) and rejects replies targeting "
                    "system messages. See plans/threaded-replies-plan."
                )
            ),
        ] = None,
    ) -> CallToolResult:
        """Send a message to a conversation.

        ``mentions`` = broadcast highlight intent (visible to all; named users
        get a notification cue). ``recipients`` = private whisper (visible only
        to sender + listed recipients). Both accept names or 8-hex keys; the
        two are independent and may be combined (whisper-with-named-highlights).

        ``reply_to`` = thread intent (server validates parent existence,
        depth-2 limit, and no-system-parent).
        """
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        result = await tool_comms_send(
            _get_registry(),
            _publish_fn,
            _get_store(),
            key=key,
            conversation=conversation,
            message=message,
            mentions=mentions,
            recipients=recipients,
            reply_to=reply_to,
            # v0.4.0 Step 2.3: wire conv_data_dir so the archived-guard
            # check in tool_comms_send blocks live sends into archived
            # conversations at the MCP layer.
            conv_data_dir=_get_conv_data_dir(),
        )
        return _concise(result, summarize_send(result))

    @mcp.tool(structured_output=False)
    def comms_read(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to read")],
        count: Annotated[
            int, Field(description="Number of messages (default 20, max 200)")
        ] = 20,
        since: Annotated[
            str | None,
            Field(description="ISO timestamp to read messages after"),
        ] = None,
        top_level_only: Annotated[
            bool,
            Field(
                description=(
                    "When True, return only messages whose reply_to is null "
                    "(thread roots and untyped top-level messages). Each "
                    "returned root with at least one reply is decorated with "
                    "a `thread_summary: {reply_count, last_ts, last_author}` "
                    "field. Default False preserves the firehose behaviour. "
                    "UI passes True for the channel feed; thread bodies are "
                    "fetched separately via comms_thread_read."
                )
            ),
        ] = False,
        unread: Annotated[
            bool,
            Field(
                description=(
                    "When True, return only messages you HAVEN'T SEEN yet, using "
                    "the server-side read cursor (no manual `since` needed) — the "
                    "robust way to poll for new messages without missing any. "
                    "Reading advances the cursor, so the next unread call returns "
                    "only newer messages. An explicit `since` overrides this."
                )
            ),
        ] = False,
    ) -> CallToolResult:
        """Read recent messages from a conversation.

        ``unread=True`` returns only messages after your server-side read cursor
        (what you haven't seen), no manual timestamp — the reliable poll mode.
        ``top_level_only=True`` filters to thread roots and decorates each root
        with a ``thread_summary``. Every returned message carries
        ``directed_at_me`` (True when you're in its mentions or recipients).
        """
        _touch(key)
        result = tool_comms_read(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
            count=count,
            since=since,
            top_level_only=top_level_only,
            unread=unread,
        )
        return _concise(result, summarize_read(result))

    @mcp.tool(structured_output=False)
    def comms_thread_read(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="Conversation containing the thread")
        ],
        root_id: Annotated[
            str,
            Field(description="Message id of the thread root"),
        ],
        count: Annotated[
            int, Field(description="Max replies to return (default 20, max 200)")
        ] = 20,
        since: Annotated[
            str | None,
            Field(description="ISO timestamp to read replies after"),
        ] = None,
    ) -> CallToolResult:
        """Read replies inside a single thread.

        Returns ``{conversation, root, replies, count, has_more}``. The
        ``root`` field is always populated with the thread root regardless
        of ``since`` — incremental fetches must never lose context.
        Advances a per-thread read cursor as a side effect, so subsequent
        ``comms_check`` calls reflect the updated ``thread_unread`` for
        this root.
        """
        _touch(key)
        result = tool_comms_thread_read(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
            root_id=root_id,
            count=count,
            since=since,
        )
        return _concise(result, summarize_thread_read(result))

    @mcp.tool(structured_output=False)
    def comms_check(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str | None,
            Field(description="Check specific conversation (null = all)"),
        ] = None,
        mark_seen: Annotated[
            bool,
            Field(
                description=(
                    "When True, advance the read cursor to the latest "
                    "visible-to-viewer message after computing the response. "
                    "Use to acknowledge unread without reading the body. "
                    "Default False preserves peek-only semantics."
                )
            ),
        ] = False,
    ) -> CallToolResult:
        """Check for unread messages across conversations.

        ``total_unread`` counts only messages visible to the caller (whispers
        addressed to others are excluded).

        ``mark_seen=True`` acknowledges-without-reading: after the response
        dict is built, the read cursor advances to the latest visible message
        in each scanned conversation. The returned ``total_unread`` reflects
        the PRE-advance count, so the caller sees what they acknowledged.
        """
        _touch(key)
        result = tool_comms_check(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
            mark_seen=mark_seen,
        )
        return _concise(result, summarize_check(result))

    @mcp.tool(structured_output=False)
    def comms_members(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to list")],
    ) -> CallToolResult:
        """List current participants in a conversation."""
        _touch(key)
        result = tool_comms_members(_get_registry(), key=key, conversation=conversation)
        return _concise(result, summarize_members(result))

    @mcp.tool(structured_output=False)
    async def comms_status_set(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="Conversation to set status in")
        ],
        label: Annotated[
            str,
            Field(
                description="Short activity token, e.g. 'thinking', 'reading', 'drafting', 'typing', 'working'. <= 32 chars."
            ),
        ],
        ttl_seconds: Annotated[
            int | None,
            Field(
                description="Seconds until the status auto-expires. Omit to use the server default (presence.activity_ttl_seconds, default 120); hard cap presence.activity_ttl_max_seconds (default 300)."
            ),
        ] = None,
    ) -> CallToolResult:
        """Set an ephemeral activity signal ('thinking', 'reading', etc.) on your connections.

        Status is presence, not content: it lives only as long as the activity TTL or your
        connection, whichever expires first.  Use comms_status_clear to drop it early, or
        let the server sweep clear it automatically.

        Visibility: always per-conversation broadcast, regardless of any in-flight
        targeted messages.

        Throttle: at most one update every 2 seconds per participant; bursts above are
        silently dropped (last-write-wins).
        """
        _touch(key)
        presence_cfg = config.get("presence", {})
        default_ttl = presence_cfg.get("activity_ttl_seconds", 120)
        max_ttl = presence_cfg.get("activity_ttl_max_seconds", 300)
        result = await tool_comms_status_set(
            _get_registry(),
            key=key,
            conversation=conversation,
            label=label,
            ttl_seconds=(ttl_seconds if ttl_seconds is not None else default_ttl),
            max_ttl_seconds=max_ttl,
            publish_fn=_publish_fn,
        )
        return _concise(result, summarize_status_set(result))

    @mcp.tool(structured_output=False)
    async def comms_status_clear(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="Conversation in which to clear status")
        ],
    ) -> CallToolResult:
        """Clear any active activity signal on your connections.

        Idempotent: safe to call when no activity is set.
        """
        _touch(key)
        result = await tool_comms_status_clear(
            _get_registry(),
            key=key,
            conversation=conversation,
            publish_fn=_publish_fn,
        )
        return _concise(result, summarize_status_clear(result))

    # ── v0.4.2 Step 3.14, Wave A2 re-issue post-§I.18-collision-rename ──
    # Profile status is the DURABLE per-participant ornament Wave E's
    # StatusEditor consumes; distinct from the ephemeral activity tools
    # above (those broadcast on conv/{conv}/activity; these augment the
    # retained presence topic per the brief's edge map). The MCP tool
    # surface intentionally omits a ``key`` argument — caller identity
    # is single-tenant via ``_config["identity"]["key"]``.

    @mcp.tool(structured_output=False)
    async def comms_profile_status_set(
        emoji: Annotated[
            str | None,
            Field(description="Single emoji glyph or None to leave unset."),
        ],
        text: Annotated[
            str | None,
            Field(description="Short status sentence, <= 140 chars, or None."),
        ],
        expires_at: Annotated[
            str | None,
            Field(
                description=(
                    "Optional ISO 8601 timestamp after which the auto-expire "
                    "sweep (~60s tick) clears this status. None = no auto-expire."
                )
            ),
        ] = None,
    ) -> CallToolResult:
        """Set the caller's durable profile-status triplet.

        Persists ``profile_status_emoji`` / ``profile_status_text`` /
        ``profile_status_expires_at`` on the participants row and broadcasts
        the augmented retained presence payload on
        ``claude-comms/presence/{key}/{connKey}`` for every active connection.

        Caller identity comes from the daemon's configured
        ``identity.key`` (single-tenant).
        """
        assert _config is not None, "MCP server config not initialised"
        caller_key = _config.get("identity", {}).get("key")
        if not caller_key:
            err = {"error": True, "message": "Daemon config missing identity.key."}
            return _concise(err, summarize_profile_status_set(err))
        _touch(caller_key)
        result = await tool_comms_profile_status_set(
            _get_registry(),
            key=caller_key,
            emoji=emoji,
            text=text,
            expires_at=expires_at,
            publish_fn=_publish_fn,
        )
        return _concise(result, summarize_profile_status_set(result))

    @mcp.tool(structured_output=False)
    async def comms_profile_status_clear() -> CallToolResult:
        """Clear the caller's profile-status triplet.

        Idempotent. Broadcasts the cleared payload so subscribers drop
        stale tooltips even when the local row was already NULL.
        """
        assert _config is not None, "MCP server config not initialised"
        caller_key = _config.get("identity", {}).get("key")
        if not caller_key:
            err = {"error": True, "message": "Daemon config missing identity.key."}
            return _concise(err, summarize_profile_status_clear(err))
        _touch(caller_key)
        result = await tool_comms_profile_status_clear(
            _get_registry(),
            key=caller_key,
            publish_fn=_publish_fn,
        )
        return _concise(result, summarize_profile_status_clear(result))

    @mcp.tool(structured_output=False)
    async def comms_react(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="Conversation containing the message")
        ],
        message_id: Annotated[
            str,
            Field(description="Target message UUID. Get from comms_read."),
        ],
        emoji: Annotated[
            str,
            Field(
                description="Emoji or short token (unicode, ':heart:', or slug). Free-text up to 64 chars."
            ),
        ],
        op: Annotated[
            str,
            Field(
                description="Operation: 'add', 'remove', or 'toggle' (default). Toggle resolves against current state."
            ),
        ] = "toggle",
    ) -> CallToolResult:
        """Add, remove, or toggle a reaction on a message.

        Reactions persist in the conversation's reactions log and broadcast on
        the dedicated reactions topic. Toggling resolves to add/remove based on
        whether the actor already has that emoji on the message. No-op
        operations (e.g. add when already present) return ``{"status": "no_op"}``.

        Rate limits: 30 reaction events per actor per minute per conversation,
        and a max of 10 distinct emojis per actor per message.
        """
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        result = await tool_comms_react(
            _get_registry(),
            _publish_fn,
            _get_reactions_store,
            key=key,
            conversation=conversation,
            message_id=message_id,
            emoji=emoji,
            op=op,
        )
        return _concise(result, summarize_react(result))

    @mcp.tool(structured_output=False)
    def comms_reactions_get(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="Conversation containing the message")
        ],
        message_id: Annotated[str, Field(description="Target message UUID")],
    ) -> CallToolResult:
        """List current reactions on a message.

        Returns ``{"reactions": {emoji: [actor_key, ...]}}``. Empty when the
        message has never received a reaction.
        """
        _touch(key)
        result = tool_comms_reactions_get(
            _get_registry(),
            _get_reactions_store,
            key=key,
            conversation=conversation,
            message_id=message_id,
        )
        return _concise(result, summarize_reactions_get(result))

    @mcp.tool(structured_output=False)
    def comms_conversations(
        key: Annotated[str, Field(description="Your participant key")],
        all: Annotated[
            bool, Field(description="If true, list ALL conversations (not just joined)")
        ] = False,
    ) -> CallToolResult:
        """List all conversations you have joined with unread counts. Use all=true to discover all conversations."""
        _touch(key)
        result = tool_comms_conversations(
            _get_registry(),
            _get_store(),
            key=key,
            all=all,
            conv_data_dir=_get_conv_data_dir(),
        )
        return _concise(result, summarize_conversations(result))

    @mcp.tool(structured_output=False)
    def comms_update_name(
        key: Annotated[str, Field(description="Your participant key")],
        new_name: Annotated[str, Field(description="New display name")],
    ) -> CallToolResult:
        """Change your display name. Your key remains the same."""
        _touch(key)
        result = tool_comms_update_name(_get_registry(), key=key, new_name=new_name)
        return _concise(result, summarize_update_name(result))

    @mcp.tool(structured_output=False)
    def comms_history(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to search")],
        query: Annotated[
            str | None,
            Field(description="Text to search for (null = all messages)"),
        ] = None,
        count: Annotated[
            int, Field(description="Max results (default 50, max 200)")
        ] = 50,
    ) -> CallToolResult:
        """Search message history by text content or sender name."""
        _touch(key)
        result = tool_comms_history(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
            query=query,
            count=count,
        )
        return _concise(result, summarize_history(result))

    @mcp.tool(structured_output=False)
    async def comms_artifact_create(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[
            str,
            Field(
                description="Artifact slug (lowercase, hyphens, e.g. 'backend-plan')"
            ),
        ],
        title: Annotated[str, Field(description="Human-readable title")],
        type: Annotated[str, Field(description="Artifact type: plan, doc, or code")],
        content: Annotated[
            str, Field(description="Initial content (markdown, code, etc.)")
        ],
    ) -> CallToolResult:
        """Create a new collaborative artifact in a conversation. Returns artifact metadata."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        result = await tool_comms_artifact_create(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            name=name,
            title=title,
            type=type,
            content=content,
            data_dir=_get_data_dir(),
        )
        return _concise(result, summarize_artifact_create(result))

    @mcp.tool(structured_output=False)
    async def comms_artifact_update(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[str, Field(description="Artifact slug to update")],
        content: Annotated[str, Field(description="New content (full replacement)")],
        summary: Annotated[str, Field(description="Brief description of changes")] = "",
        base_version: Annotated[
            int | None,
            Field(
                description="Expected current version for concurrency check (optional)"
            ),
        ] = None,
    ) -> CallToolResult:
        """Update an artifact with new content. Optionally check base_version for concurrency safety."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        result = await tool_comms_artifact_update(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            name=name,
            content=content,
            summary=summary,
            base_version=base_version,
            data_dir=_get_data_dir(),
        )
        return _concise(result, summarize_artifact_update(result))

    @mcp.tool(structured_output=False)
    async def comms_artifact_delete(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[str, Field(description="Artifact slug to delete")],
    ) -> CallToolResult:
        """Delete an artifact and all its versions from a conversation."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        result = await tool_comms_artifact_delete(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            name=name,
            data_dir=_get_data_dir(),
        )
        return _concise(result, summarize_artifact_delete(result))

    @mcp.tool(structured_output=False)
    def comms_artifact_get(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[str, Field(description="Artifact slug to read")],
        version: Annotated[
            int | None, Field(description="Specific version number (default: latest)")
        ] = None,
        offset: Annotated[
            int, Field(description="Character offset for chunked reading (default: 0)")
        ] = 0,
        limit: Annotated[
            int | None, Field(description="Max characters to return (default: 50000)")
        ] = None,
    ) -> CallToolResult:
        """Read an artifact's content with optional chunked pagination. Returns content chunk + version metadata."""
        _touch(key)
        result = tool_comms_artifact_get(
            _get_registry(),
            key=key,
            conversation=conversation,
            name=name,
            version=version,
            offset=offset,
            limit=limit,
            data_dir=_get_data_dir(),
        )
        return _concise(result, summarize_artifact_get(result))

    @mcp.tool(structured_output=False)
    def comms_artifact_list(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
    ) -> CallToolResult:
        """List all artifacts in a conversation with summary metadata (no content)."""
        _touch(key)
        result = tool_comms_artifact_list(
            _get_registry(),
            key=key,
            conversation=conversation,
            data_dir=_get_data_dir(),
        )
        return _concise(result, summarize_artifact_list(result))

    # -- Conversation discovery tools --

    @mcp.tool(structured_output=False)
    async def comms_conversation_create(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="New conversation slug (lowercase, hyphens)")
        ],
        topic: Annotated[str, Field(description="Conversation topic/description")] = "",
    ) -> CallToolResult:
        """Create a new conversation with optional topic. Auto-joins you and all human participants."""
        _touch(key)
        assert _publish_fn is not None
        result = await tool_comms_conversation_create(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            topic=topic,
            conv_data_dir=_get_conv_data_dir(),
        )
        # Broadcast conversation-lifecycle event so connected browsers
        # incrementally update their sidebar (Bug B fix). Best-effort.
        if result.get("status") == "created":
            await publish_conversation_event(
                _publish_fn,
                event_type="conversation_created",
                name=conversation,
                topic=topic,
                creator_key=key,
            )
        return _concise(result, summarize_conversation_create(result))

    @mcp.tool(structured_output=False)
    async def comms_conversation_update(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to update")],
        topic: Annotated[
            str | None,
            Field(description="New topic/description (optional)"),
        ] = None,
        name: Annotated[
            str | None,
            Field(
                description=(
                    "REJECTED: the storage slug is immutable (it doubles as "
                    "the MQTT topic key). Use display_name to change the "
                    "user-facing label."
                )
            ),
        ] = None,
        display_name: Annotated[
            str | None,
            Field(
                description=(
                    "Optional user-facing display name. Frontend renders "
                    "display_name when present, else falls back to the "
                    "storage slug."
                )
            ),
        ] = None,
        visibility: Annotated[
            str | None,
            Field(
                description=(
                    "Channel visibility: 'public' = listed in directory; "
                    "'private' = unlisted but joinable by key."
                )
            ),
        ] = None,
        mode: Annotated[
            str | None,
            Field(
                description=(
                    "Join mode: 'open' = anyone can join; 'invite' = invite-only."
                )
            ),
        ] = None,
        created_by: Annotated[
            str | None,
            Field(
                description=(
                    "Transfer ownership to this participant key (8 hex chars). "
                    "Caller must be the current owner. Side-effects: updates "
                    "the conversation_roles table (new_owner = 'owner', "
                    "old_owner = 'member')."
                )
            ),
        ] = None,
    ) -> CallToolResult:
        """Update one or more of a conversation's mutable fields.

        All update fields are optional; pass at least one. The 'name' field
        is rejected with an error envelope because the storage slug is
        immutable. System messages are rate-limited to 1/min per channel
        (multi-field updates produce ONE combined system message).
        """
        _touch(key)
        assert _publish_fn is not None
        result = await tool_comms_conversation_update(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            topic=topic,
            name=name,
            display_name=display_name,
            visibility=visibility,
            mode=mode,
            created_by=created_by,
            conv_data_dir=_get_conv_data_dir(),
            rate_limit_state=_topic_rate_limit,
            store=_get_registry_store(),
        )
        # Broadcast topic-changed so connected browsers refresh the channel's
        # topic line without waiting for the rate-limited system message.
        # Only fired when topic was one of the updated fields.
        if result.get("status") == "updated" and topic is not None:
            await publish_conversation_event(
                _publish_fn,
                event_type="conversation_topic_changed",
                name=conversation,
                topic=topic,
            )
        return _concise(result, summarize_conversation_update(result))

    @mcp.tool(structured_output=False)
    def comms_get_channel_role(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="Conversation to query the role in")
        ],
        target_participant_key: Annotated[
            str | None,
            Field(
                description=(
                    "Optional target participant key. When omitted, returns "
                    "the caller's own role in the conversation."
                )
            ),
        ] = None,
    ) -> CallToolResult:
        """Return the per-channel role for the caller or a target participant.

        Caller must be a member of the conversation. Unknown (conversation,
        key) pairs read as the default 'member' role per Step 3.0a's
        default-safe semantics.
        """
        _touch(key)
        result = tool_comms_get_channel_role(
            _get_registry(),
            _get_registry_store(),
            key=key,
            conversation=conversation,
            target_participant_key=target_participant_key,
        )
        return _concise(result, summarize_get_channel_role(result))

    @mcp.tool(structured_output=False)
    async def comms_conversation_delete(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to delete")],
        confirm: Annotated[
            bool,
            Field(
                description=(
                    "Set True to actually delete. When False (the default), returns "
                    "a structured pre-flight payload (message_count, member_count) "
                    "so the client can render a type-name confirmation modal."
                )
            ),
        ] = False,
    ) -> CallToolResult:
        """Soft-delete a conversation. Creator, owner, or admin only. Two-phase: call with confirm=False first to get counts, then confirm=True to delete."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        result = await tool_comms_conversation_delete(
            _get_registry(),
            _get_store(),
            _publish_fn,
            key=key,
            conversation=conversation,
            confirm=confirm,
            conv_data_dir=_get_conv_data_dir(),
            registry_store=_get_registry_store(),
        )
        return _concise(result, summarize_conversation_delete(result))

    @mcp.tool(structured_output=False)
    async def comms_conversation_archive(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation slug to archive")],
        confirm: Annotated[
            bool,
            Field(
                description=(
                    "When False (default), return confirm_required + the "
                    "message_count / member_count blast radius for the web "
                    "client's confirmation modal. Pass True to commit."
                )
            ),
        ] = False,
    ) -> CallToolResult:
        """Archive a conversation; preserve history, eject members, block new sends.

        Creator, owner, or admin only. Two-phase: call with ``confirm=False`` first
        to surface the blast-radius modal, then with ``confirm=True`` to
        commit. Archived conversations remain visible in the directory's
        Archived sub-tab as read-only artifacts and reject any further
        ``comms_send``.
        """
        _touch(key)
        assert _publish_fn is not None
        result = await tool_comms_conversation_archive(
            _get_registry(),
            _publish_fn,
            _get_store(),
            key=key,
            conversation=conversation,
            confirm=confirm,
            conv_data_dir=_get_conv_data_dir(),
            registry_store=_get_registry_store(),
        )
        # Publish the system event + retained-clear evicted presence only
        # on a real archive-commit. The two-phase confirm contract means
        # confirm=False returns confirm_required with no state change.
        if result.get("archived") is True and result.get("evicted_keys") is not None:
            await _publish_archive_event(
                _publish_fn,
                event_type="archived",
                conversation_id=conversation,
                archived_by=result.get("archived_by"),
                evicted_keys=result.get("evicted_keys") or [],
            )
        return _concise(result, summarize_conversation_archive(result))

    @mcp.tool(structured_output=False)
    async def comms_conversation_unarchive(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str, Field(description="Conversation slug to unarchive")
        ],
    ) -> CallToolResult:
        """Unarchive a conversation; reverse the archive state flip.

        Creator-only in v0.4.0. Restores the conversation to the live
        directory but does NOT auto-re-join previously evicted members;
        they re-join via their own ``comms_join`` (Design Spec §4.4).
        """
        _touch(key)
        assert _publish_fn is not None
        result = await tool_comms_conversation_unarchive(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            conv_data_dir=_get_conv_data_dir(),
        )
        if result.get("archived") is False and "error" not in result:
            await _publish_archive_event(
                _publish_fn,
                event_type="unarchived",
                conversation_id=conversation,
            )
        return _concise(result, summarize_conversation_unarchive(result))

    @mcp.tool(structured_output=False)
    async def comms_invite(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to invite to")],
        target_name: Annotated[str, Field(description="Name of participant to invite")],
        message: Annotated[str, Field(description="Optional invite message")] = "",
    ) -> CallToolResult:
        """Invite a participant to a conversation. Posts invite notification in #general."""
        _touch(key)
        assert _publish_fn is not None
        result = await tool_comms_invite(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            target_name=target_name,
            message=message,
            conv_data_dir=_get_conv_data_dir(),
        )
        return _concise(result, summarize_invite(result, target_name=target_name))

    @mcp.tool(structured_output=False)
    async def comms_kick(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to kick from")],
        target_key: Annotated[
            str, Field(description="Participant key (8 hex chars) to eject")
        ],
    ) -> CallToolResult:
        """Eject a participant from a conversation. Owner / admin only.

        Authorization gates on the caller's per-channel role from the
        ``conversation_roles`` table (Step 3.0a): only ``'owner'`` and
        ``'admin'`` may kick. Publishes a ``[system]`` message on the
        conversation's MQTT topic naming both caller and target.
        """
        _touch(key)
        assert _publish_fn is not None
        result = await tool_comms_kick(
            _get_registry(),
            _publish_fn,
            _get_registry_store(),
            key=key,
            conversation=conversation,
            target_key=target_key,
            conv_data_dir=_get_conv_data_dir(),
        )
        target = _get_registry().get(target_key)
        target_name = target.name if target else ""
        return _concise(result, summarize_kick(result, target_name=target_name))

    @mcp.tool(structured_output=False)
    async def comms_dm_open(
        key: Annotated[str, Field(description="Your participant key")],
        target_key: Annotated[
            str, Field(description="Participant key (8 hex chars) to DM")
        ],
    ) -> CallToolResult:
        """Open (or look up) the deterministic two-party DM channel.

        DM slug is ``dm-{lo}-{hi}`` where the two participant keys are
        sorted alphanumerically — symmetric on which party opens first.
        Idempotent: a second call returns ``status="existed"``. New
        DMs are private + invite-mode, with both parties auto-joined
        and granted symmetric ``'owner'`` role.
        """
        _touch(key)
        assert _publish_fn is not None
        result = await tool_comms_dm_open(
            _get_registry(),
            _publish_fn,
            _get_registry_store(),
            key=key,
            target_key=target_key,
            conv_data_dir=_get_conv_data_dir(),
        )
        target = _get_registry().get(target_key)
        target_name = target.name if target else ""
        return _concise(result, summarize_dm_open(result, target_name=target_name))

    # Reference every @mcp.tool-decorated function so the language server
    # sees them as used (the decorator registration alone is not treated as
    # a use, producing spurious "not accessed" grey hints). No runtime effect.
    _ = (
        comms_join,
        comms_leave,
        comms_send,
        comms_read,
        comms_thread_read,
        comms_check,
        comms_members,
        comms_status_set,
        comms_status_clear,
        comms_profile_status_set,
        comms_profile_status_clear,
        comms_react,
        comms_reactions_get,
        comms_conversations,
        comms_update_name,
        comms_history,
        comms_artifact_create,
        comms_artifact_update,
        comms_artifact_delete,
        comms_artifact_get,
        comms_artifact_list,
        comms_conversation_create,
        comms_conversation_update,
        comms_get_channel_role,
        comms_conversation_delete,
        comms_conversation_archive,
        comms_conversation_unarchive,
        comms_invite,
        comms_kick,
        comms_dm_open,
    )

    return mcp


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def start_server(config: dict[str, Any] | None = None) -> None:
    """Create and run the MCP server (blocking).

    Starts the MQTT subscriber as a background task, then runs the
    FastMCP server on the configured host/port.
    """
    global _publish_fn

    if config is None:
        config = load_config()

    mcp = create_server(config)

    broker_cfg = config.get("broker", {})
    broker_host = broker_cfg.get("host", "127.0.0.1")
    broker_port = broker_cfg.get("port", 1883)

    async def _run() -> None:
        global _publish_fn

        # Start MQTT subscriber background task
        assert _store is not None, "Message store not initialised"
        assert _deduplicator is not None, "Deduplicator not initialised"
        # Notification cue writer so the PostToolUse hook works in standalone
        # mode too (registry global is reassigned during create_server, so
        # resolve it lazily via the provider).
        notifier = NotificationWriter.from_config(
            config, registry_provider=lambda: _registry
        )
        sub_task = asyncio.create_task(
            _mqtt_subscriber(
                broker_host,
                broker_port,
                _store,
                _deduplicator,
                notifier=notifier,
            )
        )

        # Create a persistent MQTT client for publishing
        try:
            import aiomqtt
            from claude_comms.broker import generate_client_id

            pub_client_id = generate_client_id("mcp-pub", "00000000")
            async with aiomqtt.Client(
                hostname=broker_host,
                port=broker_port,
                identifier=pub_client_id,
            ) as pub_client:

                async def _do_publish(
                    topic: str, payload: bytes, retain: bool = False
                ) -> None:
                    await pub_client.publish(topic, payload, qos=1, retain=retain)

                _publish_fn = _do_publish
                logger.info("MCP publish client connected to broker")

                # Wire publish_fn into the presence manager and start the sweep loop
                if _presence is not None:
                    _presence.set_publish_fn(_do_publish)
                    _presence.start()
                    logger.info("Presence manager started")

                # Run the MCP server (blocks until shutdown)
                mcp_cfg = config.get("mcp", {})
                _host = mcp_cfg.get("host", "127.0.0.1")
                _port = mcp_cfg.get("port", 9920)
                mcp.run(transport="streamable-http")
        except Exception:
            logger.exception("MCP server error")
        finally:
            _ = sub_task.cancel()
            try:
                await sub_task
            except asyncio.CancelledError:
                pass
            # Close the registry store cleanly so the WAL checkpoints back into
            # the main DB before the process exits.
            if _registry_store is not None:
                try:
                    _registry_store.close()
                except Exception:
                    logger.exception("Failed to close registry store")

    asyncio.run(_run())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    start_server()
