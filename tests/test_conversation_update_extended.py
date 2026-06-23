"""Tests for the v0.4.2 Step 3.6b extended ``tool_comms_conversation_update``.

Covers the new multi-field accept-list (``display_name`` / ``visibility``
/ ``mode`` / ``created_by``) PLUS the immutable-slug rejection on ``name``
PLUS the backwards-compat path for the legacy single-field ``topic`` call
shape PLUS the on-disk backwards-compat smoke for pre-3.6b ``meta.json``
files (missing visibility / mode / display_name fields take their
Pydantic defaults on load).

Tests by name (10 total):

1. test_topic_only_path_backwards_compat
2. test_visibility_only_set
3. test_mode_only_set
4. test_display_name_only_set
5. test_multi_field_atomic_update
6. test_created_by_transfer_ownership_with_role_table_side_effect
7. test_invalid_visibility_rejected
8. test_invalid_mode_rejected
9. test_name_rejected_slug_immutable
10. test_no_fields_returns_error
11. test_backwards_compat_load_pre_3_6b_meta_dict (extra coverage)
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_comms.conversation import (
    ConversationMeta,
    load_meta,
    save_meta,
)
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_conversation_create,
    tool_comms_conversation_update,
)
from claude_comms.message import ParticipantType, now_iso
from claude_comms.registry_store import RegistryStore

from conftest import PublishSpy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _registry_with_humans() -> ParticipantRegistry:
    reg = ParticipantRegistry()
    reg.join("Phil", "general", participant_type="human")
    return reg


def _register(
    registry: ParticipantRegistry,
    name: str = "alice",
    conversation: str = "general",
    participant_type: ParticipantType = "claude",
) -> str:
    p = registry.join(name, conversation, participant_type=participant_type)
    return p.key


async def _seed_channel(
    registry: ParticipantRegistry,
    spy: PublishSpy,
    *,
    key: str,
    conversation: str,
    data_dir: Path,
) -> None:
    await tool_comms_conversation_create(
        registry, spy, key=key, conversation=conversation, conv_data_dir=data_dir
    )
    spy.calls.clear()


# ---------------------------------------------------------------------------
# 1. Topic-only path (backwards compat with pre-3.6b callers)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_topic_only_path_backwards_compat(tmp_path: Path) -> None:
    """Legacy single-field topic call shape still works post-3.6b extension."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        topic="New topic",
        conv_data_dir=tmp_path,
    )

    assert result["status"] == "updated"
    assert result["topic"] == "New topic"
    assert result["updated_fields"] == ["topic"]

    # Disk round-trip.
    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.topic == "New topic"
    # Other fields default-untouched.
    assert meta.visibility == "public"
    assert meta.mode == "open"
    assert meta.display_name is None

    # Single system message published.
    assert spy.call_count == 1
    _, payload, _ = spy.calls[0]
    msg = json.loads(payload)
    assert "topic" in msg["body"]
    assert "New topic" in msg["body"]


# ---------------------------------------------------------------------------
# 2. visibility-only set
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_visibility_only_set(tmp_path: Path) -> None:
    """visibility='private' alone persists + reports updated_fields."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        visibility="private",
        conv_data_dir=tmp_path,
    )

    assert result["status"] == "updated"
    assert result["visibility"] == "private"
    assert result["updated_fields"] == ["visibility"]

    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.visibility == "private"
    # Topic untouched.
    assert meta.topic == ""


# ---------------------------------------------------------------------------
# 3. mode-only set
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mode_only_set(tmp_path: Path) -> None:
    """mode='invite' alone persists + reports updated_fields."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        mode="invite",
        conv_data_dir=tmp_path,
    )

    assert result["status"] == "updated"
    assert result["mode"] == "invite"
    assert result["updated_fields"] == ["mode"]

    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.mode == "invite"


# ---------------------------------------------------------------------------
# 4. display_name-only set
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_display_name_only_set(tmp_path: Path) -> None:
    """display_name='My Channel' persists + slug stays immutable."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        display_name="My Cool Channel",
        conv_data_dir=tmp_path,
    )

    assert result["status"] == "updated"
    assert result["display_name"] == "My Cool Channel"
    assert result["updated_fields"] == ["display_name"]

    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.display_name == "My Cool Channel"
    # Storage slug stays put (immutable).
    assert meta.name == "design"


# ---------------------------------------------------------------------------
# 5. Multi-field atomic update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_field_atomic_update(tmp_path: Path) -> None:
    """topic + visibility + display_name update atomically + ONE system message."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        topic="Refreshed agenda",
        visibility="private",
        display_name="Design Lab",
        conv_data_dir=tmp_path,
    )

    assert result["status"] == "updated"
    assert set(result["updated_fields"]) == {"topic", "display_name", "visibility"}
    assert result["topic"] == "Refreshed agenda"
    assert result["visibility"] == "private"
    assert result["display_name"] == "Design Lab"

    # Disk: all three landed in ONE save.
    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.topic == "Refreshed agenda"
    assert meta.visibility == "private"
    assert meta.display_name == "Design Lab"
    # mode untouched.
    assert meta.mode == "open"

    # Exactly one combined system message.
    assert spy.call_count == 1
    _, payload, _ = spy.calls[0]
    msg = json.loads(payload)
    body = msg["body"]
    assert "topic" in body
    assert "visibility" in body
    assert "display_name" in body


# ---------------------------------------------------------------------------
# 6. created_by transfer ownership + role-table side effect
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_created_by_transfer_ownership_with_role_table_side_effect(
    tmp_path: Path,
) -> None:
    """Owner transfers ownership to bob: meta.created_by + role table both flip."""
    # Wire the registry to a real RegistryStore so participants persist
    # into the SQLite ``participants`` table (the FK target for the
    # conversation_roles rows that ``set_channel_role`` will insert).
    store = RegistryStore.open(tmp_path)
    try:
        registry = ParticipantRegistry(store=store)
        registry.join("Phil", "general", participant_type="human")
        alice = registry.join("alice", "general", participant_type="claude")
        bob = registry.join("bob", "general", participant_type="claude")
        alice_key = alice.key
        bob_key = bob.key
        # Both alice and bob become members of "design" before the transfer.
        registry.join("alice", "design", participant_type="claude", key=alice_key)
        registry.join("bob", "design", participant_type="claude", key=bob_key)

        spy = PublishSpy()
        await _seed_channel(
            registry, spy, key=alice_key, conversation="design", data_dir=tmp_path
        )

        # Seed alice as the explicit owner (the create path doesn't auto-seed
        # roles when ConversationMeta.created_by happens to match a known
        # participant — that's the 3.0a backfill's job at v1->v2 migration).
        store.set_channel_role("design", alice_key, "owner")
        # Backstop: ensure bob starts as default 'member'.
        assert store.get_channel_role("design", bob_key) == "member"

        result = await tool_comms_conversation_update(
            registry,
            spy,
            key=alice_key,
            conversation="design",
            created_by=bob_key,
            conv_data_dir=tmp_path,
            store=store,
        )

        assert result["status"] == "updated"
        assert result["created_by"] == "bob"
        assert result["created_by_key"] == bob_key
        assert result["updated_fields"] == ["created_by"]

        # meta.json on disk reflects the new owner display name.
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.created_by == "bob"

        # Role table flipped: bob is owner, alice is member.
        assert store.get_channel_role("design", bob_key) == "owner"
        assert store.get_channel_role("design", alice_key) == "member"

        # System message names the transfer.
        assert spy.call_count == 1
        _, payload, _ = spy.calls[0]
        msg = json.loads(payload)
        assert "ownership transferred to bob" in msg["body"]
    finally:
        store.close()


# ---------------------------------------------------------------------------
# 7. Invalid visibility rejected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invalid_visibility_rejected(tmp_path: Path) -> None:
    """visibility='listed' (legacy bad value) is rejected with an error envelope."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        visibility="listed",  # Not in {'public', 'private'}.
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "visibility" in result["message"].lower()
    # No system message published on validation rejection.
    assert spy.call_count == 0
    # Disk untouched.
    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.visibility == "public"


# ---------------------------------------------------------------------------
# 8. Invalid mode rejected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invalid_mode_rejected(tmp_path: Path) -> None:
    """mode='closed' is rejected (not in {'open', 'invite'})."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        mode="closed",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "mode" in result["message"].lower()
    assert spy.call_count == 0
    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.mode == "open"


# ---------------------------------------------------------------------------
# 9. name field rejected (slug immutable)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_name_rejected_slug_immutable(tmp_path: Path) -> None:
    """Passing name=... returns an error envelope (slug is immutable)."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        name="renamed-design",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert (
        "immutable" in result["message"].lower() or "name" in result["message"].lower()
    )
    assert "display_name" in result["message"].lower()
    # Disk: name stays put.
    meta = load_meta("design", tmp_path)
    assert meta is not None
    assert meta.name == "design"
    # No system message.
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 10. No update fields => error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_fields_returns_error(tmp_path: Path) -> None:
    """Calling without any update field returns a structured error."""
    registry = _registry_with_humans()
    spy = PublishSpy()
    key = _register(registry)
    await _seed_channel(
        registry, spy, key=key, conversation="design", data_dir=tmp_path
    )

    result = await tool_comms_conversation_update(
        registry,
        spy,
        key=key,
        conversation="design",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "no update fields" in result["message"].lower()
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# 11. Backwards-compat: pre-3.6b meta.json shape (3 fields missing) round-trips
# ---------------------------------------------------------------------------


def test_backwards_compat_load_pre_3_6b_meta_dict(tmp_path: Path) -> None:
    """A pre-3.6b meta dict (no visibility/mode/display_name) loads with defaults."""
    # Simulate a v0.4.0/v0.4.1 meta.json file that pre-dates the 3 new fields.
    pre_3_6b_dict = {
        "name": "legacy-channel",
        "topic": "Pre-3.6b channel",
        "created_by": "alice",
        "created_at": now_iso(),
        "last_activity": now_iso(),
        "archived": False,
        "deleted_at": None,
        "deleted_by": None,
        "archived_at": None,
        "archived_by": None,
        # Deliberately MISSING: visibility, mode, display_name.
    }

    # Construct via model_validate (mirrors load_meta's json round-trip).
    meta = ConversationMeta.model_validate(pre_3_6b_dict)
    # Defaults landed.
    assert meta.visibility == "public"
    assert meta.mode == "open"
    assert meta.display_name is None
    # Existing fields preserved.
    assert meta.name == "legacy-channel"
    assert meta.topic == "Pre-3.6b channel"

    # Now persist + re-load to confirm save_meta + load_meta round-trip.
    save_meta(meta, tmp_path)
    reloaded = load_meta("legacy-channel", tmp_path)
    assert reloaded is not None
    assert reloaded.visibility == "public"
    assert reloaded.mode == "open"
    assert reloaded.display_name is None
