"""Role-based authorization for conversation delete/archive.

Counterpart to ``test_comms_kick.py``: these exercise the broadened
authorization on ``tool_comms_conversation_delete`` and
``tool_comms_conversation_archive`` after the admin-kick-delete fix.

Rules under test:

- The original creator may delete/archive (back-compat).
- A non-creator with an explicit ``'owner'`` or ``'admin'`` per-channel
  role (conversation_roles table, via ``RegistryStore.get_channel_role``)
  may delete/archive.
- A plain member (no role row) may NOT.
- Reserved conversations (``general`` / ``system``) may NOT be
  deleted/archived by anyone regardless of role.
- A refusal carries a human-readable ``message`` reason.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from claude_comms.conversation import create_conversation_atomic
from claude_comms.mcp_tools import (
    MessageStore,
    ParticipantRegistry,
    tool_comms_conversation_archive,
    tool_comms_conversation_delete,
)
from claude_comms.registry_store import RegistryStore

from conftest import PublishSpy


@pytest.fixture
def store(tmp_path: Path):
    s = RegistryStore.open(tmp_path)
    yield s
    s.close()


def _registry_with(store: RegistryStore) -> ParticipantRegistry:
    return ParticipantRegistry(store=store)


def _seed_channel(
    registry: ParticipantRegistry,
    tmp_path: Path,
    *,
    conversation: str = "design",
    creator_name: str = "alice",
    creator_key: str = "aaaaaaaa",
    other_name: str = "bob",
    other_key: str = "bbbbbbbb",
) -> None:
    """Seed an on-disk channel created by ``creator_name`` plus a second member."""
    registry.join(
        creator_name, conversation, key=creator_key, participant_type="claude"
    )
    registry.join(other_name, conversation, key=other_key, participant_type="claude")
    create_conversation_atomic(
        name=conversation, topic="", created_by=creator_name, data_dir=tmp_path
    )


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_by_creator_succeeds(store: RegistryStore, tmp_path: Path) -> None:
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    spy = PublishSpy()

    result = await tool_comms_conversation_delete(
        registry,
        MessageStore(),
        spy,
        key="aaaaaaaa",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result == {"deleted": True, "conversation_id": "design"}


@pytest.mark.asyncio
async def test_delete_by_owner_non_creator_succeeds(
    store: RegistryStore, tmp_path: Path
) -> None:
    """A non-creator holding the 'owner' role may delete."""
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    store.set_channel_role("design", "bbbbbbbb", "owner")
    spy = PublishSpy()

    result = await tool_comms_conversation_delete(
        registry,
        MessageStore(),
        spy,
        key="bbbbbbbb",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result == {"deleted": True, "conversation_id": "design"}


@pytest.mark.asyncio
async def test_delete_by_admin_non_creator_succeeds(
    store: RegistryStore, tmp_path: Path
) -> None:
    """A non-creator holding the 'admin' role may delete."""
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    store.set_channel_role("design", "bbbbbbbb", "admin")
    spy = PublishSpy()

    result = await tool_comms_conversation_delete(
        registry,
        MessageStore(),
        spy,
        key="bbbbbbbb",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result == {"deleted": True, "conversation_id": "design"}


@pytest.mark.asyncio
async def test_delete_by_member_rejected(store: RegistryStore, tmp_path: Path) -> None:
    """A plain member (no role row) may NOT delete; refusal carries a reason."""
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    spy = PublishSpy()

    result = await tool_comms_conversation_delete(
        registry,
        MessageStore(),
        spy,
        key="bbbbbbbb",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result.get("error") is True
    assert result.get("reason") == "not_authorized"
    assert "admin" in result["message"].lower()
    assert spy.call_count == 0


@pytest.mark.asyncio
async def test_delete_reserved_rejected_for_admin(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Even an admin cannot delete a reserved channel (#general)."""
    registry = _registry_with(store)
    registry.join("alice", "general", key="aaaaaaaa", participant_type="claude")
    create_conversation_atomic(
        name="general", topic="", created_by="alice", data_dir=tmp_path
    )
    store.set_channel_role("general", "aaaaaaaa", "admin")
    spy = PublishSpy()

    result = await tool_comms_conversation_delete(
        registry,
        MessageStore(),
        spy,
        key="aaaaaaaa",
        conversation="general",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result.get("error") is True
    assert result.get("reason") == "reserved"
    assert "reserved" in result["message"].lower()
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# ARCHIVE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_archive_by_creator_succeeds(
    store: RegistryStore, tmp_path: Path
) -> None:
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    spy = PublishSpy()

    result = await tool_comms_conversation_archive(
        registry,
        spy,
        MessageStore(),
        key="aaaaaaaa",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result.get("archived") is True


@pytest.mark.asyncio
async def test_archive_by_admin_non_creator_succeeds(
    store: RegistryStore, tmp_path: Path
) -> None:
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    store.set_channel_role("design", "bbbbbbbb", "admin")
    spy = PublishSpy()

    result = await tool_comms_conversation_archive(
        registry,
        spy,
        MessageStore(),
        key="bbbbbbbb",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result.get("archived") is True


@pytest.mark.asyncio
async def test_archive_by_owner_non_creator_succeeds(
    store: RegistryStore, tmp_path: Path
) -> None:
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    store.set_channel_role("design", "bbbbbbbb", "owner")
    spy = PublishSpy()

    result = await tool_comms_conversation_archive(
        registry,
        spy,
        MessageStore(),
        key="bbbbbbbb",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result.get("archived") is True


@pytest.mark.asyncio
async def test_archive_by_member_rejected(store: RegistryStore, tmp_path: Path) -> None:
    registry = _registry_with(store)
    _seed_channel(registry, tmp_path)
    spy = PublishSpy()

    result = await tool_comms_conversation_archive(
        registry,
        spy,
        MessageStore(),
        key="bbbbbbbb",
        conversation="design",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result.get("error") == "not_authorized"
    assert "admin" in result["message"].lower()
    meta_archived = result.get("archived")
    assert meta_archived is not True


@pytest.mark.asyncio
async def test_archive_reserved_rejected_for_admin(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Even an admin cannot archive a reserved channel (#general)."""
    registry = _registry_with(store)
    registry.join("alice", "general", key="aaaaaaaa", participant_type="claude")
    create_conversation_atomic(
        name="general", topic="", created_by="alice", data_dir=tmp_path
    )
    store.set_channel_role("general", "aaaaaaaa", "admin")
    spy = PublishSpy()

    result = await tool_comms_conversation_archive(
        registry,
        spy,
        MessageStore(),
        key="aaaaaaaa",
        conversation="general",
        confirm=True,
        conv_data_dir=tmp_path,
        registry_store=store,
    )
    assert result.get("error") == "invalid_target"
    assert "reserved" in result["message"].lower()
