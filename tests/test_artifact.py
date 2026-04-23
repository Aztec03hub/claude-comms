"""Unit tests for artifact storage and MCP tools."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_comms.artifact import (
    Artifact,
    ArtifactVersion,
    DEFAULT_GET_CHUNK_SIZE,
    MAX_VERSIONS,
    delete_artifact,
    list_artifacts,
    load_artifact,
    save_artifact,
    validate_artifact_name,
)
from claude_comms.message import Sender, now_iso
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_artifact_create,
    tool_comms_artifact_get,
    tool_comms_artifact_update,
    tool_comms_join,
)

from conftest import PublishSpy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sender(key: str = "ab12cd34", name: str = "test-user", type: str = "human") -> Sender:
    return Sender(key=key, name=name, type=type)


def _make_artifact(
    name: str = "test-artifact",
    conversation: str = "general",
    content: str = "# Hello",
    num_versions: int = 1,
) -> Artifact:
    sender = _sender()
    versions = [
        ArtifactVersion(
            version=i + 1,
            content=f"{content} v{i + 1}",
            author=sender,
            summary=f"v{i + 1}",
        )
        for i in range(num_versions)
    ]
    return Artifact(
        name=name,
        title="Test Artifact",
        type="doc",
        conversation_id=conversation,
        created_by=sender,
        versions=versions,
    )


async def _register_participant(
    registry: ParticipantRegistry,
    name: str = "test-claude",
    conversation: str = "general",
) -> dict:
    """Register a participant and return the join result (includes 'key')."""
    result = await tool_comms_join(registry, name=name, conversation=conversation)
    assert "error" not in result
    return result


# ===================================================================
# validate_artifact_name
# ===================================================================


class TestValidateArtifactName:
    """Smoke tests for the legacy names that must still pass the new validator.

    More extensive coverage lives in ``test_artifact_naming.py``.
    """

    @pytest.mark.parametrize("name", ["a", "backend-plan", "my-api-spec", "abc123"])
    def test_valid_names(self, name: str):
        ok, err = validate_artifact_name(name)
        assert ok is True
        assert err == ""

    @pytest.mark.parametrize(
        "name",
        [
            "",            # empty
            "bad-",        # trailing hyphen
            "has/slash",   # forbidden char
            " leading",    # leading space
            ".hidden",     # leading dot
            "a" * 129,     # over length cap
        ],
    )
    def test_invalid_names(self, name: str):
        ok, _err = validate_artifact_name(name)
        assert ok is False


# ===================================================================
# ArtifactVersion model
# ===================================================================


class TestArtifactVersion:
    def test_create_with_required_fields(self):
        v = ArtifactVersion(version=1, content="hello", author=_sender())
        assert v.version == 1
        assert v.content == "hello"
        assert v.author.name == "test-user"

    def test_summary_defaults_to_empty(self):
        v = ArtifactVersion(version=1, content="x", author=_sender())
        assert v.summary == ""

    def test_timestamp_auto_generated(self):
        v = ArtifactVersion(version=1, content="x", author=_sender())
        assert v.timestamp  # non-empty
        assert "T" in v.timestamp  # looks like ISO 8601


# ===================================================================
# Artifact model
# ===================================================================


class TestArtifactModel:
    def test_create_with_all_fields(self):
        a = _make_artifact()
        assert a.name == "test-artifact"
        assert a.title == "Test Artifact"
        assert a.type == "doc"
        assert len(a.versions) == 1

    def test_uuid_auto_generated(self):
        a = _make_artifact()
        assert a.id  # non-empty
        assert len(a.id) == 36  # UUID4 format

    def test_uuid_can_be_provided(self):
        a = Artifact(
            id="custom-id",
            name="x",
            title="X",
            type="plan",
            conversation_id="general",
            created_by=_sender(),
        )
        assert a.id == "custom-id"

    @pytest.mark.parametrize("t", ["plan", "doc", "code"])
    def test_valid_types(self, t: str):
        a = Artifact(
            name="x",
            title="X",
            type=t,
            conversation_id="general",
            created_by=_sender(),
        )
        assert a.type == t

    def test_invalid_type_rejected(self):
        with pytest.raises(Exception):  # Pydantic ValidationError
            Artifact(
                name="x",
                title="X",
                type="invalid",
                conversation_id="general",
                created_by=_sender(),
            )


# ===================================================================
# save_artifact + load_artifact round-trip
# ===================================================================


class TestSaveLoadRoundTrip:
    def test_round_trip(self, tmp_path: Path):
        original = _make_artifact(conversation="general")
        save_artifact(original, tmp_path)

        loaded = load_artifact("general", "test-artifact", tmp_path)
        assert loaded is not None
        assert loaded.id == original.id
        assert loaded.name == original.name
        assert loaded.title == original.title
        assert loaded.type == original.type
        assert loaded.conversation_id == original.conversation_id
        assert loaded.created_by == original.created_by
        assert len(loaded.versions) == len(original.versions)
        assert loaded.versions[0].content == original.versions[0].content

    def test_no_tmp_files_left(self, tmp_path: Path):
        artifact = _make_artifact(conversation="general")
        save_artifact(artifact, tmp_path)

        conv_dir = tmp_path / "general"
        tmp_files = list(conv_dir.glob("*.tmp"))
        assert tmp_files == []

    def test_creates_conversation_directory(self, tmp_path: Path):
        artifact = _make_artifact(conversation="new-conv")
        save_artifact(artifact, tmp_path)

        assert (tmp_path / "new-conv").is_dir()
        assert (tmp_path / "new-conv" / "test-artifact.json").is_file()


# ===================================================================
# save_artifact version pruning
# ===================================================================


class TestVersionPruning:
    def test_prunes_to_max_versions(self, tmp_path: Path):
        total = MAX_VERSIONS + 10
        artifact = _make_artifact(conversation="general", num_versions=total)
        assert len(artifact.versions) == total

        save_artifact(artifact, tmp_path)
        loaded = load_artifact("general", "test-artifact", tmp_path)

        assert loaded is not None
        assert len(loaded.versions) == MAX_VERSIONS
        # Newest versions kept (last MAX_VERSIONS)
        assert loaded.versions[0].version == total - MAX_VERSIONS + 1
        assert loaded.versions[-1].version == total


# ===================================================================
# load_artifact edge cases
# ===================================================================


class TestLoadArtifactEdgeCases:
    def test_nonexistent_returns_none(self, tmp_path: Path):
        result = load_artifact("general", "nope", tmp_path)
        assert result is None

    def test_malformed_json_returns_none(self, tmp_path: Path):
        conv_dir = tmp_path / "general"
        conv_dir.mkdir(parents=True)
        (conv_dir / "bad.json").write_text("not valid json {{{", encoding="utf-8")

        result = load_artifact("general", "bad", tmp_path)
        assert result is None


# ===================================================================
# list_artifacts
# ===================================================================


class TestListArtifacts:
    def test_empty_directory_returns_empty(self, tmp_path: Path):
        assert list_artifacts("nonexistent", tmp_path) == []

    def test_lists_multiple_artifacts(self, tmp_path: Path):
        for name in ["alpha", "beta", "gamma"]:
            artifact = _make_artifact(name=name, conversation="general")
            artifact.title = f"Title {name}"
            save_artifact(artifact, tmp_path)

        results = list_artifacts("general", tmp_path)
        assert len(results) == 3
        names = {r["name"] for r in results}
        assert names == {"alpha", "beta", "gamma"}

    def test_no_content_in_list_response(self, tmp_path: Path):
        save_artifact(_make_artifact(conversation="general"), tmp_path)

        results = list_artifacts("general", tmp_path)
        assert len(results) == 1
        entry = results[0]
        assert "content" not in entry
        assert "name" in entry
        assert "title" in entry
        assert "type" in entry
        assert "version_count" in entry

    def test_includes_latest_version_metadata(self, tmp_path: Path):
        artifact = _make_artifact(conversation="general", num_versions=3)
        save_artifact(artifact, tmp_path)

        results = list_artifacts("general", tmp_path)
        entry = results[0]
        assert entry["version_count"] == 3
        assert entry["summary"] == "v3"


# ===================================================================
# delete_artifact
# ===================================================================


class TestDeleteArtifact:
    def test_delete_existing_returns_true(self, tmp_path: Path):
        save_artifact(_make_artifact(conversation="general"), tmp_path)
        assert delete_artifact("general", "test-artifact", tmp_path) is True

    def test_delete_nonexistent_returns_false(self, tmp_path: Path):
        assert delete_artifact("general", "nope", tmp_path) is False

    def test_file_actually_removed(self, tmp_path: Path):
        save_artifact(_make_artifact(conversation="general"), tmp_path)
        path = tmp_path / "general" / "test-artifact.json"
        assert path.is_file()

        delete_artifact("general", "test-artifact", tmp_path)
        assert not path.is_file()


# ===================================================================
# tool_comms_artifact_create (integration)
# ===================================================================


class TestToolCommsArtifactCreate:
    @pytest.mark.asyncio
    async def test_create_artifact(self, tmp_path: Path):
        registry = ParticipantRegistry()
        spy = PublishSpy()
        participant = await _register_participant(registry, name="alice", conversation="general")

        result = await tool_comms_artifact_create(
            registry,
            spy,
            key=participant["key"],
            conversation="general",
            name="my-plan",
            title="My Plan",
            type="plan",
            content="# Plan\nStep 1",
            data_dir=tmp_path,
        )

        assert result["status"] == "created"
        assert result["name"] == "my-plan"
        assert result["version"] == 1

    @pytest.mark.asyncio
    async def test_publishes_system_message(self, tmp_path: Path):
        registry = ParticipantRegistry()
        spy = PublishSpy()
        participant = await _register_participant(registry, name="alice", conversation="general")

        await tool_comms_artifact_create(
            registry,
            spy,
            key=participant["key"],
            conversation="general",
            name="my-plan",
            title="My Plan",
            type="plan",
            content="content",
            data_dir=tmp_path,
        )

        assert spy.call_count == 1
        topic, payload = spy.calls[0]
        assert "general" in topic
        msg = json.loads(payload)
        assert "[artifact]" in msg["body"]
        assert "alice" in msg["body"]

    @pytest.mark.asyncio
    async def test_duplicate_name_returns_error(self, tmp_path: Path):
        registry = ParticipantRegistry()
        spy = PublishSpy()
        participant = await _register_participant(registry, name="alice", conversation="general")

        kwargs = dict(
            key=participant["key"],
            conversation="general",
            name="dupe",
            title="Dupe",
            type="doc",
            content="x",
            data_dir=tmp_path,
        )

        result1 = await tool_comms_artifact_create(registry, spy, **kwargs)
        assert result1["status"] == "created"

        result2 = await tool_comms_artifact_create(registry, spy, **kwargs)
        assert result2.get("error") is True
        # Either the case-insensitive collision check or the "already exists"
        # check must fire; both are valid duplicate-name rejections.
        assert (
            "already exists" in result2["message"]
            or "collides" in result2["message"]
        )


# ===================================================================
# tool_comms_artifact_get (chunked reading)
# ===================================================================


class TestToolCommsArtifactGet:
    def test_chunked_read_large_content(self, tmp_path: Path):
        registry = ParticipantRegistry()
        p = registry.join("bob", "general")
        participant = {"key": p.key, "name": p.name}

        # Create artifact with large content directly on disk
        large_content = "x" * 100_000
        artifact = Artifact(
            name="big",
            title="Big Doc",
            type="doc",
            conversation_id="general",
            created_by=_sender(key=participant["key"], name="bob"),
            versions=[
                ArtifactVersion(
                    version=1,
                    content=large_content,
                    author=_sender(key=participant["key"], name="bob"),
                )
            ],
        )
        save_artifact(artifact, tmp_path)

        result = tool_comms_artifact_get(
            registry,
            key=participant["key"],
            conversation="general",
            name="big",
            data_dir=tmp_path,
        )

        assert result["total_chars"] == 100_000
        assert result["has_more"] is True
        assert result["next_offset"] == DEFAULT_GET_CHUNK_SIZE
        assert len(result["content"]) == DEFAULT_GET_CHUNK_SIZE

    def test_read_with_offset(self, tmp_path: Path):
        registry = ParticipantRegistry()
        p = registry.join("bob", "general")
        participant = {"key": p.key, "name": p.name}

        content = "ABCDE" * 20_000  # 100K chars
        artifact = Artifact(
            name="big",
            title="Big Doc",
            type="doc",
            conversation_id="general",
            created_by=_sender(key=participant["key"], name="bob"),
            versions=[
                ArtifactVersion(
                    version=1,
                    content=content,
                    author=_sender(key=participant["key"], name="bob"),
                )
            ],
        )
        save_artifact(artifact, tmp_path)

        result = tool_comms_artifact_get(
            registry,
            key=participant["key"],
            conversation="general",
            name="big",
            offset=50_000,
            limit=10,
            data_dir=tmp_path,
        )

        assert result["offset"] == 50_000
        assert result["content"] == content[50_000:50_010]
        assert result["has_more"] is True


# ===================================================================
# tool_comms_artifact_update (optimistic concurrency)
# ===================================================================


class TestToolCommsArtifactUpdate:
    @pytest.mark.asyncio
    async def test_update_with_correct_base_version(self, tmp_path: Path):
        registry = ParticipantRegistry()
        spy = PublishSpy()
        participant = await _register_participant(registry, name="carol", conversation="general")
        key = participant["key"]

        # Create initial artifact
        await tool_comms_artifact_create(
            registry, spy, key=key, conversation="general",
            name="updatable", title="Updatable", type="doc",
            content="v1 content", data_dir=tmp_path,
        )

        # Update with correct base_version
        result = await tool_comms_artifact_update(
            registry, spy, key=key, conversation="general",
            name="updatable", content="v2 content",
            summary="updated text", base_version=1, data_dir=tmp_path,
        )

        assert result["status"] == "updated"
        assert result["version"] == 2

    @pytest.mark.asyncio
    async def test_update_with_wrong_base_version(self, tmp_path: Path):
        registry = ParticipantRegistry()
        spy = PublishSpy()
        participant = await _register_participant(registry, name="carol", conversation="general")
        key = participant["key"]

        await tool_comms_artifact_create(
            registry, spy, key=key, conversation="general",
            name="updatable", title="Updatable", type="doc",
            content="v1 content", data_dir=tmp_path,
        )

        # Update with wrong base_version
        result = await tool_comms_artifact_update(
            registry, spy, key=key, conversation="general",
            name="updatable", content="conflict",
            base_version=99, data_dir=tmp_path,
        )

        assert result.get("error") is True
        assert "conflict" in result["message"].lower() or "version" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_update_without_base_version_succeeds(self, tmp_path: Path):
        registry = ParticipantRegistry()
        spy = PublishSpy()
        participant = await _register_participant(registry, name="carol", conversation="general")
        key = participant["key"]

        await tool_comms_artifact_create(
            registry, spy, key=key, conversation="general",
            name="updatable", title="Updatable", type="doc",
            content="v1 content", data_dir=tmp_path,
        )

        # Update without base_version (no concurrency check)
        result = await tool_comms_artifact_update(
            registry, spy, key=key, conversation="general",
            name="updatable", content="v2 content",
            summary="no base check", data_dir=tmp_path,
        )

        assert result["status"] == "updated"
        assert result["version"] == 2
