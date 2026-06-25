"""Resilient MQTT publish client for the MCP daemon.

The daemon keeps a single long-lived ``aiomqtt.Client`` for every publish-based
MCP tool (``comms_send`` and friends). Historically the publish was a bare
``await pub_client.publish(topic, payload, qos=1, retain=...)`` with no timeout
and no reconnect handling. With ``qos=1`` that await blocks until the broker
returns a PUBACK. If the PUBACK stalls, or the persistent client's connection
to the embedded broker has silently dropped (and is not reconnecting), the
await hangs forever -> the MCP tool call spins indefinitely -> the
orchestrator's console is blocked, even though the message was already
broadcast to subscribers (qos1 delivery to subscribers precedes the
publisher's ack).

``ResilientPublisher`` wraps that single client and guarantees the publish
call always returns within a bounded time:

* Every publish is wrapped in ``asyncio.wait_for(..., timeout)``.
* On timeout or :class:`aiomqtt.MqttError`, the client is re-established
  (proper ``__aexit__`` then a fresh client from the factory) under an
  ``asyncio.Lock`` so concurrent publishers do not reconnect simultaneously,
  and the publish is retried exactly once.
* The happy path is unchanged: a normal publish still completes with
  ``qos=1`` + ``retain`` intact.

Concurrency note: ``aiomqtt.Client.publish`` is safe to call concurrently on a
single client (each in-flight qos1 publish waits on its own per-message-id
event), so steady-state publishes are *not* serialized here. The lock only
guards the reconnect/swap so a single dropped connection is healed once rather
than by every concurrent caller, and so a publisher never keeps using a client
that another caller has already torn down.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Callable

import aiomqtt

if TYPE_CHECKING:
    from aiomqtt import Client

logger = logging.getLogger(__name__)

# Bounded wait for a single publish (and for connect/teardown during a
# reconnect). Comfortably above a healthy broker's PUBACK round-trip, low
# enough that a stalled publish unblocks the MCP tool call in seconds rather
# than never.
DEFAULT_PUBLISH_TIMEOUT = 10.0


class ResilientPublisher:
    """A single long-lived MQTT publish client with timeout + reconnect-once.

    Parameters
    ----------
    client_factory:
        Zero-arg callable returning a *fresh, not-yet-entered*
        ``aiomqtt.Client``. Called once at :meth:`start` and again on every
        reconnect, so it must hand back a usable client each time (e.g. with a
        freshly generated client id to avoid broker-side id collisions).
    timeout:
        Per-operation bound, in seconds, for publish / connect / teardown.
    """

    def __init__(
        self,
        client_factory: Callable[[], Client],
        timeout: float = DEFAULT_PUBLISH_TIMEOUT,
    ) -> None:
        self._factory: Callable[[], Client] = client_factory
        self._timeout: float = timeout
        self._client: Client | None = None
        # Guards reconnect/swap only - NOT the steady-state publish.
        self._reconnect_lock: asyncio.Lock = asyncio.Lock()

    async def start(self) -> None:
        """Create and connect the initial client. Idempotent-safe to call once."""
        client = self._factory()
        _ = await asyncio.wait_for(client.__aenter__(), timeout=self._timeout)
        self._client = client

    async def stop(self) -> None:
        """Tear down the current client (bounded, never hangs shutdown)."""
        client = self._client
        self._client = None
        if client is None:
            return
        try:
            _ = await asyncio.wait_for(
                client.__aexit__(None, None, None), timeout=self._timeout
            )
        except Exception:
            logger.warning("Error while closing MQTT publish client", exc_info=True)

    async def publish(self, topic: str, payload: bytes, retain: bool = False) -> None:
        """Publish with a bounded timeout and one reconnect-and-retry on failure.

        Preserves the historical ``_do_publish`` signature so existing call
        sites (``tool_comms_send``, presence, profile-status expiry, etc.) are
        unchanged. Always returns or raises within roughly ``2 * timeout`` -
        it never hangs indefinitely.
        """
        client = self._client
        if client is None:
            raise RuntimeError("ResilientPublisher.start() was not called")

        try:
            await asyncio.wait_for(
                client.publish(topic, payload, qos=1, retain=retain),
                timeout=self._timeout,
            )
            return
        except (asyncio.TimeoutError, aiomqtt.MqttError) as first_err:
            logger.warning(
                "MQTT publish to %s failed (%r); reconnecting and retrying once",
                topic,
                first_err,
            )

        new_client = await self._reconnect(failed_client=client)

        try:
            await asyncio.wait_for(
                new_client.publish(topic, payload, qos=1, retain=retain),
                timeout=self._timeout,
            )
        except asyncio.TimeoutError:
            # The first attempt almost certainly already broadcast the message
            # to subscribers (qos1 delivery precedes the publisher's ack); the
            # ack just never came back. Returning here keeps the MCP tool call
            # from hanging. Worst case the caller sees a delivered message with
            # an unconfirmed ack rather than an infinite spin.
            msg = (
                "MQTT publish retry to %s timed out; message was likely already "
                + "broadcast - returning to avoid blocking the caller"
            )
            logger.warning(msg, topic)
            return
        except aiomqtt.MqttError:
            # Genuine broker failure even after reconnect: surface it so the
            # caller's existing error path runs (e.g. tool_comms_send returns
            # its "ensure the broker is running" error).
            logger.exception("MQTT publish retry to %s failed after reconnect", topic)
            raise

    async def _reconnect(self, failed_client: Client) -> Client:
        """Replace ``failed_client`` with a fresh connected client, once.

        Guarded by a lock so concurrent publishers that all hit the same dead
        connection only rebuild it a single time; later arrivals observe the
        already-swapped client and reuse it.
        """
        async with self._reconnect_lock:
            # Another publisher may have already healed the connection while we
            # waited on the lock.
            if self._client is not None and self._client is not failed_client:
                return self._client

            try:
                _ = await asyncio.wait_for(
                    failed_client.__aexit__(None, None, None), timeout=self._timeout
                )
            except Exception:
                logger.warning(
                    "Error tearing down stale MQTT publish client before reconnect",
                    exc_info=True,
                )

            new_client = self._factory()
            _ = await asyncio.wait_for(new_client.__aenter__(), timeout=self._timeout)
            self._client = new_client
            return new_client
