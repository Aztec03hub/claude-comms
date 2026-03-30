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
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from claude_comms.broker import MessageDeduplicator, MessageStore, replay_jsonl_logs
from claude_comms.config import load_config
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    PublishFn,
    tool_comms_check,
    tool_comms_conversations,
    tool_comms_history,
    tool_comms_join,
    tool_comms_leave,
    tool_comms_members,
    tool_comms_read,
    tool_comms_send,
    tool_comms_update_name,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared state  (module-level singletons, initialised in ``create_server``)
# ---------------------------------------------------------------------------

_registry: ParticipantRegistry | None = None
_store: MessageStore | None = None
_deduplicator: MessageDeduplicator | None = None
_publish_fn: PublishFn | None = None
_config: dict[str, Any] | None = None


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
            "client": "mcp",
            "status": "online",
        }
        for m in members
    ]


# ---------------------------------------------------------------------------
# MQTT subscriber background task
# ---------------------------------------------------------------------------


async def _mqtt_subscriber(
    host: str,
    port: int,
    store: MessageStore,
    deduplicator: MessageDeduplicator,
) -> None:
    """Subscribe to all conversation messages and feed them into the store.

    Runs as a long-lived background task.  Reconnects on failure.
    """
    import aiomqtt

    from claude_comms.broker import generate_client_id

    client_id = generate_client_id("mcp", "00000000")
    topic = "claude-comms/conv/+/messages"

    while True:
        try:
            async with aiomqtt.Client(
                hostname=host,
                port=port,
                identifier=client_id,
            ) as client:
                await client.subscribe(topic, qos=1)
                logger.info("MCP subscriber connected to %s:%d", host, port)
                async for mqtt_msg in client.messages:
                    try:
                        payload = (
                            mqtt_msg.payload.decode("utf-8")
                            if isinstance(mqtt_msg.payload, bytes)
                            else str(mqtt_msg.payload)
                        )
                        msg = json.loads(payload)
                        msg_id = msg.get("id", "")
                        conv_id = msg.get("conv", "")
                        if not msg_id or not conv_id:
                            continue
                        if deduplicator.is_duplicate(msg_id):
                            continue
                        store.add(conv_id, msg)
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
    global _registry, _store, _deduplicator, _publish_fn, _config

    if config is None:
        config = load_config()
    _config = config

    mcp_cfg = config.get("mcp", {})
    host = mcp_cfg.get("host", "127.0.0.1")
    port = mcp_cfg.get("port", 9920)

    # Shared state
    _registry = ParticipantRegistry()
    _deduplicator = MessageDeduplicator()
    _store = MessageStore()

    # Replay JSONL logs
    logging_cfg = config.get("logging", {})
    log_dir = logging_cfg.get("dir", "~/.claude-comms/logs")
    from pathlib import Path

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
    def comms_join(
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
        result = tool_comms_join(
            _get_registry(), key=key, conversation=conversation, name=name
        )
        # Publish presence so TUI/web clients see this participant.
        # Publishes to both conv-scoped and system-scoped topics to
        # match the Web UI's dual-presence pattern.
        if not result.get("error") and _publish_fn:
            import json as _json
            import asyncio as _asyncio
            from claude_comms.message import now_iso as _now_iso
            _ts = _now_iso()
            presence_payload = _json.dumps({
                "key": result["key"],
                "name": result["name"],
                "type": result["type"],
                "status": "online",
                "client": "mcp",
                "ts": _ts,
            }).encode()
            presence_topic = f"claude-comms/conv/{conversation}/presence/{result['key']}"
            system_topic = f"claude-comms/system/participants/{result['key']}-mcp"
            try:
                loop = _asyncio.get_event_loop()
                loop.create_task(_publish_fn(presence_topic, presence_payload))
                loop.create_task(_publish_fn(system_topic, presence_payload))
            except Exception:
                pass  # Non-critical — presence is best-effort
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
        return tool_comms_members(
            _get_registry(), key=key, conversation=conversation
        )

    @mcp.tool()
    def comms_conversations(
        key: Annotated[str, Field(description="Your participant key")],
    ) -> dict[str, Any]:
        """List all conversations you have joined with unread counts."""
        return tool_comms_conversations(
            _get_registry(), _get_store(), key=key
        )

    @mcp.tool()
    def comms_update_name(
        key: Annotated[str, Field(description="Your participant key")],
        new_name: Annotated[str, Field(description="New display name")],
    ) -> dict[str, Any]:
        """Change your display name. Your key remains the same."""
        return tool_comms_update_name(
            _get_registry(), key=key, new_name=new_name
        )

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
        return tool_comms_history(
            _get_registry(),
            _get_store(),
            key=key,
            conversation=conversation,
            query=query,
            count=count,
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

                async def _do_publish(topic: str, payload: bytes) -> None:
                    await pub_client.publish(topic, payload, qos=1)

                _publish_fn = _do_publish
                logger.info("MCP publish client connected to broker")

                # Run the MCP server (blocks until shutdown)
                mcp_cfg = config.get("mcp", {})
                host = mcp_cfg.get("host", "127.0.0.1")
                port = mcp_cfg.get("port", 9920)
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
