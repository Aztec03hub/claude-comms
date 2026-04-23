"""Artifact storage — Pydantic models and file I/O for collaborative documents.

Artifacts are versioned documents (plans, docs, code) that users and Claude
agents can create, edit, and share within conversations.  Each artifact is
persisted as a single JSON file under ``{data_dir}/{conversation}/{name}.json``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from claude_comms.message import Sender, now_iso

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Reject: NUL + control chars, plus Windows-forbidden chars: < > : " / \ | ? *
# Also reject: backtick (shell quoting hazard), newline, tab (whitespace confusion)
ARTIFACT_NAME_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*`\n\r\t]')

WINDOWS_RESERVED = frozenset({
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
})

DEFAULT_GET_CHUNK_SIZE = 50_000
MAX_VERSIONS = 50

# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def _normalize_name(name: str) -> str:
    """Canonical name form used for on-disk paths and in-memory identity.

    R5-3: NFC normalization must be applied at every user-name → filesystem-name
    boundary so e.g. ``café`` (NFC) and ``café`` (NFD) can't coexist as two
    "different" artifacts.
    """
    return unicodedata.normalize("NFC", name)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_artifact_name(name: str) -> tuple[bool, str]:
    """Return ``(is_valid, error_message)`` for an artifact name.

    Empty error means valid.

    Windows-filesystem-compatible permissive naming: allows spaces, Unicode,
    most punctuation. Only forbids characters Windows itself rejects plus a
    small set of structural / safety rules.

    R4-7 hardening: NFC-normalize to eliminate macOS HFS+ NFD collisions;
    reject ``.json`` suffix (on-disk name collision risk); reject fullwidth
    confusables (e.g. U+FF0F fullwidth slash).
    """
    if not name:
        return False, "name cannot be empty"

    # R4-7: Normalize to NFC first. Store and compare the normalized form so
    # e.g. `café` (NFC) and `café` (NFD) can't coexist as "different" artifacts.
    name = _normalize_name(name)

    if len(name) > 128:
        return False, "name exceeds 128 characters"

    if ARTIFACT_NAME_FORBIDDEN.search(name):
        return False, 'name contains a forbidden character (< > : " / \\ | ? * or control char)'

    # R4-7: Reject confusable fullwidth chars (U+FF00–U+FFEF) — they render
    # indistinguishably from ASCII in many fonts and are a phishing vector.
    if any(0xFF00 <= ord(c) <= 0xFFEF for c in name):
        return False, "name contains confusable fullwidth characters"

    # Leading space or dot is confusing and some filesystems reject it.
    if name.startswith(" ") or name.startswith("."):
        return False, "name cannot start with a space or dot"

    # Windows silently strips trailing dot / space → file collision risk.
    # Also reject trailing hyphen/underscore — visually ambiguous with
    # accidental concatenation.
    if name.endswith(".") or name.endswith(" ") or name.endswith("-") or name.endswith("_"):
        return False, "name cannot end with a dot, space, hyphen, or underscore"

    if ".." in name:
        return False, "name cannot contain '..'"

    # R4-7: Reject `.json` suffix to prevent `foo.json` input producing
    # on-disk `foo.json.json` and future collision with a user creating `foo.json.json`.
    if name.lower().endswith(".json"):
        return False, "name cannot end with '.json' (reserved by storage format)"

    # Windows reserves the stem (part before first dot). E.g. CON.txt collides with CON.
    stem = name.split(".", 1)[0].upper()
    if stem in WINDOWS_RESERVED:
        return False, f"name {name!r} conflicts with Windows reserved device name"

    return True, ""


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ArtifactVersion(BaseModel):
    """A single immutable snapshot of an artifact's content."""

    version: int = Field(..., ge=1, description="Monotonically increasing version number")
    content: str = Field(..., description="Full document content at this version")
    author: Sender = Field(..., description="Who created this version")
    timestamp: str = Field(
        default_factory=now_iso,
        description="ISO 8601 timestamp with timezone",
    )
    summary: str = Field(default="", description="Human-readable change summary")


class Artifact(BaseModel):
    """A versioned collaborative document within a conversation."""

    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        description="Unique artifact UUID",
    )
    name: str = Field(..., description="Filesystem-safe name used as filename stem")
    title: str = Field(..., min_length=1, description="Human-readable title")
    type: Literal["plan", "doc", "code"] = Field(..., description="Artifact category")
    conversation_id: str = Field(..., description="Owning conversation ID")
    created_by: Sender = Field(..., description="Original author")
    created_at: str = Field(
        default_factory=now_iso,
        description="ISO 8601 creation timestamp",
    )
    versions: list[ArtifactVersion] = Field(
        default_factory=list,
        description="Version history, newest last",
    )

    @field_validator("name")
    @classmethod
    def _enforce_nfc(cls, v: str) -> str:
        """R5-3: enforce NFC on the model so construction and JSON
        deserialization always produce a canonical identity string."""
        return _normalize_name(v)


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------


def _artifact_path(conversation: str, name: str, data_dir: Path) -> Path:
    """Return the on-disk path for an artifact (NFC-normalized)."""
    return data_dir / conversation / f"{_normalize_name(name)}.json"


def save_artifact(artifact: Artifact, data_dir: Path) -> None:
    """Persist *artifact* to disk with an atomic rename.

    Creates the conversation directory if it does not exist.  If the
    version list exceeds ``MAX_VERSIONS``, the oldest entries are
    discarded before writing.
    """
    # Prune old versions
    if len(artifact.versions) > MAX_VERSIONS:
        artifact.versions = artifact.versions[-MAX_VERSIONS:]

    conv_dir = data_dir / artifact.conversation_id
    conv_dir.mkdir(parents=True, exist_ok=True)

    # `artifact.name` is already NFC via the field_validator, but be defensive.
    stem = _normalize_name(artifact.name)
    target = conv_dir / f"{stem}.json"
    tmp = conv_dir / f"{stem}.json.tmp"

    tmp.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    os.rename(tmp, target)


def load_artifact(conversation: str, name: str, data_dir: Path) -> Artifact | None:
    """Load an artifact from disk, or return ``None`` if not found.

    Returns ``None`` for missing files or malformed JSON.
    """
    name = _normalize_name(name)
    path = _artifact_path(conversation, name, data_dir)
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        return Artifact.model_validate_json(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Failed to load artifact %s: %s", path, exc)
        return None


def list_artifacts(conversation: str, data_dir: Path) -> list[dict[str, Any]]:
    """Return summary metadata for every artifact in a conversation.

    Each entry contains ``name``, ``title``, ``type``, ``version_count``,
    and the latest version's ``author``, ``timestamp``, and ``summary``.
    Content is deliberately excluded to keep the response lightweight.

    Returns an empty list if the conversation directory does not exist.
    """
    conv_dir = data_dir / conversation
    if not conv_dir.is_dir():
        return []

    results: list[dict[str, Any]] = []
    for json_file in sorted(conv_dir.glob("*.json")):
        try:
            raw = json_file.read_text(encoding="utf-8")
            artifact = Artifact.model_validate_json(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("Skipping malformed artifact %s: %s", json_file, exc)
            continue

        entry: dict[str, Any] = {
            "name": artifact.name,
            "title": artifact.title,
            "type": artifact.type,
            "version_count": len(artifact.versions),
        }
        if artifact.versions:
            latest = artifact.versions[-1]
            entry["author"] = latest.author.model_dump()
            entry["timestamp"] = latest.timestamp
            entry["summary"] = latest.summary
        results.append(entry)

    return results


def delete_artifact(conversation: str, name: str, data_dir: Path) -> bool:
    """Remove an artifact's JSON file from disk.

    Returns ``True`` if the file was deleted, ``False`` if it did not exist.
    """
    name = _normalize_name(name)
    path = _artifact_path(conversation, name, data_dir)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        logger.warning("Failed to delete artifact %s: %s", path, exc)
        return False


# ---------------------------------------------------------------------------
# NFC migration (one-time at startup)
# ---------------------------------------------------------------------------


def migrate_artifact_names_to_nfc(data_dir: Path) -> tuple[int, int]:
    """Rename any NFD artifact files to NFC form. Idempotent.

    Collisions are QUARANTINED, not left in place (R6-2 fix) — otherwise
    the collision produces two in-memory Artifact records with the same
    NFC name, breaking identity downstream.

    Returns ``(renamed_count, quarantined_count)``. Runs at daemon startup.
    """
    if not data_dir.is_dir():
        return 0, 0

    renamed = 0
    quarantined = 0
    quarantine_root = data_dir / ".nfc-migration-quarantine"

    for conv_dir in data_dir.iterdir():
        if not conv_dir.is_dir() or conv_dir.name.startswith("."):
            continue
        for json_file in conv_dir.glob("*.json"):
            stem = json_file.stem
            nfc = unicodedata.normalize("NFC", stem)
            if nfc == stem:
                continue
            target = json_file.with_name(f"{nfc}.json")
            if target.exists():
                # R6-2: quarantine the NFD file — do NOT leave it next to
                # the NFC version. Otherwise list_artifacts() would build
                # two Artifact records that the Pydantic NFC validator
                # then collapses to the same name — split-brain.
                q_dir = quarantine_root / conv_dir.name
                q_dir.mkdir(parents=True, exist_ok=True)
                q_target = q_dir / json_file.name
                json_file.rename(q_target)
                logger.warning(
                    "NFC migration: collision on %s; quarantined NFD file to %s",
                    target, q_target,
                )
                quarantined += 1
                continue
            json_file.rename(target)
            logger.info(
                "NFC migration: renamed %s -> %s", json_file.name, target.name
            )
            renamed += 1

    if quarantined > 0:
        logger.warning(
            "NFC migration quarantined %d file(s). Review %s and reconcile manually.",
            quarantined, quarantine_root,
        )
    return renamed, quarantined
