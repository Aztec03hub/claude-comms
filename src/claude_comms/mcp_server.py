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
from pathlib import Path
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
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
    tool_comms_conversation_create,
    tool_comms_conversation_update,
    tool_comms_conversations,
    tool_comms_history,
    tool_comms_invite,
    tool_comms_join,
    tool_comms_leave,
    tool_comms_members,
    tool_comms_read,
    tool_comms_send,
    tool_comms_update_name,
)
from claude_comms.conversation import (
    LastActivityTracker,
    backfill_missing_metadata,
    ensure_general_exists,
    list_all_conversations,
    load_meta,
)
from claude_comms.presence import PresenceManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared state  (module-level singletons, initialised in ``create_server``)
# ---------------------------------------------------------------------------

_registry: ParticipantRegistry | None = None
_store: MessageStore | None = None
_deduplicator: MessageDeduplicator | None = None
_publish_fn: PublishFn | None = None
_config: dict[str, Any] | None = None
_data_dir: Path | None = None
_conv_data_dir: Path | None = None
_activity_tracker: LastActivityTracker | None = None
_presence: PresenceManager | None = None
_topic_rate_limit: dict[str, float] = {}  # conversation -> last system msg monotonic time


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


def _get_data_dir() -> Path:
    if _data_dir is None:
        raise RuntimeError("MCP server not initialised.")
    return _data_dir


def _get_conv_data_dir() -> Path:
    if _conv_data_dir is None:
        raise RuntimeError("MCP server not initialised.")
    return _conv_data_dir


def _get_presence() -> PresenceManager | None:
    """Return the presence manager, or None if not initialised.

    Returns None rather than raising — presence is best-effort and tools
    must continue to work even if the manager hasn't been wired yet.
    """
    return _presence


def _touch(key: str | None) -> None:
    """Best-effort refresh of a participant's last_seen timestamp."""
    if not key or _presence is None:
        return
    try:
        _presence.touch(key)
    except Exception:
        logger.exception("Presence touch failed for key %s", key)


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
        }
        for m in members
    ]


def get_conversation_artifacts(conversation: str) -> list[dict]:
    """Return artifact summaries for a conversation (backing REST endpoint)."""
    if _data_dir is None:
        return []
    from claude_comms.artifact import list_artifacts
    return list_artifacts(conversation, _data_dir)


def get_artifact(conversation: str, name: str, version: int | None = None) -> dict | None:
    """Return artifact data for REST endpoint. Latest version content + version metadata."""
    if _data_dir is None:
        return None
    from claude_comms.artifact import load_artifact, DEFAULT_GET_CHUNK_SIZE
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
        {"version": v.version, "author": v.author.model_dump(), "timestamp": v.timestamp, "summary": v.summary}
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
        entry = {
            "name": meta.name,
            "topic": meta.topic,
            "last_activity": _activity_tracker.get(meta.name) if _activity_tracker else meta.last_activity,
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
# MQTT subscriber background task
# ---------------------------------------------------------------------------


async def _mqtt_subscriber(
    host: str,
    port: int,
    store: MessageStore,
    deduplicator: MessageDeduplicator,
    log_exporter: Any = None,
) -> None:
    """Subscribe to all conversation messages and feed them into the store.

    Also writes each message to disk via *log_exporter* (if provided)
    so messages persist across daemon restarts.

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
                await client.subscribe(msg_topic, qos=1)
                await client.subscribe(presence_topic, qos=1)
                await client.subscribe(system_topic, qos=1)
                await client.subscribe(new_presence_topic, qos=1)
                logger.info("MCP subscriber connected to %s:%d", host, port)
                async for mqtt_msg in client.messages:
                    try:
                        payload = (
                            mqtt_msg.payload.decode("utf-8")
                            if isinstance(mqtt_msg.payload, bytes)
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
                            if _activity_tracker is not None:
                                _activity_tracker.update(conv_id, data.get("ts", ""))
                                _activity_tracker.flush_if_due(_conv_data_dir)
                            # Persist to disk for replay on restart
                            if log_exporter is not None:
                                try:
                                    log_exporter.write_message(data)
                                except Exception:
                                    logger.warning(
                                        "Failed to write message to log", exc_info=True
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
                                _registry.join(
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
                                    p.connections.pop(conn_key, None)
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
                                _registry.join(
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
                                        existing.connections.pop(conn_key, None)
                                    if not existing.connections:
                                        _registry.leave(key, "general")

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
    global _registry, _store, _deduplicator, _publish_fn, _config, _data_dir, _conv_data_dir, _activity_tracker, _presence

    if config is None:
        config = load_config()
    _config = config

    _data_dir = Path(config.get("artifacts", {}).get("data_dir", "~/.claude-comms/artifacts")).expanduser()
    _data_dir.mkdir(parents=True, exist_ok=True)

    # R5-3 / R6-2: one-time NFC migration for pre-existing NFD artifact files
    # (e.g. from macOS HFS+ fresh installs). Quarantines collisions rather
    # than leaving split-brain NFD/NFC twins. Runs BEFORE the MQTT subscriber
    # starts and before any tools are registered.
    renamed, quarantined = migrate_artifact_names_to_nfc(_data_dir)
    if renamed or quarantined:
        logger.warning(
            "Artifact NFC migration complete: %d renamed, %d quarantined",
            renamed, quarantined,
        )

    _conv_data_dir = Path(config.get("conversations", {}).get("data_dir", "~/.claude-comms/conversations")).expanduser()
    _conv_data_dir.mkdir(parents=True, exist_ok=True)
    _activity_tracker = LastActivityTracker()

    # Bootstrap "general" and backfill missing metadata
    ensure_general_exists(_conv_data_dir)
    log_dir = Path(config.get("logging", {}).get("dir", "~/.claude-comms/logs")).expanduser()
    backfill_missing_metadata(_conv_data_dir, log_dir)

    mcp_cfg = config.get("mcp", {})
    host = mcp_cfg.get("host", "127.0.0.1")
    port = mcp_cfg.get("port", 9920)

    # Shared state
    _registry = ParticipantRegistry()
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
    replay_jsonl_logs(
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

    # Placeholder publish function (replaced when MQTT subscriber starts)
    async def _noop_publish(topic: str, payload: bytes) -> None:
        raise ConnectionError(
            "MQTT broker unavailable. Run 'claude-comms start' to start the daemon."
        )

    _publish_fn = _noop_publish

    # ------------------------------------------------------------------
    # Register tools
    # ------------------------------------------------------------------

    @mcp.tool()
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
    ) -> dict[str, Any]:
        """Join a conversation. Returns your participant key. Call with name on first use; key on subsequent calls."""
        result = await tool_comms_join(
            _get_registry(), key=key, conversation=conversation, name=name,
            publish_fn=_publish_fn,
            conv_data_dir=_get_conv_data_dir(),
        )
        # Publish presence so TUI/web clients see this participant.
        # Publishes to both conv-scoped and system-scoped topics to
        # match the Web UI's dual-presence pattern.
        if not result.get("error") and _publish_fn:
            import json as _json
            import asyncio as _asyncio
            from claude_comms.message import now_iso as _now_iso

            _ts = _now_iso()
            presence_payload = _json.dumps(
                {
                    "key": result["key"],
                    "name": result["name"],
                    "type": result["type"],
                    "status": "online",
                    "client": "mcp",
                    "ts": _ts,
                }
            ).encode()
            presence_topic = (
                f"claude-comms/conv/{conversation}/presence/{result['key']}"
            )
            system_topic = f"claude-comms/system/participants/{result['key']}-mcp"
            try:
                loop = _asyncio.get_event_loop()
                loop.create_task(_publish_fn(presence_topic, presence_payload))
                loop.create_task(_publish_fn(system_topic, presence_payload))
            except Exception:
                pass  # Non-critical — presence is best-effort
        if not result.get("error"):
            _touch(result.get("key"))
        return result

    @mcp.tool()
    def comms_leave(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to leave")],
    ) -> dict[str, Any]:
        """Leave a conversation."""
        return tool_comms_leave(_get_registry(), key=key, conversation=conversation)

    @mcp.tool()
    async def comms_send(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        message: Annotated[str, Field(description="Message text to send")],
        recipients: Annotated[
            list[str] | None,
            Field(description="Target names or keys (null = broadcast)"),
        ] = None,
    ) -> dict[str, Any]:
        """Send a message to a conversation. Optionally target specific recipients by name or key."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        return await tool_comms_send(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            message=message,
            recipients=recipients,
        )

    @mcp.tool()
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
    ) -> dict[str, Any]:
        """Read recent messages from a conversation. Supports pagination via 'since' parameter."""
        _touch(key)
        return tool_comms_read(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
            count=count,
            since=since,
        )

    @mcp.tool()
    def comms_check(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[
            str | None,
            Field(description="Check specific conversation (null = all)"),
        ] = None,
    ) -> dict[str, Any]:
        """Check for unread messages across conversations."""
        _touch(key)
        return tool_comms_check(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
        )

    @mcp.tool()
    def comms_members(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to list")],
    ) -> dict[str, Any]:
        """List current participants in a conversation."""
        _touch(key)
        return tool_comms_members(_get_registry(), key=key, conversation=conversation)

    @mcp.tool()
    def comms_conversations(
        key: Annotated[str, Field(description="Your participant key")],
        all: Annotated[bool, Field(description="If true, list ALL conversations (not just joined)")] = False,
    ) -> dict[str, Any]:
        """List all conversations you have joined with unread counts. Use all=true to discover all conversations."""
        _touch(key)
        return tool_comms_conversations(
            _get_registry(), _get_store(), key=key,
            all=all, conv_data_dir=_get_conv_data_dir(),
        )

    @mcp.tool()
    def comms_update_name(
        key: Annotated[str, Field(description="Your participant key")],
        new_name: Annotated[str, Field(description="New display name")],
    ) -> dict[str, Any]:
        """Change your display name. Your key remains the same."""
        _touch(key)
        return tool_comms_update_name(_get_registry(), key=key, new_name=new_name)

    @mcp.tool()
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
    ) -> dict[str, Any]:
        """Search message history by text content or sender name."""
        _touch(key)
        return tool_comms_history(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
            query=query,
            count=count,
        )

    @mcp.tool()
    async def comms_artifact_create(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[str, Field(description="Artifact slug (lowercase, hyphens, e.g. 'backend-plan')")],
        title: Annotated[str, Field(description="Human-readable title")],
        type: Annotated[str, Field(description="Artifact type: plan, doc, or code")],
        content: Annotated[str, Field(description="Initial content (markdown, code, etc.)")],
    ) -> dict[str, Any]:
        """Create a new collaborative artifact in a conversation. Returns artifact metadata."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        return await tool_comms_artifact_create(
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

    @mcp.tool()
    async def comms_artifact_update(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[str, Field(description="Artifact slug to update")],
        content: Annotated[str, Field(description="New content (full replacement)")],
        summary: Annotated[str, Field(description="Brief description of changes")] = "",
        base_version: Annotated[int | None, Field(description="Expected current version for concurrency check (optional)")] = None,
    ) -> dict[str, Any]:
        """Update an artifact with new content. Optionally check base_version for concurrency safety."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        return await tool_comms_artifact_update(
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

    @mcp.tool()
    async def comms_artifact_delete(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[str, Field(description="Artifact slug to delete")],
    ) -> dict[str, Any]:
        """Delete an artifact and all its versions from a conversation."""
        _touch(key)
        assert _publish_fn is not None, "Publish function not initialised"
        return await tool_comms_artifact_delete(
            _get_registry(),
            _publish_fn,
            key=key,
            conversation=conversation,
            name=name,
            data_dir=_get_data_dir(),
        )

    @mcp.tool()
    def comms_artifact_get(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
        name: Annotated[str, Field(description="Artifact slug to read")],
        version: Annotated[int | None, Field(description="Specific version number (default: latest)")] = None,
        offset: Annotated[int, Field(description="Character offset for chunked reading (default: 0)")] = 0,
        limit: Annotated[int | None, Field(description="Max characters to return (default: 50000)")] = None,
    ) -> dict[str, Any]:
        """Read an artifact's content with optional chunked pagination. Returns content chunk + version metadata."""
        _touch(key)
        return tool_comms_artifact_get(
            _get_registry(),
            key=key,
            conversation=conversation,
            name=name,
            version=version,
            offset=offset,
            limit=limit,
            data_dir=_get_data_dir(),
        )

    @mcp.tool()
    def comms_artifact_list(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Target conversation")],
    ) -> dict[str, Any]:
        """List all artifacts in a conversation with summary metadata (no content)."""
        _touch(key)
        return tool_comms_artifact_list(
            _get_registry(),
            key=key,
            conversation=conversation,
            data_dir=_get_data_dir(),
        )

    # -- Conversation discovery tools --

    @mcp.tool()
    async def comms_conversation_create(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="New conversation slug (lowercase, hyphens)")],
        topic: Annotated[str, Field(description="Conversation topic/description")] = "",
    ) -> dict[str, Any]:
        """Create a new conversation with optional topic. Auto-joins you and all human participants."""
        _touch(key)
        assert _publish_fn is not None
        return await tool_comms_conversation_create(
            _get_registry(), _publish_fn,
            key=key, conversation=conversation, topic=topic,
            conv_data_dir=_get_conv_data_dir(),
        )

    @mcp.tool()
    async def comms_conversation_update(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to update")],
        topic: Annotated[str, Field(description="New topic/description")],
    ) -> dict[str, Any]:
        """Update a conversation's topic. System message rate-limited to 1/min."""
        _touch(key)
        assert _publish_fn is not None
        return await tool_comms_conversation_update(
            _get_registry(), _publish_fn,
            key=key, conversation=conversation, topic=topic,
            conv_data_dir=_get_conv_data_dir(),
            rate_limit_state=_topic_rate_limit,
        )

    @mcp.tool()
    async def comms_invite(
        key: Annotated[str, Field(description="Your participant key")],
        conversation: Annotated[str, Field(description="Conversation to invite to")],
        target_name: Annotated[str, Field(description="Name of participant to invite")],
        message: Annotated[str, Field(description="Optional invite message")] = "",
    ) -> dict[str, Any]:
        """Invite a participant to a conversation. Posts invite notification in #general."""
        _touch(key)
        assert _publish_fn is not None
        return await tool_comms_invite(
            _get_registry(), _publish_fn,
            key=key, conversation=conversation, target_name=target_name, message=message,
            conv_data_dir=_get_conv_data_dir(),
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
        sub_task = asyncio.create_task(
            _mqtt_subscriber(broker_host, broker_port, _store, _deduplicator)
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

                async def _do_publish(topic: str, payload: bytes, retain: bool = False) -> None:
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
            sub_task.cancel()
            try:
                await sub_task
            except asyncio.CancelledError:
                pass

    asyncio.run(_run())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    start_server()
