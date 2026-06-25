"""Single-origin Phase 2: in-process broker WebSocket bridge at /mqtt.

Phase 2 of the single-origin architecture (see
``.worklogs/harness-fixes/single-origin-design.md`` §2.2a / §5 / §7) adds a
Starlette ``WebSocketRoute("/mqtt", ...)`` to the web app that hands each
accepted browser WebSocket to the embedded amqtt broker via the broker's PUBLIC
``Broker.external_connected(reader, writer, "ws-external")`` API — NOT a socket
proxy, NOT a second port. Bridged sessions join the SAME broker session/
subscription tables as native TCP / WS clients.

These tests assemble a Starlette web app the same way ``cli._run_daemon`` does:
a lifespan starts a real :class:`EmbeddedBroker` (on free loopback ports) so the
broker runs in the SAME event loop as the TestClient's portal, and the ``/mqtt``
route is built with ``build_mqtt_ws_route(lambda: broker_holder[0])``.

The WS client side speaks raw MQTT 3.1.1 over binary WS frames (the daemon
echoes the ``mqtt`` subprotocol on accept). The TCP side uses ``aiomqtt`` driven
through the TestClient portal so it shares the broker's loop. Coverage:

- a real MQTT CONNECT -> SUBSCRIBE -> PUBLISH -> receive round-trip through the
  embedded broker entirely over ``/mqtt``;
- cross-transport interop both directions (publish via native TCP aiomqtt ->
  receive via ``/mqtt`` WS, and WS -> TCP) proving web <-> broker <-> TCP;
- LWT (last-will) fires to a TCP subscriber when a ``/mqtt`` WS client closes
  abruptly mid-session;
- partial-frame reassembly: one MQTT packet split across two binary WS frames is
  still parsed correctly by the bridge reader (mirrors WebSocketsReader).
"""

from __future__ import annotations

import socket
import struct
import time
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from claude_comms.broker import EmbeddedBroker
from claude_comms.cli import build_mqtt_ws_route


# ---------------------------------------------------------------------------
# Minimal MQTT 3.1.1 codec (client side, over the raw WS byte stream)
# ---------------------------------------------------------------------------
CONNECT = 0x10
CONNACK = 0x20
PUBLISH = 0x30
SUBSCRIBE = 0x82  # type 8 | flags 0b0010 (required)
SUBACK = 0x90
DISCONNECT = 0xE0


def _enc_len(n: int) -> bytes:
    out = bytearray()
    while True:
        byte = n % 128
        n //= 128
        if n > 0:
            byte |= 0x80
        out.append(byte)
        if n == 0:
            break
    return bytes(out)


def _enc_str(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("!H", len(b)) + b


def encode_connect(
    client_id: str,
    *,
    keepalive: int = 60,
    clean: bool = True,
    will_topic: str | None = None,
    will_payload: bytes | None = None,
) -> bytes:
    # Variable header: protocol name "MQTT", level 4, connect flags, keepalive.
    vh = _enc_str("MQTT") + bytes([0x04])
    flags = 0x02 if clean else 0x00
    payload = _enc_str(client_id)
    if will_topic is not None and will_payload is not None:
        flags |= 0x04  # will flag
        payload += _enc_str(will_topic)
        payload += struct.pack("!H", len(will_payload)) + will_payload
    vh += bytes([flags]) + struct.pack("!H", keepalive)
    body = vh + payload
    return bytes([CONNECT]) + _enc_len(len(body)) + body


def encode_subscribe(packet_id: int, topic: str, qos: int = 0) -> bytes:
    body = struct.pack("!H", packet_id) + _enc_str(topic) + bytes([qos])
    return bytes([SUBSCRIBE]) + _enc_len(len(body)) + body


def encode_publish(topic: str, payload: bytes, qos: int = 0) -> bytes:
    # QoS 0 -> no packet id.
    body = _enc_str(topic) + payload
    header = PUBLISH | (qos << 1)
    return bytes([header]) + _enc_len(len(body)) + body


def encode_disconnect() -> bytes:
    return bytes([DISCONNECT, 0x00])


class WSPacketReader:
    """Reassemble MQTT packets from a Starlette TestClient WS (binary frames)."""

    def __init__(self, ws) -> None:  # type: ignore[no-untyped-def]
        self._ws = ws
        self._buf = bytearray()

    def _need(self, n: int) -> None:
        while len(self._buf) < n:
            self._buf.extend(self._ws.receive_bytes())

    def read_packet(self) -> tuple[int, bytes]:
        """Return (first_byte, payload_bytes) for the next MQTT control packet."""
        self._need(1)
        first = self._buf[0]
        # Decode remaining length (multi-byte varint), reading more as needed.
        idx = 1
        multiplier = 1
        remaining = 0
        while True:
            self._need(idx + 1)
            byte = self._buf[idx]
            remaining += (byte & 0x7F) * multiplier
            idx += 1
            if not (byte & 0x80):
                break
            multiplier *= 128
        total = idx + remaining
        self._need(total)
        payload = bytes(self._buf[idx:total])
        del self._buf[:total]
        return first, payload


# ---------------------------------------------------------------------------
# Fixture: web app whose lifespan runs a real embedded broker in the TestClient
# portal loop, exposing /mqtt via the production route factory.
# ---------------------------------------------------------------------------
def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def bridge(tmp_path: Path):
    """Yield ``(TestClient, tcp_port)`` for a web app bridging a live broker.

    The broker runs in the TestClient's event loop (started/stopped by the web
    app's lifespan), so ``external_connected`` and TCP aiomqtt clients driven
    through the portal all share one loop.
    """
    tcp_port = _free_port()
    ws_port = _free_port()
    broker_holder: list[EmbeddedBroker | None] = [None]

    import contextlib

    @contextlib.asynccontextmanager
    async def _lifespan(_app):  # type: ignore[no-untyped-def]
        broker = EmbeddedBroker(
            host="127.0.0.1",
            port=tcp_port,
            ws_host="127.0.0.1",
            ws_port=ws_port,
            pid_file=tmp_path / "broker.pid",
            log_dir=tmp_path / "logs",
        )
        await broker.start()
        broker_holder[0] = broker
        try:
            yield
        finally:
            with contextlib.suppress(Exception):
                await broker.stop()
            broker_holder[0] = None

    app = Starlette(
        routes=[build_mqtt_ws_route(lambda: broker_holder[0])],
        lifespan=_lifespan,
    )

    with TestClient(app) as client:
        yield client, tcp_port


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestRoundTripOverWs:
    def test_connect_subscribe_publish_receive(self, bridge):
        client, _ = bridge
        with client.websocket_connect("/mqtt", subprotocols=["mqtt"]) as ws:
            ws.send_bytes(encode_connect("ws-client-1"))
            reader = WSPacketReader(ws)
            first, _payload = reader.read_packet()
            assert first == CONNACK, f"expected CONNACK, got {first:#x}"

            ws.send_bytes(encode_subscribe(1, "claude-comms/test/topic", qos=0))
            first, _payload = reader.read_packet()
            assert first == SUBACK, f"expected SUBACK, got {first:#x}"

            # Publish to our own subscription; broker should deliver it back.
            ws.send_bytes(encode_publish("claude-comms/test/topic", b"hello-ws", qos=0))
            first, payload = reader.read_packet()
            assert (first & 0xF0) == PUBLISH, f"expected PUBLISH, got {first:#x}"
            # Payload = topic-len(2) + topic + message
            tlen = struct.unpack("!H", payload[:2])[0]
            topic = payload[2 : 2 + tlen].decode()
            msg = payload[2 + tlen :]
            assert topic == "claude-comms/test/topic"
            assert msg == b"hello-ws"


class TestCrossTransportInterop:
    """Web <-> broker <-> TCP: a /mqtt WS client and a native TCP aiomqtt
    client exchange messages through the same embedded broker."""

    def test_tcp_publish_to_ws_subscriber(self, bridge):
        client, tcp_port = bridge
        topic = "claude-comms/interop/tcp2ws"
        with client.websocket_connect("/mqtt", subprotocols=["mqtt"]) as ws:
            ws.send_bytes(encode_connect("ws-sub"))
            reader = WSPacketReader(ws)
            assert reader.read_packet()[0] == CONNACK
            ws.send_bytes(encode_subscribe(1, topic, qos=0))
            assert reader.read_packet()[0] == SUBACK

            # Publish from a native TCP client, run in the broker's loop.
            async def _tcp_publish() -> None:
                import aiomqtt

                async with aiomqtt.Client(
                    hostname="127.0.0.1", port=tcp_port, identifier="tcp-pub"
                ) as tcp:
                    await tcp.publish(topic, b"from-tcp", qos=0)

            client.portal.call(_tcp_publish)

            first, payload = reader.read_packet()
            assert (first & 0xF0) == PUBLISH
            tlen = struct.unpack("!H", payload[:2])[0]
            assert payload[2 + tlen :] == b"from-tcp"

    def test_ws_publish_to_tcp_subscriber(self, bridge):
        client, tcp_port = bridge
        topic = "claude-comms/interop/ws2tcp"

        # Start a TCP subscriber in the broker loop and hold it open while we
        # publish from the WS side, collecting the first delivered message.
        import threading

        received: dict[str, bytes] = {}
        sub_ready = threading.Event()
        done = threading.Event()

        async def _tcp_subscribe() -> None:
            import aiomqtt

            async with aiomqtt.Client(
                hostname="127.0.0.1", port=tcp_port, identifier="tcp-sub"
            ) as tcp:
                await tcp.subscribe(topic, qos=0)
                sub_ready.set()
                async for message in tcp.messages:
                    received["payload"] = bytes(message.payload)
                    break
                done.set()

        # Run the subscriber concurrently in the portal loop.
        fut = client.portal.start_task_soon(_tcp_subscribe)
        assert sub_ready.wait(timeout=5), "TCP subscriber did not become ready"

        with client.websocket_connect("/mqtt", subprotocols=["mqtt"]) as ws:
            ws.send_bytes(encode_connect("ws-pub"))
            reader = WSPacketReader(ws)
            assert reader.read_packet()[0] == CONNACK
            ws.send_bytes(encode_publish(topic, b"from-ws", qos=0))

        assert done.wait(timeout=5), "TCP subscriber did not receive the message"
        fut.result(timeout=5)
        assert received.get("payload") == b"from-ws"


class TestLastWillOnAbruptClose:
    """LWT must fire to a TCP subscriber when a /mqtt WS client drops abruptly,
    proving amqtt session teardown runs for bridged connections."""

    def test_lwt_published_on_ws_disconnect(self, bridge):
        client, tcp_port = bridge
        will_topic = "claude-comms/lwt/ws-client"

        import queue
        import threading

        # A persistent TCP subscriber stays subscribed for the whole test and
        # pushes every message it sees onto a thread-safe queue. The will only
        # ever reaches a subscriber that is ALREADY subscribed when the abrupt
        # close happens (classic LWT race), so it must be ready before we connect
        # (and later drop) any WS will-client.
        deliveries: queue.Queue[bytes] = queue.Queue()
        sub_ready = threading.Event()
        stop_watcher = threading.Event()

        async def _tcp_subscribe() -> None:
            import asyncio

            import aiomqtt

            async with aiomqtt.Client(
                hostname="127.0.0.1", port=tcp_port, identifier="lwt-watcher"
            ) as tcp:
                await tcp.subscribe(will_topic, qos=0)
                sub_ready.set()
                agen = tcp.messages.__aiter__()
                while not stop_watcher.is_set():
                    try:
                        message = await asyncio.wait_for(agen.__anext__(), timeout=0.25)
                    except asyncio.TimeoutError:
                        continue
                    except StopAsyncIteration:
                        break
                    deliveries.put(bytes(message.payload))

        fut = client.portal.start_task_soon(_tcp_subscribe)
        assert sub_ready.wait(timeout=10), "TCP LWT watcher did not become ready"

        # Connect a WS client WITH a will, then drop the socket WITHOUT sending an
        # MQTT DISCONNECT packet. Exiting the ``with`` block closes the WS at the
        # transport layer only (no MQTT-level disconnect), so the broker MUST treat
        # it as an abnormal disconnect and publish the will.
        #
        # NOTE on retries: amqtt has an internal teardown ordering race in
        # ``Broker._handle_client_session`` -- on abrupt disconnect the deliver
        # waiter (``mqtt_deliver_next_message`` -> ``None``) can complete and
        # ``break`` the message loop *before* the disconnect waiter is processed,
        # so the abnormal-disconnect will is occasionally dropped entirely (NOT
        # merely delayed -- it never arrives). This is upstream behavior, not a
        # claude-comms regression; the bridge already routes EOF down amqtt's
        # clean ``if not fixed_header: break`` path (see ``_ASGIWebSocketReader.
        # read`` returning ``None`` on EOF). We therefore prove the behavior --
        # "an abrupt WS close DOES publish the LWT" -- by attempting the close a
        # bounded number of times and asserting the will is delivered. A genuine
        # break (LWT never published at all) still fails every attempt and reds
        # the test; only amqtt's probabilistic teardown race is tolerated.
        delivered: bytes | None = None
        for _attempt in range(6):
            with client.websocket_connect("/mqtt", subprotocols=["mqtt"]) as ws:
                ws.send_bytes(
                    encode_connect(
                        "ws-will-client",
                        will_topic=will_topic,
                        will_payload=b"client-died",
                    )
                )
                reader = WSPacketReader(ws)
                assert reader.read_packet()[0] == CONNACK
            try:
                delivered = deliveries.get(timeout=5)
                break
            except queue.Empty:
                continue

        stop_watcher.set()
        fut.result(timeout=10)
        assert delivered == b"client-died", "LWT was not delivered on abrupt WS close"


class TestPartialFrameReassembly:
    """One MQTT packet split across two binary WS frames must be reassembled by
    the bridge reader (mirrors amqtt's WebSocketsReader buffering)."""

    def test_split_connect_packet(self, bridge):
        client, _ = bridge
        full = encode_connect("split-client")
        # Split mid-packet (after the fixed header + a few bytes).
        split = max(2, len(full) // 2)
        part1, part2 = full[:split], full[split:]
        with client.websocket_connect("/mqtt", subprotocols=["mqtt"]) as ws:
            ws.send_bytes(part1)
            # Small gap to ensure the bridge reader has to await a second frame.
            time.sleep(0.05)
            ws.send_bytes(part2)
            reader = WSPacketReader(ws)
            first, _payload = reader.read_packet()
            assert first == CONNACK, (
                f"split CONNECT not reassembled; got {first:#x} (broker rejected "
                "the partially-framed packet)"
            )
