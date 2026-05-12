"""Tests for the v0.4.0 ``/api/conversations`` payload extension.

Covers the new ChannelRow shape (Design Spec §13.4) returned by
:func:`claude_comms.mcp_server.get_all_conversations_full` and the
``/api/conversations`` HTTP endpoint:

- Full field shape (id, name, topic, member, memberCount, lastActivity,
  mode, visibility, createdAt, createdBy, myUnread, myStarred, myMuted)
- ``member: true`` for joined channels, ``member: false`` for non-joined
- Daemon's full known set returned (not just caller's memberships) — the
  fix that enables the sidebar's "Available" section
- Listed channels visible to everyone; unlisted only to members
- ``mode``/``visibility`` defaults (``"public"``/``"listed"``) when
  ``ConversationMeta`` has no such fields
- ``lastActivity`` priority: tracker → meta.last_activity → meta.created_at
- ``myUnread``/``myStarred``/``myMuted`` defaults (0/false/false) until
  per-user state lands in v0.4.1
- Backward-compat snake_case fields preserved (``joined``,
  ``member_count``, ``last_activity``, ``created_at``, ``created_by``,
  ``message_count``)

Test strategy: drive the serializer + collector functions directly,
injecting fakes via the keyword arguments (no module-level monkeypatch).
For the full collector path that scans ``_conv_data_dir``, we write
real ``meta.json`` files and patch the module's ``_conv_data_dir``
global within a try/finally.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import claude_comms.mcp_server as mcp_mod
from claude_comms.broker import MessageStore
from claude_comms.conversation import (
    ConversationMeta,
    LastActivityTracker,
    save_meta,
)
from claude_comms.mcp_server import (
    _serialize_conversation_full,
    get_all_conversations_full,
)
from claude_comms.mcp_tools import ParticipantRegistry


# ---------------------------------------------------------------------------
# Fixtures local to this module
# ---------------------------------------------------------------------------


@pytest.fixture
def general_meta() -> ConversationMeta:
    """A baseline ``ConversationMeta`` for ``general`` (listed/public)."""
    return ConversationMeta(
        name="general",
        topic="Default channel",
        created_by="system",
        created_at="2026-04-01T00:00:00Z",
        last_activity="2026-05-12T15:30:00Z",
    )


@pytest.fixture
def two_member_registry() -> ParticipantRegistry:
    """A registry with two participants, both members of ``general``."""
    reg = ParticipantRegistry()
    reg.join("alice", "general", participant_type="human", key="aabbccdd")
    reg.join("bob", "general", participant_type="claude", key="11223344")
    return reg


# ---------------------------------------------------------------------------
# 1. _serialize_conversation_full — full field shape
# ---------------------------------------------------------------------------


class TestSerializeConversationFull:
    """Shape contract for the v0.4.0 ChannelRow payload."""

    def test_returns_all_channel_row_fields(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """Every Design Spec §13.4 ChannelRow field must be present."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
            store=MessageStore(),
            activity_tracker=None,
        )
        # New v0.4.0 fields (Design Spec §13.4)
        required = {
            "id",
            "name",
            "topic",
            "member",
            "memberCount",
            "lastActivity",
            "mode",
            "visibility",
            "createdAt",
            "createdBy",
            "myUnread",
            "myStarred",
            "myMuted",
        }
        missing = required - row.keys()
        assert not missing, f"missing ChannelRow fields: {missing}"

    def test_member_true_for_joined_caller(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """Caller who is a member sees ``member: True``."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
        )
        assert row["member"] is True
        # Back-compat alias
        assert row["joined"] is True

    def test_member_false_for_non_member_caller(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """Caller who is NOT a member sees ``member: False`` but row is still
        returned (so the sidebar's Available section can populate)."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="ffffffff",  # not registered
            registry=two_member_registry,
        )
        assert row["member"] is False
        assert row["joined"] is False
        # memberCount still reflects total — independent of caller
        assert row["memberCount"] == 2

    def test_member_count_matches_registry(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """``memberCount`` reflects total registry membership."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
        )
        assert row["memberCount"] == 2
        assert row["member_count"] == 2  # back-compat

    def test_personalization_defaults_v040(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """``myUnread``/``myStarred``/``myMuted`` default to 0/false/false in
        v0.4.0 — real per-user state lands in v0.4.1."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
        )
        assert row["myUnread"] == 0
        assert row["myStarred"] is False
        assert row["myMuted"] is False

    def test_mode_and_visibility_defaults(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """``mode``/``visibility`` default to ``"public"``/``"listed"`` when
        the underlying ``ConversationMeta`` doesn't carry them (v0.4.0)."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
        )
        assert row["mode"] == "public"
        assert row["visibility"] == "listed"

    def test_last_activity_prefers_tracker_over_meta(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """In-memory tracker timestamp wins over ``meta.last_activity``."""
        tracker = LastActivityTracker()
        tracker.update("general", "2026-05-12T20:00:00Z")
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
            activity_tracker=tracker,
        )
        assert row["lastActivity"] == "2026-05-12T20:00:00Z"
        # Tracker wins over meta.last_activity (which is 15:30:00Z)
        assert row["lastActivity"] != general_meta.last_activity

    def test_last_activity_falls_back_to_meta(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """When the tracker has no entry, use ``meta.last_activity``."""
        tracker = LastActivityTracker()  # empty
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
            activity_tracker=tracker,
        )
        assert row["lastActivity"] == general_meta.last_activity

    def test_last_activity_falls_back_to_created_at(
        self,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """When both tracker and ``meta.last_activity`` are empty, fall back
        to ``meta.created_at`` — spec requirement so rows always sort."""
        meta = ConversationMeta(
            name="brand-new",
            topic="",
            created_by="phil-mcp",
            created_at="2026-04-01T00:00:00Z",
            last_activity="",  # empty string
        )
        row = _serialize_conversation_full(
            meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
        )
        assert row["lastActivity"] == "2026-04-01T00:00:00Z"

    def test_id_equals_name(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """``id`` mirrors ``name`` (conversation slug is the canonical id)."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
        )
        assert row["id"] == "general"
        assert row["name"] == "general"

    def test_created_at_and_created_by_propagate(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """``createdAt``/``createdBy`` come straight from ``ConversationMeta``."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
        )
        assert row["createdAt"] == "2026-04-01T00:00:00Z"
        assert row["createdBy"] == "system"

    def test_backcompat_snake_case_fields_preserved(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """v0.3.x snake_case fields still emitted alongside camelCase."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="aabbccdd",
            registry=two_member_registry,
            store=MessageStore(),
        )
        # joined/member_count/last_activity/created_at/created_by/message_count
        for field in (
            "joined",
            "member_count",
            "last_activity",
            "created_at",
            "created_by",
            "message_count",
        ):
            assert field in row, f"back-compat field {field!r} missing"

    def test_empty_caller_key_means_not_member(
        self,
        general_meta: ConversationMeta,
        two_member_registry: ParticipantRegistry,
    ) -> None:
        """Empty caller key → ``member: False`` for every row."""
        row = _serialize_conversation_full(
            general_meta,
            caller_key="",
            registry=two_member_registry,
        )
        assert row["member"] is False
        assert row["memberCount"] == 2  # but total membership is unchanged


# ---------------------------------------------------------------------------
# 2. get_all_conversations_full — daemon-wide set + visibility filter
# ---------------------------------------------------------------------------


def _write_meta(data_dir: Path, meta: ConversationMeta) -> None:
    """Persist *meta* under ``data_dir/{name}/meta.json``."""
    save_meta(meta, data_dir)


@pytest.fixture
def populated_conv_dir(tmp_path: Path) -> Path:
    """A ``conv_data_dir`` populated with three conversations.

    - ``general``: listed/public, two members
    - ``ops``:     listed/public, no members (Available section candidate)
    - ``secret``:  unlisted/public, one member (should be hidden from
                   non-members but visible to members)

    Because ``ConversationMeta`` doesn't yet carry ``visibility`` we
    simulate the unlisted case by attaching it dynamically as a runtime
    attribute (the serializer reads via ``getattr``).
    """
    data_dir = tmp_path / "conv_data"
    data_dir.mkdir()

    _write_meta(
        data_dir,
        ConversationMeta(
            name="general",
            topic="Default channel",
            created_by="system",
            created_at="2026-04-01T00:00:00Z",
            last_activity="2026-05-12T15:30:00Z",
        ),
    )
    _write_meta(
        data_dir,
        ConversationMeta(
            name="ops",
            topic="Ops & infra",
            created_by="phil-mcp",
            created_at="2026-04-15T00:00:00Z",
            last_activity="2026-05-10T10:00:00Z",
        ),
    )
    _write_meta(
        data_dir,
        ConversationMeta(
            name="secret",
            topic="Hidden channel",
            created_by="phil-mcp",
            created_at="2026-04-20T00:00:00Z",
            last_activity="2026-05-11T12:00:00Z",
        ),
    )
    return data_dir


@pytest.fixture
def module_state(
    populated_conv_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> ParticipantRegistry:
    """Wire mcp_server module-level state for the collector tests.

    Provides:
    - ``_conv_data_dir`` pointing at the populated test directory
    - ``_registry`` with alice (member of general + secret) and bob
      (member of general only)
    - ``_store`` fresh MessageStore
    - ``_activity_tracker`` fresh LastActivityTracker

    Patches ``list_all_conversations`` so the ``secret`` conversation
    surfaces with ``visibility="unlisted"`` (since ``ConversationMeta``
    has no such field on disk yet — v0.4.x follow-up).
    """
    reg = ParticipantRegistry()
    reg.join("alice", "general", participant_type="human", key="aabbccdd")
    reg.join("alice", "secret", participant_type="human", key="aabbccdd")
    reg.join("bob", "general", participant_type="claude", key="11223344")

    monkeypatch.setattr(mcp_mod, "_conv_data_dir", populated_conv_dir)
    monkeypatch.setattr(mcp_mod, "_registry", reg)
    monkeypatch.setattr(mcp_mod, "_store", MessageStore())
    monkeypatch.setattr(mcp_mod, "_activity_tracker", LastActivityTracker())

    # Stamp visibility onto the loaded metas. Since list_all_conversations
    # re-reads from disk on each call, we wrap it to inject ``visibility``.
    original_list = mcp_mod.list_all_conversations

    def _list_with_visibility(data_dir: Path) -> list:
        metas = original_list(data_dir)
        for m in metas:
            if m.name == "secret":
                # Cast through model_dump+revalidate isn't possible without
                # adding a field — but the serializer uses getattr, so a
                # plain attribute assignment is enough for the test.
                object.__setattr__(m, "visibility", "unlisted")
        return metas

    monkeypatch.setattr(mcp_mod, "list_all_conversations", _list_with_visibility)
    return reg


class TestGetAllConversationsFull:
    """Daemon-wide collector with visibility filtering."""

    def test_returns_daemon_full_set_for_member(
        self,
        module_state: ParticipantRegistry,
    ) -> None:
        """The S-FIX: caller who is a member of ``general`` still receives
        rows for every other listed-public channel (so the sidebar's
        Available section can populate from server truth)."""
        rows = get_all_conversations_full(caller_key="11223344")  # bob
        names = sorted(r["name"] for r in rows)
        # bob is only in general but sees BOTH listed channels.
        # ``secret`` is unlisted and bob isn't a member → filtered out.
        assert names == ["general", "ops"]
        # And bob's member flag distinguishes joined vs available:
        by_name = {r["name"]: r for r in rows}
        assert by_name["general"]["member"] is True
        assert by_name["ops"]["member"] is False

    def test_unlisted_channel_hidden_from_non_member(
        self,
        module_state: ParticipantRegistry,
    ) -> None:
        """Unlisted channels do NOT appear for callers who aren't members."""
        rows = get_all_conversations_full(caller_key="11223344")  # bob
        assert all(r["name"] != "secret" for r in rows)

    def test_unlisted_channel_visible_to_member(
        self,
        module_state: ParticipantRegistry,
    ) -> None:
        """Unlisted channels appear for callers who ARE members."""
        rows = get_all_conversations_full(caller_key="aabbccdd")  # alice
        names = sorted(r["name"] for r in rows)
        assert names == ["general", "ops", "secret"]
        by_name = {r["name"]: r for r in rows}
        assert by_name["secret"]["member"] is True
        assert by_name["secret"]["visibility"] == "unlisted"

    def test_listed_channels_visible_with_empty_caller(
        self,
        module_state: ParticipantRegistry,
    ) -> None:
        """Empty caller key still gets listed channels (read-only client)."""
        rows = get_all_conversations_full(caller_key="")
        names = sorted(r["name"] for r in rows)
        # Empty caller: listed channels yes, unlisted no, member always false
        assert names == ["general", "ops"]
        for row in rows:
            assert row["member"] is False

    def test_returns_empty_when_data_dir_unset(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """No conv_data_dir → empty list (graceful pre-init)."""
        monkeypatch.setattr(mcp_mod, "_conv_data_dir", None)
        rows = get_all_conversations_full(caller_key="aabbccdd")
        assert rows == []


# ---------------------------------------------------------------------------
# 3. End-to-end via /api/conversations HTTP route
# ---------------------------------------------------------------------------


class TestApiConversationsRoute:
    """Spot-check the HTTP route returns ChannelRow-shaped JSON.

    The full route is wired up inside cli._run() which spins up a broker,
    MCP server, and ASGI app. Re-creating that path in a unit test is
    out of scope — instead we drive the underlying collector and assert
    the shape, mirroring what the handler emits."""

    def test_handler_returns_full_shape_via_collector(
        self,
        module_state: ParticipantRegistry,
    ) -> None:
        """Round-trip: collector output is the handler's response payload."""
        rows = get_all_conversations_full(caller_key="aabbccdd")
        # Mirrors handler's JSONResponse({"conversations": rows, "count": N})
        payload = {"conversations": rows, "count": len(rows)}
        assert payload["count"] == len(rows)
        assert payload["count"] >= 1
        first = payload["conversations"][0]
        for field in (
            "id",
            "name",
            "topic",
            "member",
            "memberCount",
            "lastActivity",
            "mode",
            "visibility",
            "createdAt",
            "createdBy",
            "myUnread",
            "myStarred",
            "myMuted",
        ):
            assert field in first, f"ChannelRow field {field!r} missing"
