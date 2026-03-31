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
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from claude_comms.message import Sender, now_iso

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ARTIFACT_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$")
DEFAULT_GET_CHUNK_SIZE = 50_000
MAX_VERSIONS = 50

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_artifact_name(name: str) -> bool:
    """Return ``True`` if *name* is a valid artifact slug.

    The pattern is the same as ``validate_conv_id`` in ``message.py``:
    lowercase alphanumeric with optional hyphens, 1–64 characters.
    """
    if not name:
        return False
    return bool(ARTIFACT_NAME_PATTERN.match(name))


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
    name: str = Field(..., description="URL-safe slug used as filename")
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


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------


def _artifact_path(conversation: str, name: str, data_dir: Path) -> Path:
    """Return the on-disk path for an artifact."""
    return data_dir / conversation / f"{name}.json"


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

    target = conv_dir / f"{artifact.name}.json"
    tmp = conv_dir / f"{artifact.name}.json.tmp"

    tmp.write_text(artifact.model_dump_json(indent=2), encoding="utf-8")
    os.rename(tmp, target)


def load_artifact(conversation: str, name: str, data_dir: Path) -> Artifact | None:
    """Load an artifact from disk, or return ``None`` if not found.

    Returns ``None`` for missing files or malformed JSON.
    """
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
    path = _artifact_path(conversation, name, data_dir)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        logger.warning("Failed to delete artifact %s: %s", path, exc)
        return False
