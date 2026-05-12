"""
Regression tests for ``publish_conversation_event`` (Bug B from the
v0.3.1 follow-up brief).

Pre-v0.3.2 behavior: conversation creates / topic changes / deletes
were only discoverable via the REST ``/api/conversations`` snapshot at
page bootstrap. A new conversation created by another participant did
not appear in connected browsers' sidebars until F5.

These tests pin that the helper:

1. Publishes to the single ``claude-comms/system/conversations`` topic
2. Encodes the event type as the payload's ``type`` field
3. Includes the canonical fields the web UI's
   ``#handleSystemConversation`` switches on
4. Swallows publish-side exceptions (best-effort -- REST is still
   authoritative on page bootstrap)
"""

from __future__ import annotations

import json

import pytest

from claude_comms.mcp_server import publish_conversation_event


# --------------------------------------------------------------------------
# Topic + payload shape
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_publishes_to_system_conversations_topic(publish_spy) -> None:
    await publish_conversation_event(
        publish_spy,
        event_type="conversation_created",
        name="svelte-work",
        topic="Svelte refactor coordination",
        creator_key="abcd1234",
    )
    assert publish_spy.call_count == 1
    topic, _payload, _retain = publish_spy.last_call
    assert topic == "claude-comms/system/conversations"


@pytest.mark.asyncio
async def test_conversation_created_payload_shape(publish_spy) -> None:
    await publish_conversation_event(
        publish_spy,
        event_type="conversation_created",
        name="svelte-work",
        topic="Svelte refactor coordination",
        creator_key="abcd1234",
    )
    _topic, payload, _retain = publish_spy.last_call
    msg = json.loads(payload)
    assert msg["type"] == "conversation_created"
    assert msg["name"] == "svelte-work"
    assert msg["topic"] == "Svelte refactor coordination"
    assert msg["creator_key"] == "abcd1234"
    assert "ts" in msg and isinstance(msg["ts"], str)


@pytest.mark.asyncio
async def test_conversation_topic_changed_payload_omits_creator(publish_spy) -> None:
    """``creator_key`` is only meaningful at creation time; topic changes
    don't carry it. The helper should omit the field rather than send
    null or empty string -- the web's switch only reads the fields it
    expects."""
    await publish_conversation_event(
        publish_spy,
        event_type="conversation_topic_changed",
        name="general",
        topic="New banner topic",
    )
    _topic, payload, _retain = publish_spy.last_call
    msg = json.loads(payload)
    assert msg["type"] == "conversation_topic_changed"
    assert msg["name"] == "general"
    assert msg["topic"] == "New banner topic"
    assert "creator_key" not in msg


@pytest.mark.asyncio
async def test_conversation_deleted_payload_omits_topic(publish_spy) -> None:
    """A delete event needs only the name; topic + creator_key are absent."""
    await publish_conversation_event(
        publish_spy,
        event_type="conversation_deleted",
        name="old-channel",
    )
    _topic, payload, _retain = publish_spy.last_call
    msg = json.loads(payload)
    assert msg["type"] == "conversation_deleted"
    assert msg["name"] == "old-channel"
    assert "topic" not in msg
    assert "creator_key" not in msg


# --------------------------------------------------------------------------
# Retain (not retained -- these are deltas, not state snapshots)
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_event_is_not_retained(publish_spy) -> None:
    """Unlike presence (which is state and IS retained), conversation
    lifecycle events are point-in-time deltas. Retaining them would
    cause every connecting browser to re-process every historical event,
    including ones whose effects (e.g. deletes) have since been undone.
    The REST snapshot is authoritative for cold start."""
    await publish_conversation_event(
        publish_spy,
        event_type="conversation_created",
        name="svelte-work",
        topic="",
        creator_key="abcd1234",
    )
    _topic, _payload, retain = publish_spy.last_call
    assert retain is False


# --------------------------------------------------------------------------
# Resilience
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_swallows_publish_exceptions() -> None:
    """Best-effort: a broker outage during the event publish must NOT
    raise back into the caller -- the conversation already exists on
    disk; the broadcast is just the live-update hint."""

    class _BrokenSpy:
        async def __call__(self, topic, payload, retain=False):
            raise ConnectionError("simulated broker outage")

    # Should NOT raise.
    await publish_conversation_event(
        _BrokenSpy(),
        event_type="conversation_created",
        name="svelte-work",
        topic="x",
        creator_key="abcd1234",
    )
