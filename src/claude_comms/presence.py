"""TTL-based presence manager for claude-comms participant connections.

This module complements MQTT Last Will and Testament (LWT) for clients that
cannot maintain a persistent MQTT session.  In particular, MCP participants
speak to the server over stateless HTTP and therefore have no LWT to fire
when they go away.  Without a server-side liveness check, their connection
entries would linger forever in the registry and show up as "online" in the
UI long after the agent process has exited.

The :class:`PresenceManager` periodically sweeps the
:class:`~claude_comms.mcp_tools.ParticipantRegistry` and expires connection
records whose ``last_seen`` timestamp is older than a configurable TTL.  It
relies on callers (e.g. the MCP tool layer) to invoke :meth:`touch` on every
participant interaction so that active connections stay fresh.

Expired connections can optionally be announced by publishing an empty
retained payload to the connection's presence topic, clearing any previously
retained "online" state on the MQTT broker.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Protocol

from claude_comms.mcp_tools import ParticipantRegistry
from claude_comms.message import now_iso


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_CONNECTION_TTL_SECONDS = 180  # 3 min
DEFAULT_SWEEP_INTERVAL_SECONDS = 30


# ---------------------------------------------------------------------------
# Publish callback protocol
# ---------------------------------------------------------------------------


class PublishFn(Protocol):
    """Async callable that publishes a payload to an MQTT topic.

    The ``retain`` keyword argument is optional so existing callers that pass
    just ``(topic, payload)`` still satisfy the protocol.
    """

    async def __call__(
        self, topic: str, payload: bytes, retain: bool = False
    ) -> None: ...


# ---------------------------------------------------------------------------
# PresenceManager
# ---------------------------------------------------------------------------


class PresenceManager:
    """Periodic TTL-based cleanup of stale participant connections.

    The manager owns a single background asyncio task that wakes up every
    ``sweep_interval_seconds`` and removes connection entries whose
    ``last_seen`` is older than ``ttl_seconds``.

    Note:
        :meth:`touch` mutates :class:`~claude_comms.participant.ConnectionInfo`
        fields directly.  This is safe today because ``ConnectionInfo`` is a
        standard (non-frozen) Pydantic model.  If the model is ever frozen
        (``model_config = ConfigDict(frozen=True)``), this code will need to
        construct a new ``ConnectionInfo`` and reassign it into
        ``p.connections[conn_key]``.
    """

    def __init__(
        self,
        registry: ParticipantRegistry,
        publish_fn: PublishFn | None = None,
        ttl_seconds: int = DEFAULT_CONNECTION_TTL_SECONDS,
        sweep_interval_seconds: int = DEFAULT_SWEEP_INTERVAL_SECONDS,
    ) -> None:
        self._registry = registry
        self._publish_fn: PublishFn | None = publish_fn
        self._ttl_seconds = ttl_seconds
        self._sweep_interval = sweep_interval_seconds
        self._task: asyncio.Task[None] | None = None

    # -- Public API --------------------------------------------------------

    def touch(self, key: str) -> None:
        """Mark every active connection of *key* as just-seen.

        Silently returns if the participant is not registered.  Direct
        mutation of ``ConnectionInfo.last_seen`` is safe because the model
        is not frozen; we do not take the registry lock because we are not
        mutating the registry's own dicts — only fields on objects already
        referenced by it.
        """
        p = self._registry.get(key)
        if p is None:
            return
        ts = now_iso()
        for conn in p.connections.values():
            conn.last_seen = ts

    def set_publish_fn(self, publish_fn: PublishFn) -> None:
        """Attach or replace the MQTT publish callback.

        Useful because the aiomqtt client that backs the publish function
        is typically only available after the caller has connected to the
        broker, whereas the :class:`PresenceManager` is usually constructed
        earlier during daemon startup.
        """
        self._publish_fn = publish_fn

    def start(self) -> None:
        """Start the background sweep task if it is not already running."""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._run())
        logger.info(
            "Presence TTL sweep started (ttl=%ss, interval=%ss)",
            self._ttl_seconds,
            self._sweep_interval,
        )

    async def stop(self) -> None:
        """Cancel the background sweep task and wait for it to exit."""
        task = self._task
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Presence sweep task raised during shutdown")
        finally:
            self._task = None
        logger.info("Presence TTL sweep stopped")

    async def flush_all_offline(self) -> None:
        """Publish empty retained presence for every known connection.

        Intended for graceful shutdown: clears retained MQTT presence so
        that the next daemon start does not observe stale "online" state.
        """
        # Snapshot the registry so we can safely iterate while other
        # coroutines may mutate it.
        participants = list(self._registry._participants.items())
        for key, p in participants:
            for conn_key in list(p.connections.keys()):
                await self._publish_offline(key, conn_key)

    # -- Internals ---------------------------------------------------------

    async def _sweep_once(self) -> list[tuple[str, str]]:
        """Expire stale connections and return ``[(key, conn_key), ...]``.

        Does NOT publish offline presence — the caller is responsible for
        that so the sweep logic stays testable in isolation.
        """
        removed: list[tuple[str, str]] = []
        now = datetime.now(timezone.utc).astimezone()

        # Snapshot for safety: registry mutations can happen concurrently.
        for key, p in list(self._registry._participants.items()):
            for conn_key, conn in list(p.connections.items()):
                try:
                    last_seen = datetime.fromisoformat(conn.last_seen)
                except (ValueError, TypeError):
                    # Unparseable timestamp — skip rather than expire, so a
                    # bad record never causes us to drop a live connection.
                    continue
                age = (now - last_seen).total_seconds()
                if age > self._ttl_seconds:
                    p.connections.pop(conn_key, None)
                    removed.append((key, conn_key))
        return removed

    async def _run(self) -> None:
        """Background loop: sweep, publish offline, sleep, repeat."""
        while True:
            try:
                removed = await self._sweep_once()
                for key, conn_key in removed:
                    await self._publish_offline(key, conn_key)
                    logger.info(
                        "Expired stale connection %s for %s", conn_key, key
                    )
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("Presence sweep error")
            await asyncio.sleep(self._sweep_interval)

    async def _publish_offline(self, key: str, conn_key: str) -> None:
        """Clear retained presence for a single connection.

        Publishes an empty, retained payload to the new-style presence
        topic ``claude-comms/presence/{key}/{conn_key}``.  Failures are
        logged but never propagated — a broker hiccup must not abort the
        sweep loop.
        """
        if self._publish_fn is None:
            return
        topic = f"claude-comms/presence/{key}/{conn_key}"
        try:
            await self._publish_fn(topic, b"", retain=True)
        except Exception:
            logger.exception(
                "Failed to publish offline presence for %s/%s", key, conn_key
            )
