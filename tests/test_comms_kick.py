"""Tests for the v0.4.2 Step 3.5a ``tool_comms_kick`` MCP tool.

Privileged-eject counterpart to ``tool_comms_leave``. Authorization
gates on the caller's per-channel role from the conversation_roles
table (Step 3.0a): only ``'owner'`` and ``'admin'`` may kick. The
target must be a registered participant AND an explicit member of
the channel.

Tests by name (8 total):

1. test_kick_by_owner_succeeds
2. test_kick_by_admin_succeeds
3. test_kick_by_non_admin_rejected
4. test_kick_non_member_target_rejected
5. test_kick_unregistered_target_rejected
6. test_kick_system_message_published
7. test_kick_invalid_conv_id_rejected
8. test_kick_target_membership_actually_dropped
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_comms.conversation import create_conversation_atomic
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_kick,
)
from claude_comms.registry_store import RegistryStore

from conftest import PublishSpy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path):
    """Fresh RegistryStore rooted at tmp_path."""
    s = RegistryStore.open(tmp_path)
    yield s
    s.close()


def _registry_with(store: RegistryStore) -> ParticipantRegistry:
    return ParticipantRegistry(store=store)


def _seed_pair(
    registry: ParticipantRegistry,
    *,
    caller_key: str = "aaaaaaaa",
    target_key: str = "bbbbbbbb",
    conversation: str = "design",
) -> None:
    """Seed caller + target in *conversation* (plus general for caller).

    Pattern from ``test_comms_get_channel_role.py``: explicit keys so
    tests don't depend on UUID randomness.
    """
    registry.join("alice", conversation, key=caller_key, participant_type="claude")
    registry.join("bob", conversation, key=target_key, participant_type="claude")


# ---------------------------------------------------------------------------
# 1. Happy path: owner kicks succeeds
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_by_owner_succeeds(store: RegistryStore, tmp_path: Path) -> None:
    """Owner of the channel may kick another member."""
    registry = _registry_with(store)
    _seed_pair(registry)
    store.set_channel_role("design", "aaaaaaaa", "owner")
    # Seed the channel on disk so conv_data_dir reads stay clean.
    create_conversation_atomic(
        name="design", topic="", created_by="alice", data_dir=tmp_path
    )
    spy = PublishSpy()

    result = await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert result == {
        "status": "kicked",
        "target_key": "bbbbbbbb",
        "conversation": "design",
    }


# ---------------------------------------------------------------------------
# 2. Admin can also kick
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_by_admin_succeeds(store: RegistryStore, tmp_path: Path) -> None:
    """Channel admin may also kick another member."""
    registry = _registry_with(store)
    _seed_pair(registry)
    store.set_channel_role("design", "aaaaaaaa", "admin")
    create_conversation_atomic(
        name="design", topic="", created_by="alice", data_dir=tmp_path
    )
    spy = PublishSpy()

    result = await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert result["status"] == "kicked"


# ---------------------------------------------------------------------------
# 3. Plain member (default role) cannot kick
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_by_non_admin_rejected(store: RegistryStore, tmp_path: Path) -> None:
    """A caller with the default 'member' role gets an error envelope."""
    registry = _registry_with(store)
    _seed_pair(registry)
    # No explicit role row for the caller -> reads as 'member' (default).
    create_conversation_atomic(
        name="design", topic="", created_by="alice", data_dir=tmp_path
    )
    spy = PublishSpy()

    result = await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "owner" in result["message"].lower() or "admin" in result["message"].lower()
    # No system message published when the kick is rejected.
    assert spy.call_count == 0
    # Target is still a member.
    assert "design" in registry.conversations_for("bbbbbbbb")


# ---------------------------------------------------------------------------
# 4. Target not in channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_non_member_target_rejected(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Target who is registered but not a channel member returns error."""
    registry = _registry_with(store)
    # Caller is in "design"; target "bob" exists only in "general".
    registry.join("alice", "design", key="aaaaaaaa", participant_type="claude")
    registry.join("bob", "general", key="bbbbbbbb", participant_type="claude")
    store.set_channel_role("design", "aaaaaaaa", "owner")
    create_conversation_atomic(
        name="design", topic="", created_by="alice", data_dir=tmp_path
    )
    spy = PublishSpy()

    result = await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "not a member" in result["message"].lower()
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 5. Target unregistered
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_unregistered_target_rejected(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Target key with no registered participant returns error."""
    registry = _registry_with(store)
    registry.join("alice", "design", key="aaaaaaaa", participant_type="claude")
    store.set_channel_role("design", "aaaaaaaa", "owner")
    create_conversation_atomic(
        name="design", topic="", created_by="alice", data_dir=tmp_path
    )
    spy = PublishSpy()

    result = await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_key="deadbeef",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "not registered" in result["message"].lower()
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 6. System message body + topic shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_system_message_published(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Successful kick publishes a [system] message on the conv's MQTT topic."""
    registry = _registry_with(store)
    _seed_pair(registry)
    store.set_channel_role("design", "aaaaaaaa", "owner")
    create_conversation_atomic(
        name="design", topic="", created_by="alice", data_dir=tmp_path
    )
    spy = PublishSpy()

    await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert spy.call_count == 1
    topic, payload, _retain = spy.calls[0]
    assert topic == "claude-comms/conv/design/messages"
    msg = json.loads(payload)
    assert msg["conv"] == "design"
    assert msg["sender"] == {"key": "00000000", "name": "system", "type": "system"}
    assert msg["body"] == "[system] alice kicked bob from #design"


# ---------------------------------------------------------------------------
# 7. Invalid conversation id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_invalid_conv_id_rejected(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Malformed conversation id returns an error envelope."""
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    result = await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="!!!bad!!!",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "invalid conversation" in result["message"].lower()
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 8. Membership actually dropped after kick
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kick_target_membership_actually_dropped(
    store: RegistryStore, tmp_path: Path
) -> None:
    """After a successful kick, target is no longer a channel member."""
    registry = _registry_with(store)
    _seed_pair(registry)
    store.set_channel_role("design", "aaaaaaaa", "owner")
    create_conversation_atomic(
        name="design", topic="", created_by="alice", data_dir=tmp_path
    )
    spy = PublishSpy()

    # Pre-flight: target is in the channel.
    assert "design" in registry.conversations_for("bbbbbbbb")

    await tool_comms_kick(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        conversation="design",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    # Post: target's membership for "design" is gone (write-through to store).
    assert "design" not in registry.conversations_for("bbbbbbbb")
