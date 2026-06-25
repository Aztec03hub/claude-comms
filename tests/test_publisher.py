"""Tests for ResilientPublisher: the hang-proof MCP publish path.

Regression coverage for the indefinite-publish-hang bug: a long-lived
aiomqtt client publishing with qos=1 and no timeout would block the MCP tool
call forever if a PUBACK stalled or the connection silently dropped.
"""

from __future__ import annotations

import asyncio

import aiomqtt
import pytest

from claude_comms.publisher import ResilientPublisher


class FakeClient:
    """Minimal stand-in for aiomqtt.Client with scriptable behaviour."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.entered = False
        self.exited = False
        self.published: list[tuple[str, bytes, int, bool]] = []
        # behaviour knobs
        self.publish_hangs = False
        self.publish_raises: BaseException | None = None

    async def __aenter__(self) -> "FakeClient":
        self.entered = True
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.exited = True

    async def publish(
        self, topic: str, payload: bytes, qos: int = 0, retain: bool = False
    ) -> None:
        if self.publish_hangs:
            await asyncio.Event().wait()  # never returns
        if self.publish_raises is not None:
            raise self.publish_raises
        self.published.append((topic, payload, qos, retain))


def _factory(clients: list[FakeClient]):
    """Return a factory that hands out the given clients in order."""
    it = iter(clients)

    def make() -> FakeClient:
        return next(it)

    return make


@pytest.mark.asyncio
async def test_publish_that_never_returns_does_not_hang() -> None:
    """A publish that never returns must unblock within the timeout, not hang."""
    hanging = FakeClient("hang")
    hanging.publish_hangs = True
    # Reconnect produces a second hanging client too, so the retry also times
    # out -> publisher must still return (message presumed broadcast).
    hanging2 = FakeClient("hang2")
    hanging2.publish_hangs = True

    pub = ResilientPublisher(_factory([hanging, hanging2]), timeout=0.1)
    await pub.start()

    # Outer guard with generous margin: if the publisher itself hangs, THIS
    # wait_for fires and the test fails loudly instead of hanging the suite.
    await asyncio.wait_for(pub.publish("t/topic", b"payload"), timeout=5.0)

    # It reconnected (tore down the stalled client, entered a fresh one).
    assert hanging.exited is True
    assert hanging2.entered is True


@pytest.mark.asyncio
async def test_mqtt_error_triggers_reconnect_and_retry_succeeds() -> None:
    """First publish raises MqttError -> reconnect to a healthy client + retry."""
    broken = FakeClient("broken")
    broken.publish_raises = aiomqtt.MqttError("connection lost")
    healthy = FakeClient("healthy")

    pub = ResilientPublisher(_factory([broken, healthy]), timeout=1.0)
    await pub.start()

    await pub.publish("t/topic", b"hello", retain=True)

    # Old client torn down, new client published successfully with qos=1+retain.
    assert broken.exited is True
    assert healthy.entered is True
    assert healthy.published == [("t/topic", b"hello", 1, True)]


@pytest.mark.asyncio
async def test_happy_path_publishes_with_qos1_and_retain() -> None:
    """Normal publish completes on the first try with qos=1 and retain intact."""
    client = FakeClient("ok")
    pub = ResilientPublisher(_factory([client]), timeout=1.0)
    await pub.start()

    await pub.publish("a/b", b"data")
    await pub.publish("c/d", b"more", retain=True)

    assert client.published == [
        ("a/b", b"data", 1, False),
        ("c/d", b"more", 1, True),
    ]
    # No reconnect happened on the happy path.
    assert client.exited is False


@pytest.mark.asyncio
async def test_retry_mqtt_error_propagates() -> None:
    """If reconnect+retry still hits MqttError, raise so caller error path runs."""
    broken1 = FakeClient("broken1")
    broken1.publish_raises = aiomqtt.MqttError("down")
    broken2 = FakeClient("broken2")
    broken2.publish_raises = aiomqtt.MqttError("still down")

    pub = ResilientPublisher(_factory([broken1, broken2]), timeout=1.0)
    await pub.start()

    with pytest.raises(aiomqtt.MqttError):
        await pub.publish("t", b"x")


@pytest.mark.asyncio
async def test_concurrent_failure_reconnects_once() -> None:
    """Concurrent publishers hitting one dead connection rebuild it only once."""
    broken = FakeClient("broken")
    broken.publish_raises = aiomqtt.MqttError("dropped")
    healthy = FakeClient("healthy")
    extra = FakeClient("extra")  # must NOT be consumed

    pub = ResilientPublisher(_factory([broken, healthy, extra]), timeout=1.0)
    await pub.start()

    await asyncio.gather(
        pub.publish("t/1", b"a"),
        pub.publish("t/2", b"b"),
        pub.publish("t/3", b"c"),
    )

    # Exactly one reconnect: the single healthy client served all retries.
    assert healthy.entered is True
    assert extra.entered is False
    assert len(healthy.published) == 3


@pytest.mark.asyncio
async def test_stop_with_hanging_teardown_does_not_hang() -> None:
    """stop() is bounded even if the client's __aexit__ would stall."""

    class HangingExit(FakeClient):
        async def __aexit__(self, *exc: object) -> None:
            await asyncio.Event().wait()

    client = HangingExit("hangexit")
    pub = ResilientPublisher(_factory([client]), timeout=0.1)
    await pub.start()

    await asyncio.wait_for(pub.stop(), timeout=5.0)
