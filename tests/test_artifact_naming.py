"""Tests for Windows-filesystem-compatible permissive artifact naming.

Covers:
- ``validate_artifact_name`` — 30+ cases from the plan §8 test corpus
- ``Artifact`` Pydantic model NFC auto-normalization
- ``migrate_artifact_names_to_nfc`` — rename, collision quarantine, idempotency
- Case-insensitive collision detection at create time via ``tool_comms_artifact_create``
"""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path

import pytest

from claude_comms.artifact import (
    Artifact,
    ArtifactVersion,
    _normalize_name,
    migrate_artifact_names_to_nfc,
    save_artifact,
    validate_artifact_name,
)
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    tool_comms_artifact_create,
    tool_comms_join,
)
from claude_comms.message import Sender

from conftest import PublishSpy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sender(key: str = "ab12cd34", name: str = "test-user") -> Sender:
    return Sender(key=key, name=name, type="human")


# ---------------------------------------------------------------------------
# Valid-name corpus
# ---------------------------------------------------------------------------


VALID_NAMES = [
    "Notes",                    # mixed case
    "my-plan",                  # legacy lowercase+hyphen
    "API Spec v2",              # spaces
    "project_alpha.md",         # mixed punctuation, dot, underscore
    "Q&A session",              # ampersand
    "план",                     # Cyrillic Unicode
    "build (2026-04)",          # parens + space + hyphen
    "x",                        # single char
    "a.b.c.d",                  # multiple dots OK
    "a" * 128,                  # exactly at length cap
    "backend-plan",             # legacy migration
    "my-api-spec",              # legacy migration
    "abc123",                   # alphanumeric
    "Foo",                      # capitalized
    "hello world",              # space
    "v1.2.3-rc1",               # tag-like
]


@pytest.mark.parametrize("name", VALID_NAMES)
def test_valid_names(name: str):
    ok, err = validate_artifact_name(name)
    assert ok is True, f"Expected {name!r} to be valid, got error: {err}"
    assert err == ""


# ---------------------------------------------------------------------------
# Invalid-name corpus
# ---------------------------------------------------------------------------


INVALID_NAMES = [
    ("", "empty"),
    ("a" * 129, "over length cap"),
    ("CON", "Windows reserved"),
    ("con.txt", "reserved stem with suffix"),
    ("PRN.log", "reserved stem with suffix"),
    ("COM1", "reserved COM device"),
    ("LPT9.dat", "reserved LPT stem"),
    ("name.", "trailing dot"),
    ("name ", "trailing space"),
    (" name", "leading space"),
    (".hidden", "leading dot"),
    ("foo..bar", "double dot sequence"),
    ("bad/slash", "forward slash"),
    ("bad\\backslash", "backslash"),
    ("bad:colon", "colon"),
    ('bad"quote', "double quote"),
    ("bad<lt>", "less-than"),
    ("bad>gt", "greater-than"),
    ("bad|pipe", "pipe"),
    ("bad?q", "question mark"),
    ("bad*star", "asterisk"),
    ("bad\x00null", "NUL byte"),
    ("bad\nnewline", "newline"),
    ("bad\ttab", "tab"),
    ("bad\rcr", "carriage return"),
    ("bad`backtick", "backtick"),
    ("data.json", ".json suffix"),
    ("PLAN.JSON", ".json suffix uppercase"),
    ("foo／bar", "fullwidth solidus U+FF0F"),
    ("full｜pipe", "fullwidth vertical bar U+FF5C"),
    ("trailing-", "trailing hyphen"),
    ("trailing_", "trailing underscore"),
]


@pytest.mark.parametrize("name,reason", INVALID_NAMES)
def test_invalid_names(name: str, reason: str):
    ok, err = validate_artifact_name(name)
    assert ok is False, f"Expected {name!r} ({reason}) to be invalid, but passed"
    assert err, f"Invalid name {name!r} must return a non-empty error message"


# ---------------------------------------------------------------------------
# Return-type contract
# ---------------------------------------------------------------------------


def test_validator_returns_tuple():
    result = validate_artifact_name("Notes")
    assert isinstance(result, tuple)
    assert len(result) == 2
    assert isinstance(result[0], bool)
    assert isinstance(result[1], str)


def test_validator_error_message_is_empty_on_success():
    _, err = validate_artifact_name("good-name")
    assert err == ""


def test_validator_error_message_non_empty_on_failure():
    _, err = validate_artifact_name("")
    assert err != ""


# ---------------------------------------------------------------------------
# NFC handling in validate_artifact_name
# ---------------------------------------------------------------------------


def test_validator_accepts_nfd_input():
    """NFD `café` normalizes to NFC `café` which is 4 chars, well under the cap."""
    nfd = "café"  # e + combining acute
    assert unicodedata.normalize("NFC", nfd) != nfd  # sanity: really is NFD
    ok, err = validate_artifact_name(nfd)
    assert ok is True, err


# ---------------------------------------------------------------------------
# Artifact model NFC auto-normalization
# ---------------------------------------------------------------------------


def test_artifact_name_field_auto_normalizes_nfd_to_nfc():
    nfd = "café"  # NFD café
    nfc = "café"   # NFC café
    artifact = Artifact(
        name=nfd,
        title="Test",
        type="doc",
        conversation_id="general",
        created_by=_sender(),
        versions=[],
    )
    assert artifact.name == nfc
    assert unicodedata.normalize("NFC", artifact.name) == artifact.name


def test_artifact_name_field_idempotent_on_nfc():
    nfc = "café"
    artifact = Artifact(
        name=nfc,
        title="Test",
        type="doc",
        conversation_id="general",
        created_by=_sender(),
        versions=[],
    )
    assert artifact.name == nfc


def test_artifact_name_auto_normalizes_on_json_deserialization():
    nfd = "café"
    nfc = "café"
    raw = json.dumps({
        "id": "00000000-0000-0000-0000-000000000000",
        "name": nfd,
        "title": "Test",
        "type": "doc",
        "conversation_id": "general",
        "created_by": {"key": "ab12cd34", "name": "u", "type": "human"},
        "created_at": "2026-04-23T00:00:00+00:00",
        "versions": [],
    })
    artifact = Artifact.model_validate_json(raw)
    assert artifact.name == nfc


# ---------------------------------------------------------------------------
# _normalize_name helper
# ---------------------------------------------------------------------------


def test_normalize_name_nfd_to_nfc():
    assert _normalize_name("café") == "café"


def test_normalize_name_idempotent():
    nfc = "café"
    assert _normalize_name(nfc) == nfc


# ---------------------------------------------------------------------------
# migrate_artifact_names_to_nfc
# ---------------------------------------------------------------------------


def _write_artifact_json(path: Path, name: str) -> None:
    """Write a minimal Artifact JSON with the given ``name`` field."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": "00000000-0000-0000-0000-000000000000",
        "name": name,
        "title": "fixture",
        "type": "doc",
        "conversation_id": path.parent.name,
        "created_by": {"key": "ab12cd34", "name": "u", "type": "human"},
        "created_at": "2026-04-23T00:00:00+00:00",
        "versions": [],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_migration_nonexistent_data_dir_returns_zero(tmp_path: Path):
    missing = tmp_path / "does-not-exist"
    assert migrate_artifact_names_to_nfc(missing) == (0, 0)


def test_migration_renames_nfd_to_nfc(tmp_path: Path):
    nfd_stem = "café"
    nfc_stem = "café"
    conv_dir = tmp_path / "general"
    _write_artifact_json(conv_dir / f"{nfd_stem}.json", nfd_stem)

    renamed, quarantined = migrate_artifact_names_to_nfc(tmp_path)

    assert renamed == 1
    assert quarantined == 0
    assert (conv_dir / f"{nfc_stem}.json").is_file()
    assert not (conv_dir / f"{nfd_stem}.json").exists()


def test_migration_collision_quarantines_nfd(tmp_path: Path):
    """R6-2: on collision, NFD file must be moved to quarantine,
    NFC file must be left untouched."""
    nfd_stem = "café"
    nfc_stem = "café"
    conv_dir = tmp_path / "general"
    _write_artifact_json(conv_dir / f"{nfd_stem}.json", nfd_stem)
    _write_artifact_json(conv_dir / f"{nfc_stem}.json", nfc_stem)

    renamed, quarantined = migrate_artifact_names_to_nfc(tmp_path)

    assert renamed == 0
    assert quarantined == 1
    # NFC file is still present
    assert (conv_dir / f"{nfc_stem}.json").is_file()
    # NFD file has been moved out of the live directory
    assert not (conv_dir / f"{nfd_stem}.json").exists()
    # Quarantine file exists at the R6-2 path
    quarantine_path = (
        tmp_path / ".nfc-migration-quarantine" / "general" / f"{nfd_stem}.json"
    )
    assert quarantine_path.is_file()


def test_migration_quarantine_preserves_list_artifacts_invariant(tmp_path: Path):
    """After quarantine, list_artifacts must return exactly one record for the
    colliding name (R6-2: no split-brain)."""
    from claude_comms.artifact import list_artifacts

    nfd_stem = "café"
    nfc_stem = "café"
    conv_dir = tmp_path / "general"
    _write_artifact_json(conv_dir / f"{nfd_stem}.json", nfd_stem)
    _write_artifact_json(conv_dir / f"{nfc_stem}.json", nfc_stem)

    migrate_artifact_names_to_nfc(tmp_path)
    records = list_artifacts("general", tmp_path)
    nfc_records = [r for r in records if r["name"] == nfc_stem]
    assert len(nfc_records) == 1


def test_migration_idempotent(tmp_path: Path):
    nfd_stem = "café"
    conv_dir = tmp_path / "general"
    _write_artifact_json(conv_dir / f"{nfd_stem}.json", nfd_stem)

    first = migrate_artifact_names_to_nfc(tmp_path)
    second = migrate_artifact_names_to_nfc(tmp_path)

    assert first == (1, 0)
    assert second == (0, 0)


def test_migration_skips_already_nfc_files(tmp_path: Path):
    nfc_stem = "café"
    conv_dir = tmp_path / "general"
    _write_artifact_json(conv_dir / f"{nfc_stem}.json", nfc_stem)

    renamed, quarantined = migrate_artifact_names_to_nfc(tmp_path)

    assert renamed == 0
    assert quarantined == 0
    assert (conv_dir / f"{nfc_stem}.json").is_file()


def test_migration_skips_dotted_conversation_dirs(tmp_path: Path):
    """The quarantine directory itself starts with a dot — migration must
    not recurse into it on subsequent runs."""
    nfd_stem = "café"
    nfc_stem = "café"
    conv_dir = tmp_path / "general"
    _write_artifact_json(conv_dir / f"{nfd_stem}.json", nfd_stem)
    _write_artifact_json(conv_dir / f"{nfc_stem}.json", nfc_stem)

    # First run quarantines
    migrate_artifact_names_to_nfc(tmp_path)
    # Second run must NOT re-process the quarantine dir
    renamed2, quarantined2 = migrate_artifact_names_to_nfc(tmp_path)
    assert renamed2 == 0
    assert quarantined2 == 0


# ---------------------------------------------------------------------------
# Case-insensitive collision at create time (R1-6)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_case_collision_at_create(tmp_path: Path):
    """`Foo` + `foo` must collide at create time."""
    registry = ParticipantRegistry()
    spy = PublishSpy()
    join_result = await tool_comms_join(registry, name="alice", conversation="general")
    key = join_result["key"]

    kwargs_foo = dict(
        key=key,
        conversation="general",
        name="Foo",
        title="Foo",
        type="doc",
        content="x",
        data_dir=tmp_path,
    )
    result1 = await tool_comms_artifact_create(registry, spy, **kwargs_foo)
    assert result1.get("status") == "created", result1

    kwargs_foo_lower = dict(kwargs_foo, name="foo")
    result2 = await tool_comms_artifact_create(registry, spy, **kwargs_foo_lower)
    assert result2.get("error") is True
    assert "collide" in result2["message"].lower() or "already exists" in result2["message"].lower()


@pytest.mark.asyncio
async def test_case_collision_at_create_uppercase_variant(tmp_path: Path):
    """`bar` then `BAR` must also collide."""
    registry = ParticipantRegistry()
    spy = PublishSpy()
    join_result = await tool_comms_join(registry, name="bob", conversation="general")
    key = join_result["key"]

    first = await tool_comms_artifact_create(
        registry, spy,
        key=key, conversation="general", name="bar", title="Bar",
        type="doc", content="x", data_dir=tmp_path,
    )
    assert first.get("status") == "created"

    second = await tool_comms_artifact_create(
        registry, spy,
        key=key, conversation="general", name="BAR", title="Bar Upper",
        type="doc", content="x", data_dir=tmp_path,
    )
    assert second.get("error") is True


# ---------------------------------------------------------------------------
# save/load round-trip through NFC
# ---------------------------------------------------------------------------


def test_save_load_nfd_input_finds_nfc_file(tmp_path: Path):
    """Caller creates with NFC name, subsequent load with NFD input succeeds."""
    from claude_comms.artifact import load_artifact

    nfc = "café"
    nfd = "café"
    artifact = Artifact(
        name=nfc,
        title="Café",
        type="doc",
        conversation_id="general",
        created_by=_sender(),
        versions=[
            ArtifactVersion(version=1, content="hello", author=_sender()),
        ],
    )
    save_artifact(artifact, tmp_path)

    # Load using the NFD form — must succeed because load_artifact normalizes
    loaded = load_artifact("general", nfd, tmp_path)
    assert loaded is not None
    assert loaded.name == nfc
