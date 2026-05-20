"""Tests for the v0.4.2 Step 3.5a ``tool_comms_dm_open`` MCP tool.

Synthesizes a deterministic two-party DM slug ``dm-{lo}-{hi}`` from
the sorted participant keys. Idempotent: a second call with the same
pair returns ``status="existed"``. New DMs are private + invite-mode,
both parties auto-joined, both get the ``'owner'`` role (symmetric
ownership).

Tests by name (8 total):

1. test_dm_open_creates_new_channel
2. test_dm_open_idempotent_existed_on_second_call
3. test_dm_slug_is_deterministic_min_max_key_sort
4. test_dm_open_auto_joins_both_parties
5. test_dm_open_both_parties_get_owner_role
6. test_dm_open_visibility_is_private_mode_is_invite
7. test_dm_with_self_rejected
8. test_dm_with_unregistered_target_rejected
"""

from __future__ import annotations

from pathlib import Path

import pytest

from claude_comms.conversation import load_meta
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    _dm_slug,
    tool_comms_dm_open,
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
) -> None:
    """Seed caller (alice) + target (bob) into the registry via "general"."""
    registry.join("alice", "general", key=caller_key, participant_type="claude")
    registry.join("bob", "general", key=target_key, participant_type="claude")


# ---------------------------------------------------------------------------
# 1. Happy path: creates new DM
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_open_creates_new_channel(
    store: RegistryStore, tmp_path: Path
) -> None:
    """First-time open returns status='opened' + the deterministic slug."""
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    result = await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert result == {
        "status": "opened",
        "conversation": "dm-aaaaaaaa-bbbbbbbb",
    }
    # meta.json materialised on disk.
    meta = load_meta("dm-aaaaaaaa-bbbbbbbb", tmp_path)
    assert meta is not None


# ---------------------------------------------------------------------------
# 2. Idempotency: second open returns 'existed'
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_open_idempotent_existed_on_second_call(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Second call with the same pair returns status='existed' + same slug."""
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    first = await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )
    second = await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    assert first["status"] == "opened"
    assert second["status"] == "existed"
    assert first["conversation"] == second["conversation"]


# ---------------------------------------------------------------------------
# 3. Slug is deterministic min/max key sort (symmetric on opener)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_slug_is_deterministic_min_max_key_sort(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Bob opening first then Alice opening returns the same slug.

    The slug must be SYMMETRIC on which party initiates so the idempotency
    contract holds regardless of who clicks "DM" first in the UI. The slug
    algorithm is ``dm-{lo}-{hi}`` with lexicographic sort.
    """
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    # Bob opens first.
    bob_result = await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="bbbbbbbb",
        target_key="aaaaaaaa",
        conv_data_dir=tmp_path,
    )
    # Alice opens second.
    alice_result = await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    expected_slug = "dm-aaaaaaaa-bbbbbbbb"
    assert bob_result["conversation"] == expected_slug
    assert alice_result["conversation"] == expected_slug
    assert alice_result["status"] == "existed"

    # Internal helper sanity (worklog §3 anchor).
    assert _dm_slug("aaaaaaaa", "bbbbbbbb") == expected_slug
    assert _dm_slug("bbbbbbbb", "aaaaaaaa") == expected_slug


# ---------------------------------------------------------------------------
# 4. Both parties auto-joined
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_open_auto_joins_both_parties(
    store: RegistryStore, tmp_path: Path
) -> None:
    """After open, both keys appear as members of the new DM slug."""
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    slug = "dm-aaaaaaaa-bbbbbbbb"
    assert slug in registry.conversations_for("aaaaaaaa")
    assert slug in registry.conversations_for("bbbbbbbb")


# ---------------------------------------------------------------------------
# 5. Symmetric ownership: both get 'owner'
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_open_both_parties_get_owner_role(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Both parties hold the 'owner' role for the new DM (no asymmetry)."""
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    slug = "dm-aaaaaaaa-bbbbbbbb"
    assert store.get_channel_role(slug, "aaaaaaaa") == "owner"
    assert store.get_channel_role(slug, "bbbbbbbb") == "owner"


# ---------------------------------------------------------------------------
# 6. Visibility = private, mode = invite
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_open_visibility_is_private_mode_is_invite(
    store: RegistryStore, tmp_path: Path
) -> None:
    """DMs are unlisted (visibility=private) and invite-only (mode=invite)."""
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="bbbbbbbb",
        conv_data_dir=tmp_path,
    )

    meta = load_meta("dm-aaaaaaaa-bbbbbbbb", tmp_path)
    assert meta is not None
    assert meta.visibility == "private"
    assert meta.mode == "invite"
    # ``created_by`` is the opener's display name.
    assert meta.created_by == "alice"


# ---------------------------------------------------------------------------
# 7. Self-DM rejected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_with_self_rejected(store: RegistryStore, tmp_path: Path) -> None:
    """key == target_key returns an error envelope."""
    registry = _registry_with(store)
    _seed_pair(registry)
    spy = PublishSpy()

    result = await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="aaaaaaaa",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "yourself" in result["message"].lower()


# ---------------------------------------------------------------------------
# 8. Unregistered target rejected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_with_unregistered_target_rejected(
    store: RegistryStore, tmp_path: Path
) -> None:
    """Well-formed but unregistered target key returns an error envelope."""
    registry = _registry_with(store)
    # Only alice is registered; bob's key is well-formed but unknown.
    registry.join("alice", "general", key="aaaaaaaa", participant_type="claude")
    spy = PublishSpy()

    result = await tool_comms_dm_open(
        registry,
        spy,
        store,
        key="aaaaaaaa",
        target_key="deadbeef",
        conv_data_dir=tmp_path,
    )

    assert result.get("error") is True
    assert "not registered" in result["message"].lower()
    # No channel meta materialised for an unregistered target.
    assert load_meta("dm-aaaaaaaa-deadbeef", tmp_path) is None
