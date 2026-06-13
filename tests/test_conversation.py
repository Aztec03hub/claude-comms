"""Unit tests for conversation discovery and metadata."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from claude_comms.conversation import (
    ConversationMeta,
    LastActivityTracker,
    RESERVED_CONVERSATION_NAMES,
    backfill_missing_metadata,
    create_conversation_atomic,
    ensure_general_exists,
    list_all_conversations,
    load_meta,
    save_meta,
)
from claude_comms.message import now_iso
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_conversation_archive,
    tool_comms_conversation_create,
    tool_comms_conversation_delete,
    tool_comms_conversation_unarchive,
    tool_comms_conversation_update,
    tool_comms_conversations,
    tool_comms_invite,
    tool_comms_send,
)
from claude_comms.broker import MessageStore

from conftest import PublishSpy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _registry_with_humans() -> ParticipantRegistry:
    """Create a registry with a human participant in general."""
    reg = ParticipantRegistry()
    reg.join("Phil", "general", participant_type="human")
    return reg


def _register(
    registry: ParticipantRegistry,
    name: str = "test-claude",
    conversation: str = "general",
    participant_type: str = "claude",
) -> str:
    """Register a participant and return the key."""
    p = registry.join(name, conversation, participant_type=participant_type)
    return p.key


# ===================================================================
# 1. ConversationMeta model
# ===================================================================


class TestConversationMeta:
    def test_create_with_required_fields(self):
        ts = now_iso()
        meta = ConversationMeta(
            name="test-conv",
            created_by="alice",
            created_at=ts,
            last_activity=ts,
        )
        assert meta.name == "test-conv"
        assert meta.created_by == "alice"
        assert meta.created_at == ts
        assert meta.last_activity == ts

    def test_topic_defaults_to_empty_string(self):
        ts = now_iso()
        meta = ConversationMeta(
            name="x", created_by="a", created_at=ts, last_activity=ts
        )
        assert meta.topic == ""

    def test_archived_defaults_to_false(self):
        ts = now_iso()
        meta = ConversationMeta(
            name="x", created_by="a", created_at=ts, last_activity=ts
        )
        assert meta.archived is False


# ===================================================================
# 2. save_meta + load_meta round-trip
# ===================================================================


class TestSaveLoadMetaRoundTrip:
    def test_round_trip(self, tmp_path: Path):
        ts = now_iso()
        original = ConversationMeta(
            name="my-conv",
            topic="Design discussion",
            created_by="alice",
            created_at=ts,
            last_activity=ts,
            archived=False,
        )
        save_meta(original, tmp_path)
        loaded = load_meta("my-conv", tmp_path)

        assert loaded is not None
        assert loaded.name == original.name
        assert loaded.topic == original.topic
        assert loaded.created_by == original.created_by
        assert loaded.created_at == original.created_at
        assert loaded.last_activity == original.last_activity
        assert loaded.archived == original.archived

    def test_no_tmp_files_left(self, tmp_path: Path):
        ts = now_iso()
        meta = ConversationMeta(
            name="conv1", created_by="a", created_at=ts, last_activity=ts
        )
        save_meta(meta, tmp_path)

        conv_dir = tmp_path / "conv1"
        tmp_files = list(conv_dir.glob("*.tmp"))
        assert tmp_files == []


# ===================================================================
# 3. load_meta edge cases
# ===================================================================


class TestLoadMetaEdgeCases:
    def test_nonexistent_returns_none(self, tmp_path: Path):
        result = load_meta("does-not-exist", tmp_path)
        assert result is None

    def test_malformed_json_returns_none(self, tmp_path: Path):
        conv_dir = tmp_path / "broken"
        conv_dir.mkdir(parents=True)
        (conv_dir / "meta.json").write_text("{{not valid json", encoding="utf-8")

        result = load_meta("broken", tmp_path)
        assert result is None


# ===================================================================
# 4. create_conversation_atomic
# ===================================================================


class TestCreateConversationAtomic:
    def test_creates_new_conversation(self, tmp_path: Path):
        meta = create_conversation_atomic(
            "design", topic="Design discussion", created_by="alice", data_dir=tmp_path
        )
        assert meta is not None
        assert isinstance(meta, ConversationMeta)
        assert meta.name == "design"
        assert meta.topic == "Design discussion"
        assert meta.created_by == "alice"

    def test_second_call_same_name_returns_none(self, tmp_path: Path):
        first = create_conversation_atomic(
            "dupe", topic="", created_by="alice", data_dir=tmp_path
        )
        assert first is not None

        second = create_conversation_atomic(
            "dupe", topic="", created_by="bob", data_dir=tmp_path
        )
        assert second is None

    def test_creates_directory_structure(self, tmp_path: Path):
        create_conversation_atomic(
            "new-conv", topic="", created_by="alice", data_dir=tmp_path
        )
        assert (tmp_path / "new-conv").is_dir()
        assert (tmp_path / "new-conv" / "meta.json").is_file()


# ===================================================================
# 5. list_all_conversations
# ===================================================================


class TestListAllConversations:
    def test_empty_directory_returns_empty(self, tmp_path: Path):
        assert list_all_conversations(tmp_path) == []

    def test_nonexistent_directory_returns_empty(self, tmp_path: Path):
        assert list_all_conversations(tmp_path / "nope") == []

    def test_lists_multiple_conversations(self, tmp_path: Path):
        for name in ("alpha", "beta", "gamma"):
            create_conversation_atomic(
                name, topic=f"{name} topic", created_by="alice", data_dir=tmp_path
            )

        results = list_all_conversations(tmp_path)
        assert len(results) == 3
        names = {m.name for m in results}
        assert names == {"alpha", "beta", "gamma"}


# ===================================================================
# 6. ensure_general_exists
# ===================================================================


class TestEnsureGeneralExists:
    def test_creates_general_if_missing(self, tmp_path: Path):
        meta = ensure_general_exists(tmp_path)
        assert meta.name == "general"
        assert meta.topic == "Main lobby"
        assert meta.created_by == "system"

    def test_returns_existing_general_if_present(self, tmp_path: Path):
        first = ensure_general_exists(tmp_path)
        second = ensure_general_exists(tmp_path)
        assert first.name == second.name
        assert first.created_at == second.created_at


# ===================================================================
# 7. backfill_missing_metadata
# ===================================================================


class TestBackfillMissingMetadata:
    def _write_jsonl(self, log_dir: Path, name: str, messages: list[dict]) -> Path:
        """Write a JSONL log file for a conversation."""
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for msg in messages:
                f.write(json.dumps(msg) + "\n")
        return path

    def test_creates_meta_for_conversations_with_logs(self, tmp_path: Path):
        data_dir = tmp_path / "data"
        log_dir = tmp_path / "logs"
        data_dir.mkdir()

        ts = now_iso()
        self._write_jsonl(log_dir, "old-chat", [{"ts": ts, "body": "hello"}])

        count = backfill_missing_metadata(data_dir, log_dir)
        assert count == 1

        meta = load_meta("old-chat", data_dir)
        assert meta is not None
        assert meta.name == "old-chat"

    def test_returns_correct_count(self, tmp_path: Path):
        data_dir = tmp_path / "data"
        log_dir = tmp_path / "logs"
        data_dir.mkdir()

        ts = now_iso()
        for name in ("conv-a", "conv-b", "conv-c"):
            self._write_jsonl(log_dir, name, [{"ts": ts, "body": "msg"}])

        count = backfill_missing_metadata(data_dir, log_dir)
        assert count == 3

    def test_does_not_overwrite_existing_meta(self, tmp_path: Path):
        data_dir = tmp_path / "data"
        log_dir = tmp_path / "logs"
        data_dir.mkdir()

        # Create existing metadata
        ts = now_iso()
        existing = ConversationMeta(
            name="existing",
            topic="Original topic",
            created_by="alice",
            created_at=ts,
            last_activity=ts,
        )
        save_meta(existing, data_dir)

        # Create log file for same conversation
        self._write_jsonl(log_dir, "existing", [{"ts": ts, "body": "msg"}])

        count = backfill_missing_metadata(data_dir, log_dir)
        assert count == 0

        # Verify original metadata preserved
        loaded = load_meta("existing", data_dir)
        assert loaded is not None
        assert loaded.topic == "Original topic"
        assert loaded.created_by == "alice"

    def test_sets_created_by_to_system_backfill(self, tmp_path: Path):
        data_dir = tmp_path / "data"
        log_dir = tmp_path / "logs"
        data_dir.mkdir()

        ts = now_iso()
        self._write_jsonl(log_dir, "legacy", [{"ts": ts, "body": "msg"}])

        backfill_missing_metadata(data_dir, log_dir)

        meta = load_meta("legacy", data_dir)
        assert meta is not None
        assert meta.created_by == "system-backfill"

    def test_nonexistent_log_dir_returns_zero(self, tmp_path: Path):
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        count = backfill_missing_metadata(data_dir, tmp_path / "no-such-dir")
        assert count == 0


# ===================================================================
# 8. LastActivityTracker
# ===================================================================


class TestLastActivityTracker:
    def test_update_stores_timestamps_in_memory(self):
        tracker = LastActivityTracker()
        ts = now_iso()
        tracker.update("general", ts)
        assert tracker.get("general") == ts

    def test_get_returns_none_for_unknown(self):
        tracker = LastActivityTracker()
        assert tracker.get("nonexistent") is None

    def test_flush_all_writes_to_disk(self, tmp_path: Path):
        # Create a conversation with meta on disk
        ts_old = "2025-01-01T00:00:00+00:00"
        ts_new = now_iso()
        meta = ConversationMeta(
            name="test-conv",
            created_by="alice",
            created_at=ts_old,
            last_activity=ts_old,
        )
        save_meta(meta, tmp_path)

        tracker = LastActivityTracker()
        tracker.update("test-conv", ts_new)
        tracker.flush_all(tmp_path)

        # Verify disk updated
        loaded = load_meta("test-conv", tmp_path)
        assert loaded is not None
        assert loaded.last_activity == ts_new

        # Verify in-memory cleared
        assert tracker.get("test-conv") is None

    def test_flush_if_due_respects_interval(self, tmp_path: Path):
        ts_old = "2025-01-01T00:00:00+00:00"
        meta = ConversationMeta(
            name="test-conv",
            created_by="alice",
            created_at=ts_old,
            last_activity=ts_old,
        )
        save_meta(meta, tmp_path)

        tracker = LastActivityTracker()
        ts_new = now_iso()
        tracker.update("test-conv", ts_new)

        # Should NOT flush — interval not elapsed yet
        tracker.flush_if_due(tmp_path)
        loaded = load_meta("test-conv", tmp_path)
        assert loaded is not None
        assert loaded.last_activity == ts_old  # unchanged

        # Force the interval to be exceeded
        tracker._last_flush = time.monotonic() - 10.0
        tracker.flush_if_due(tmp_path)

        loaded = load_meta("test-conv", tmp_path)
        assert loaded is not None
        assert loaded.last_activity == ts_new  # now updated


# ===================================================================
# 9. tool_comms_conversation_create (integration)
# ===================================================================


class TestToolCommsConversationCreate:
    @pytest.mark.asyncio
    async def test_create_conversation(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        result = await tool_comms_conversation_create(
            registry,
            spy,
            key=key,
            conversation="design",
            topic="Design discussion",
            conv_data_dir=tmp_path,
        )

        assert result["status"] == "created"
        assert result["conversation"] == "design"
        assert result["topic"] == "Design discussion"

    @pytest.mark.asyncio
    async def test_publishes_system_messages(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry,
            spy,
            key=key,
            conversation="design",
            topic="Design discussion",
            conv_data_dir=tmp_path,
        )

        # Should publish to both the new conversation and general
        assert spy.call_count == 2
        topics = [call[0] for call in spy.calls]
        assert "claude-comms/conv/design/messages" in topics
        assert "claude-comms/conv/general/messages" in topics

        # Verify system message content
        for _, payload, _retain in spy.calls:
            msg = json.loads(payload)
            assert "alice" in msg["body"]
            assert "design" in msg["body"]

    @pytest.mark.asyncio
    async def test_humans_auto_joined(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry,
            spy,
            key=key,
            conversation="design",
            conv_data_dir=tmp_path,
        )

        # Phil (human) should be auto-joined
        members = registry.members("design")
        member_names = {m.name for m in members}
        assert "Phil" in member_names
        assert "alice" in member_names

    @pytest.mark.asyncio
    async def test_duplicate_name_returns_error(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        result1 = await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        assert result1["status"] == "created"

        result2 = await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        assert result2.get("error") is True
        assert "already exists" in result2["message"]

    @pytest.mark.asyncio
    async def test_reserved_names_rejected(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        for reserved in RESERVED_CONVERSATION_NAMES:
            result = await tool_comms_conversation_create(
                registry, spy, key=key, conversation=reserved, conv_data_dir=tmp_path
            )
            assert result.get("error") is True
            # May fail as invalid conv ID or as reserved name depending on validation order
            assert (
                "reserved" in result["message"].lower()
                or "invalid" in result["message"].lower()
            )


# ===================================================================
# 10. tool_comms_conversation_update
# ===================================================================


class TestToolCommsConversationUpdate:
    @pytest.mark.asyncio
    async def test_update_topic(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        # Create the conversation first
        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        result = await tool_comms_conversation_update(
            registry,
            spy,
            key=key,
            conversation="design",
            topic="Updated topic",
            conv_data_dir=tmp_path,
        )

        assert result["status"] == "updated"
        assert result["topic"] == "Updated topic"

        # Verify meta.json on disk
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.topic == "Updated topic"

    @pytest.mark.asyncio
    async def test_posts_system_message(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        await tool_comms_conversation_update(
            registry,
            spy,
            key=key,
            conversation="design",
            topic="New topic",
            conv_data_dir=tmp_path,
        )

        assert spy.call_count == 1
        _, payload, _retain = spy.calls[0]
        msg = json.loads(payload)
        assert "alice" in msg["body"]
        assert "New topic" in msg["body"]

    @pytest.mark.asyncio
    async def test_rate_limiting_suppresses_system_message(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        rate_state: dict[str, float] = {}

        # First update — should post system message
        result1 = await tool_comms_conversation_update(
            registry,
            spy,
            key=key,
            conversation="design",
            topic="Topic v1",
            conv_data_dir=tmp_path,
            rate_limit_state=rate_state,
        )
        assert result1["system_message"] == "sent"
        assert spy.call_count == 1

        # Second update within 60s — system message suppressed
        result2 = await tool_comms_conversation_update(
            registry,
            spy,
            key=key,
            conversation="design",
            topic="Topic v2",
            conv_data_dir=tmp_path,
            rate_limit_state=rate_state,
        )
        assert result2["system_message"] == "suppressed (rate limited)"
        assert spy.call_count == 1  # no additional publish


# ===================================================================
# 11. tool_comms_invite
# ===================================================================


class TestToolCommsInvite:
    @pytest.mark.asyncio
    async def test_invite_existing_participant_success(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key_alice = _register(registry, name="alice")
        _register(registry, name="bob")

        # Create conversation and ensure alice is a member
        await tool_comms_conversation_create(
            registry, spy, key=key_alice, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        result = await tool_comms_invite(
            registry,
            spy,
            key=key_alice,
            conversation="design",
            target_name="bob",
            conv_data_dir=tmp_path,
        )

        assert result["status"] == "invited"
        assert spy.call_count == 1
        _, payload, _retain = spy.calls[0]
        msg = json.loads(payload)
        assert "bob" in msg["body"]
        assert "design" in msg["body"]

    @pytest.mark.asyncio
    async def test_invite_unknown_participant_error(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )

        result = await tool_comms_invite(
            registry,
            spy,
            key=key,
            conversation="design",
            target_name="nonexistent-user",
            conv_data_dir=tmp_path,
        )

        assert result.get("error") is True
        assert "Unknown" in result["message"] or "unknown" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_invite_to_nonexistent_conversation_error(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        # alice is in general but not in "nope" — should get not-a-member error
        result = await tool_comms_invite(
            registry,
            spy,
            key=key,
            conversation="nope",
            target_name="Phil",
            conv_data_dir=tmp_path,
        )

        assert result.get("error") is True

    @pytest.mark.asyncio
    async def test_caller_not_a_member_error(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key_alice = _register(registry, name="alice")
        # Side-effect-only registration; the test rebuilds `registry_clean`
        # below and uses that for the actual invite call.
        _register(registry, name="bob")

        # alice creates a conversation
        await tool_comms_conversation_create(
            registry, spy, key=key_alice, conversation="design", conv_data_dir=tmp_path
        )

        # bob is NOT a member of design (unless auto-joined as human)
        # Register bob as claude type so no auto-join
        registry_clean = ParticipantRegistry()
        p_alice = registry_clean.join("alice", "general", participant_type="claude")
        p_bob = registry_clean.join("bob", "general", participant_type="claude")

        create_conversation_atomic(
            "private", topic="", created_by="alice", data_dir=tmp_path
        )
        # Manually join alice to private
        registry_clean.join(
            "alice", "private", key=p_alice.key, participant_type="claude"
        )

        result = await tool_comms_invite(
            registry_clean,
            spy,
            key=p_bob.key,
            conversation="private",
            target_name="alice",
            conv_data_dir=tmp_path,
        )

        assert result.get("error") is True
        assert "Not a member" in result["message"]

    @pytest.mark.asyncio
    async def test_target_already_a_member(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key_alice = _register(registry, name="alice")
        key_bob = _register(registry, name="bob")

        await tool_comms_conversation_create(
            registry, spy, key=key_alice, conversation="design", conv_data_dir=tmp_path
        )

        # Manually join bob
        registry.join("bob", "design", key=key_bob, participant_type="claude")
        spy.calls.clear()

        result = await tool_comms_invite(
            registry,
            spy,
            key=key_alice,
            conversation="design",
            target_name="bob",
            conv_data_dir=tmp_path,
        )

        assert result["status"] == "already_member"
        assert spy.call_count == 0  # no system message


# ===================================================================
# 12. tool_comms_conversations with all=True
# ===================================================================


class TestToolCommsConversationsAll:
    def test_returns_all_conversations_including_unjoined(self, tmp_path: Path):
        registry = ParticipantRegistry()
        store = MessageStore()
        key = _register(registry, name="alice")

        # Create some conversations on disk
        for name in ("alpha", "beta", "gamma"):
            create_conversation_atomic(
                name, topic=f"{name} topic", created_by="system", data_dir=tmp_path
            )

        # alice is only in general (from _register)
        result = tool_comms_conversations(
            registry, store, key=key, all=True, conv_data_dir=tmp_path
        )

        assert "all_conversations" in result
        all_convs = result["all_conversations"]
        all_names = {c["name"] for c in all_convs}
        assert "alpha" in all_names
        assert "beta" in all_names
        assert "gamma" in all_names

    def test_all_conversations_include_expected_fields(self, tmp_path: Path):
        registry = ParticipantRegistry()
        store = MessageStore()
        key = _register(registry, name="alice")

        create_conversation_atomic(
            "test-conv", topic="Test", created_by="system", data_dir=tmp_path
        )

        result = tool_comms_conversations(
            registry, store, key=key, all=True, conv_data_dir=tmp_path
        )

        all_convs = result["all_conversations"]
        assert len(all_convs) >= 1

        conv_entry = next(c for c in all_convs if c["name"] == "test-conv")
        assert "topic" in conv_entry
        assert "member_count" in conv_entry
        assert "last_activity" in conv_entry
        assert "joined" in conv_entry
        assert conv_entry["topic"] == "Test"

    def test_joined_status_reflects_membership(self, tmp_path: Path):
        registry = ParticipantRegistry()
        store = MessageStore()
        key = _register(registry, name="alice")

        # alice is in general, not in private
        create_conversation_atomic(
            "private", topic="", created_by="system", data_dir=tmp_path
        )

        # Also create a general meta so it appears in all_conversations
        create_conversation_atomic(
            "general", topic="", created_by="system", data_dir=tmp_path
        )

        result = tool_comms_conversations(
            registry, store, key=key, all=True, conv_data_dir=tmp_path
        )

        all_convs = {c["name"]: c for c in result["all_conversations"]}
        assert all_convs["general"]["joined"] is True
        assert all_convs["private"]["joined"] is False

    def test_without_all_flag_no_all_conversations_key(self, tmp_path: Path):
        registry = ParticipantRegistry()
        store = MessageStore()
        key = _register(registry, name="alice")

        result = tool_comms_conversations(
            registry, store, key=key, all=False, conv_data_dir=tmp_path
        )

        assert "all_conversations" not in result


# ===================================================================
# 13. ConversationMeta.mark_deleted (v0.4.0 step 2.2)
# ===================================================================


class TestConversationMetaMarkDeleted:
    """Pure model-level tests for the new soft-delete fields and method."""

    def test_defaults_not_deleted(self):
        ts = now_iso()
        meta = ConversationMeta(
            name="x", created_by="a", created_at=ts, last_activity=ts
        )
        assert meta.deleted_at is None
        assert meta.deleted_by is None
        assert meta.is_deleted is False

    def test_mark_deleted_sets_both_fields(self):
        ts = now_iso()
        meta = ConversationMeta(
            name="x", created_by="a", created_at=ts, last_activity=ts
        )
        meta.mark_deleted("alice")
        assert meta.deleted_by == "alice"
        assert meta.deleted_at is not None
        assert meta.is_deleted is True

    def test_mark_deleted_persists_via_save_meta(self, tmp_path: Path):
        ts = now_iso()
        meta = ConversationMeta(
            name="design", created_by="alice", created_at=ts, last_activity=ts
        )
        save_meta(meta, tmp_path)
        meta.mark_deleted("alice")
        save_meta(meta, tmp_path)

        reloaded = load_meta("design", tmp_path)
        assert reloaded is not None
        assert reloaded.is_deleted is True
        assert reloaded.deleted_by == "alice"
        assert reloaded.deleted_at == meta.deleted_at

    def test_is_deleted_requires_both_fields(self):
        # Defensive: a partial state (manual JSON edit) reads as live so
        # the conversation stays recoverable.
        ts = now_iso()
        meta = ConversationMeta(
            name="x",
            created_by="a",
            created_at=ts,
            last_activity=ts,
            deleted_at=ts,
            deleted_by=None,
        )
        assert meta.is_deleted is False


# ===================================================================
# 14. tool_comms_conversation_delete — v0.4.0 step 2.2
# ===================================================================


class TestToolCommsConversationDelete:
    """End-to-end tests for the new soft-delete tool function."""

    @pytest.mark.asyncio
    async def test_confirm_false_returns_structured_error(self, tmp_path: Path):
        """confirm=False must return ``confirm_required`` with counts, NO publishes."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        # Create the conversation as alice (so alice is the creator)
        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        # Seed two messages so message_count is non-zero
        store.add(
            "design",
            {
                "id": "m1",
                "ts": now_iso(),
                "sender": {"key": alice_key, "name": "alice", "type": "claude"},
                "body": "hello",
                "conv": "design",
            },
        )
        store.add(
            "design",
            {
                "id": "m2",
                "ts": now_iso(),
                "sender": {"key": alice_key, "name": "alice", "type": "claude"},
                "body": "world",
                "conv": "design",
            },
        )

        result = await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=False,
            conv_data_dir=tmp_path,
        )

        assert result == {
            "error": "confirm_required",
            "message_count": 2,
            "member_count": len(registry.members("design")),
        }
        # No mutations and no MQTT publishes on the pre-flight branch.
        assert spy.call_count == 0
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.is_deleted is False

    @pytest.mark.asyncio
    async def test_non_creator_rejected(self, tmp_path: Path):
        """Only the creator may delete (v0.4.0 creator-only rule)."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")
        bob_key = _register(registry, name="bob")

        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        # bob joins design but is NOT the creator
        registry.join("bob", "design", key=bob_key, participant_type="claude")
        spy.calls.clear()

        result = await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=bob_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        assert result.get("error") is True
        assert "creator" in result["message"].lower()
        assert spy.call_count == 0
        # Conversation still alive
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.is_deleted is False

    @pytest.mark.asyncio
    async def test_confirm_true_returns_deleted(self, tmp_path: Path):
        """confirm=True returns ``{deleted: True, conversation_id: ...}``."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        result = await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        assert result == {"deleted": True, "conversation_id": "design"}

    @pytest.mark.asyncio
    async def test_publishes_retained_orphan_banner(self, tmp_path: Path):
        """Step 1: final retained ``{type: deleted, ...}`` on ``conv/{id}/messages``."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        # Find the messages-topic publish
        msg_calls = [
            (topic, payload, retain)
            for (topic, payload, retain) in spy.calls
            if topic == "claude-comms/conv/design/messages"
        ]
        assert len(msg_calls) == 1
        _, payload, retain = msg_calls[0]
        assert retain is True, "orphan banner MUST be retained"
        parsed = json.loads(payload)
        assert parsed["type"] == "deleted"
        assert parsed["conversationId"] == "design"
        assert parsed["deletedBy"] == "alice"
        assert "timestamp" in parsed

    @pytest.mark.asyncio
    async def test_publishes_lifecycle_event(self, tmp_path: Path):
        """Step 2: ``conversation_deleted`` event on ``system/conversations``."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        lifecycle_calls = [
            (topic, payload, retain)
            for (topic, payload, retain) in spy.calls
            if topic == "claude-comms/system/conversations"
        ]
        assert len(lifecycle_calls) == 1
        _, payload, _retain = lifecycle_calls[0]
        parsed = json.loads(payload)
        assert parsed["type"] == "conversation_deleted"
        assert parsed["name"] == "design"
        assert parsed["deleted_by"] == "alice"
        assert "ts" in parsed

    @pytest.mark.asyncio
    async def test_retained_clear_all_member_presence(self, tmp_path: Path):
        """Step 4: every member's per-conv presence topic gets retained-cleared."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")
        bob_key = _register(registry, name="bob")
        carol_key = _register(registry, name="carol")

        # Create conv as alice; auto-joins humans (Phil); then add bob+carol
        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        registry.join("bob", "design", key=bob_key, participant_type="claude")
        registry.join("carol", "design", key=carol_key, participant_type="claude")
        spy.calls.clear()

        member_keys_before = {m.key for m in registry.members("design")}
        assert len(member_keys_before) >= 3  # alice, bob, carol (and Phil)

        await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        # Every member should get a retained-clear (empty payload, retain=True)
        # on claude-comms/conv/design/presence/{key}
        cleared = set()
        for topic, payload, retain in spy.calls:
            prefix = "claude-comms/conv/design/presence/"
            if topic.startswith(prefix):
                assert payload == b"", "retained-clear must use empty payload"
                assert retain is True, "retained-clear must use retain=True"
                cleared.add(topic.removeprefix(prefix))

        # All pre-deletion members should have been cleared.
        assert cleared == member_keys_before

    @pytest.mark.asyncio
    async def test_persists_deleted_state_on_disk(self, tmp_path: Path):
        """Step 3: meta.json is updated with ``deleted_at`` + ``deleted_by``."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )

        await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        # History on disk is preserved -- only the meta is updated.
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.is_deleted is True
        assert meta.deleted_by == "alice"
        assert meta.deleted_at is not None

    @pytest.mark.asyncio
    async def test_drops_memberships(self, tmp_path: Path):
        """After delete, members no longer have the conv in ``conversations_for``."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")
        bob_key = _register(registry, name="bob")

        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        registry.join("bob", "design", key=bob_key, participant_type="claude")
        assert "design" in registry.conversations_for(bob_key)

        await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        assert "design" not in registry.conversations_for(bob_key)
        assert "design" not in registry.conversations_for(alice_key)

    @pytest.mark.asyncio
    async def test_reserved_conversation_rejected(self, tmp_path: Path):
        """``general`` and ``system`` are reserved -- delete must error."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        # Bootstrap a real general conversation owned by 'alice' so the
        # authorization check would otherwise pass.
        create_conversation_atomic(
            "general", topic="", created_by="alice", data_dir=tmp_path
        )

        result = await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="general",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        assert result.get("error") is True
        assert "reserved" in result["message"].lower()
        assert spy.call_count == 0

    @pytest.mark.asyncio
    async def test_nonexistent_conversation_rejected(self, tmp_path: Path):
        """Deleting an unknown conversation returns a clean ``not found`` error."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        result = await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="ghost",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        assert result.get("error") is True
        assert "not found" in result["message"].lower()
        assert spy.call_count == 0

    @pytest.mark.asyncio
    async def test_double_delete_rejected(self, tmp_path: Path):
        """Re-deleting an already-deleted conversation returns an error."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        spy.calls.clear()

        # Second delete must be a no-op at the protocol level (no
        # republished orphan banners / lifecycle events).
        result = await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key=alice_key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result.get("error") is True
        assert "already deleted" in result["message"].lower()
        assert spy.call_count == 0

    @pytest.mark.asyncio
    async def test_unknown_key_rejected(self, tmp_path: Path):
        """An unregistered caller key fails the standard validation gate."""
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        alice_key = _register(registry, name="alice")
        await tool_comms_conversation_create(
            registry, spy, key=alice_key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        result = await tool_comms_conversation_delete(
            registry,
            store,
            spy,
            key="00000000",
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result.get("error") is True
        assert spy.call_count == 0


class TestConversationMetaArchiveTransitions:
    def _fresh_meta(self) -> ConversationMeta:
        ts = now_iso()
        return ConversationMeta(
            name="design",
            topic="Design discussion",
            created_by="alice",
            created_at=ts,
            last_activity=ts,
        )

    def test_mark_archived_sets_flag(self):
        meta = self._fresh_meta()
        assert meta.archived is False
        meta.mark_archived(archived_by="alice")
        assert meta.archived is True

    def test_mark_archived_stamps_timestamp_and_actor(self):
        meta = self._fresh_meta()
        before = now_iso()
        meta.mark_archived(archived_by="alice")
        after = now_iso()
        assert meta.archived_at is not None
        # ISO 8601 strings sort lexicographically when they share format
        assert before <= meta.archived_at <= after
        assert meta.archived_by == "alice"

    def test_mark_unarchived_clears_state(self):
        meta = self._fresh_meta()
        meta.mark_archived(archived_by="alice")
        assert meta.archived is True
        meta.mark_unarchived()
        assert meta.archived is False
        assert meta.archived_at is None
        assert meta.archived_by is None

    def test_archive_unarchive_round_trip_through_disk(self, tmp_path: Path):
        meta = self._fresh_meta()
        meta.mark_archived(archived_by="alice")
        save_meta(meta, tmp_path)

        loaded = load_meta("design", tmp_path)
        assert loaded is not None
        assert loaded.archived is True
        assert loaded.archived_at is not None
        assert loaded.archived_by == "alice"

        loaded.mark_unarchived()
        save_meta(loaded, tmp_path)

        re_loaded = load_meta("design", tmp_path)
        assert re_loaded is not None
        assert re_loaded.archived is False
        assert re_loaded.archived_at is None
        assert re_loaded.archived_by is None


# ===================================================================
# 2. save_meta + load_meta round-trip
# ===================================================================


class TestToolCommsConversationArchive:
    @pytest.mark.asyncio
    async def test_archive_requires_confirm(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )

        # No confirm flag → confirm_required + blast radius
        result = await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        assert result.get("error") == "confirm_required"
        assert "member_count" in result
        assert "message_count" in result
        # State on disk must NOT have flipped
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.archived is False

    @pytest.mark.asyncio
    async def test_archive_commits_with_confirm(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        spy.calls.clear()

        result = await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result["archived"] is True
        assert result["conversation_id"] == "design"
        assert result["archived_by"] == "alice"
        assert result["archived_at"] is not None

        # Disk state must reflect archive
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.archived is True
        assert meta.archived_by == "alice"
        assert meta.archived_at is not None

    @pytest.mark.asyncio
    async def test_archive_preserves_history(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        # Stash some history into the message store
        for i in range(3):
            store.add(
                "design",
                {
                    "id": f"msg-{i}",
                    "ts": f"2026-05-12T10:0{i}:00-05:00",
                    "sender": {"key": key, "name": "alice", "type": "claude"},
                    "body": f"hi {i}",
                    "conv": "design",
                },
            )

        await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        # History intact post-archive
        msgs = store.get("design")
        assert len(msgs) == 3
        assert [m["id"] for m in msgs] == ["msg-0", "msg-1", "msg-2"]

    @pytest.mark.asyncio
    async def test_archive_ejects_all_members(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key_alice = _register(registry, name="alice")
        key_bob = _register(registry, name="bob")

        await tool_comms_conversation_create(
            registry,
            spy,
            key=key_alice,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        # Manually join bob (claude) so we can verify eviction
        registry.join("bob", "design", key=key_bob, participant_type="claude")

        members_before = {m.key for m in registry.members("design")}
        assert key_alice in members_before
        assert key_bob in members_before

        result = await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key_alice,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        # All members evicted, evicted_keys covers them
        assert key_alice in result["evicted_keys"]
        assert key_bob in result["evicted_keys"]
        assert registry.members("design") == []
        # And each member's conversation list no longer contains "design"
        assert "design" not in registry.conversations_for(key_alice)
        assert "design" not in registry.conversations_for(key_bob)

    @pytest.mark.asyncio
    async def test_archive_blocks_subsequent_sends(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        # Even if the caller re-joins via registry, send should be rejected
        # at the archived-guard since meta.archived is True on disk.
        registry.join("alice", "design", key=key, participant_type="claude")
        send_result = await tool_comms_send(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            message="hello to the dead",
            conv_data_dir=tmp_path,
        )
        assert send_result.get("error") == "conversation_archived"
        assert send_result.get("conversation_id") == "design"

    @pytest.mark.asyncio
    async def test_archive_creator_only(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key_alice = _register(registry, name="alice")
        key_bob = _register(registry, name="bob")

        await tool_comms_conversation_create(
            registry,
            spy,
            key=key_alice,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        registry.join("bob", "design", key=key_bob, participant_type="claude")

        # bob is a member but not the creator — archive must be rejected
        result = await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key_bob,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result.get("error") == "not_authorized"
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.archived is False

    @pytest.mark.asyncio
    async def test_archive_reserved_name_rejected(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        # Reserved names cannot be archived even by a "creator" if their
        # meta exists (general is auto-created by the daemon).
        create_conversation_atomic(
            "general", topic="", created_by="alice", data_dir=tmp_path
        )

        result = await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="general",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result.get("error") == "invalid_target"

    @pytest.mark.asyncio
    async def test_archive_unknown_conversation(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        result = await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="nope",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result.get("error") is True
        assert "not found" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_archive_idempotent_when_already_archived(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        # Second archive call → already_archived, no new evicted_keys list
        result = await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        assert result.get("archived") is True
        assert result.get("status") == "already_archived"
        assert "evicted_keys" not in result


# ===================================================================
# 14. tool_comms_conversation_unarchive (v0.4.0 Step 2.3)
# ===================================================================


class TestToolCommsConversationUnarchive:
    @pytest.mark.asyncio
    async def test_unarchive_reverses_state(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        result = await tool_comms_conversation_unarchive(
            registry,
            spy,
            key=key,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        assert result["archived"] is False
        assert result["conversation_id"] == "design"

        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.archived is False
        assert meta.archived_at is None
        assert meta.archived_by is None

    @pytest.mark.asyncio
    async def test_unarchive_does_not_re_join_members(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key_alice = _register(registry, name="alice")
        key_bob = _register(registry, name="bob")

        await tool_comms_conversation_create(
            registry,
            spy,
            key=key_alice,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        registry.join("bob", "design", key=key_bob, participant_type="claude")

        await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key_alice,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        await tool_comms_conversation_unarchive(
            registry,
            spy,
            key=key_alice,
            conversation="design",
            conv_data_dir=tmp_path,
        )

        # Members were ejected on archive and unarchive does not re-join
        assert "design" not in registry.conversations_for(key_alice)
        assert "design" not in registry.conversations_for(key_bob)

    @pytest.mark.asyncio
    async def test_unarchive_creator_only(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key_alice = _register(registry, name="alice")
        key_bob = _register(registry, name="bob")

        await tool_comms_conversation_create(
            registry,
            spy,
            key=key_alice,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key_alice,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )

        # bob (not creator) cannot unarchive
        result = await tool_comms_conversation_unarchive(
            registry,
            spy,
            key=key_bob,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        assert result.get("error") == "not_authorized"
        meta = load_meta("design", tmp_path)
        assert meta is not None
        assert meta.archived is True

    @pytest.mark.asyncio
    async def test_unarchive_idempotent_when_live(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )

        # Conversation is already live → idempotent already_live response
        result = await tool_comms_conversation_unarchive(
            registry,
            spy,
            key=key,
            conversation="design",
            conv_data_dir=tmp_path,
        )
        assert result.get("archived") is False
        assert result.get("status") == "already_live"

    @pytest.mark.asyncio
    async def test_unarchive_allows_send_again(self, tmp_path: Path):
        registry = _registry_with_humans()
        spy = PublishSpy()
        store = MessageStore()
        key = _register(registry, name="alice")

        await tool_comms_conversation_create(
            registry, spy, key=key, conversation="design", conv_data_dir=tmp_path
        )
        await tool_comms_conversation_archive(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            confirm=True,
            conv_data_dir=tmp_path,
        )
        await tool_comms_conversation_unarchive(
            registry,
            spy,
            key=key,
            conversation="design",
            conv_data_dir=tmp_path,
        )

        # Re-join (eviction was permanent) and verify send is permitted
        registry.join("alice", "design", key=key, participant_type="claude")
        result = await tool_comms_send(
            registry,
            spy,
            store,
            key=key,
            conversation="design",
            message="we are back",
            conv_data_dir=tmp_path,
        )
        assert result.get("status") == "sent"


# ===================================================================
# 15. comms_conversations(all=True) surfaces archive flag (v0.4.0 Step 2.3)
# ===================================================================


class TestCommsConversationsArchiveFlag:
    def test_all_conversations_entries_carry_archived_fields(self, tmp_path: Path):
        registry = ParticipantRegistry()
        store = MessageStore()
        key = _register(registry, name="alice")

        # Live conversation
        create_conversation_atomic(
            "live", topic="", created_by="alice", data_dir=tmp_path
        )
        # Archived conversation (synthesise on disk directly to avoid the
        # full tool_comms_conversation_archive surface in this unit test)
        meta_arch = ConversationMeta(
            name="dead",
            topic="",
            created_by="alice",
            created_at=now_iso(),
            last_activity=now_iso(),
        )
        meta_arch.mark_archived(archived_by="alice")
        save_meta(meta_arch, tmp_path)

        result = tool_comms_conversations(
            registry, store, key=key, all=True, conv_data_dir=tmp_path
        )

        by_name = {c["name"]: c for c in result["all_conversations"]}
        assert by_name["live"]["archived"] is False
        assert by_name["live"]["archived_at"] is None
        assert by_name["live"]["archived_by"] is None

        assert by_name["dead"]["archived"] is True
        assert by_name["dead"]["archived_at"] is not None
        assert by_name["dead"]["archived_by"] == "alice"
