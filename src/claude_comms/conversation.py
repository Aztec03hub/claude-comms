"""Conversation metadata — Pydantic model and file I/O for discovery and tracking.

Each conversation has a ``meta.json`` file stored at
``{data_dir}/{conversation}/meta.json`` where *data_dir* defaults to
``~/.claude-comms/conversations/``.  This module handles creation,
loading, listing, backfill from legacy JSONL logs, and periodic
last-activity flushing.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from claude_comms.message import now_iso, validate_conv_id

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RESERVED_CONVERSATION_NAMES = frozenset({"general", "system"})

# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class ConversationMeta(BaseModel):
    """Metadata for a single conversation."""

    name: str = Field(..., description="Conversation slug / ID")
    topic: str = Field(default="", description="Human-readable topic line")
    created_by: str = Field(
        ...,
        description="Participant name, or 'system' / 'system-backfill' / 'system-implicit'",
    )
    created_at: str = Field(..., description="ISO 8601 creation timestamp")
    last_activity: str = Field(..., description="ISO 8601 timestamp of last activity")
    archived: bool = Field(default=False, description="Whether the conversation is archived")


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------


def meta_path(conversation: str, data_dir: Path) -> Path:
    """Return the on-disk path for a conversation's metadata file."""
    return data_dir / conversation / "meta.json"


def save_meta(meta: ConversationMeta, data_dir: Path) -> None:
    """Persist *meta* to disk with an atomic rename.

    Creates the conversation directory if it does not exist.
    """
    conv_dir = data_dir / meta.name
    conv_dir.mkdir(parents=True, exist_ok=True)

    target = conv_dir / "meta.json"
    tmp = conv_dir / "meta.json.tmp"

    tmp.write_text(meta.model_dump_json(indent=2), encoding="utf-8")
    os.rename(tmp, target)


def load_meta(conversation: str, data_dir: Path) -> ConversationMeta | None:
    """Load conversation metadata from disk, or return ``None`` if not found.

    Returns ``None`` for missing files or malformed JSON.
    """
    path = meta_path(conversation, data_dir)
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        return ConversationMeta.model_validate_json(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Failed to load conversation meta %s: %s", path, exc)
        return None


def list_all_conversations(data_dir: Path) -> list[ConversationMeta]:
    """Return metadata for every conversation that has a ``meta.json``.

    Scans ``{data_dir}/*/meta.json`` and returns a list of
    :class:`ConversationMeta` objects.  Malformed files are skipped
    with a warning.
    """
    if not data_dir.is_dir():
        return []

    results: list[ConversationMeta] = []
    for meta_file in sorted(data_dir.glob("*/meta.json")):
        try:
            raw = meta_file.read_text(encoding="utf-8")
            meta = ConversationMeta.model_validate_json(raw)
            results.append(meta)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("Skipping malformed conversation meta %s: %s", meta_file, exc)
            continue

    return results


def create_conversation_atomic(
    name: str,
    topic: str,
    created_by: str,
    data_dir: Path,
) -> ConversationMeta | None:
    """Create a new conversation atomically.

    Uses ``O_CREAT | O_EXCL`` to guarantee that only one caller wins
    the race.  Returns the new :class:`ConversationMeta` on success,
    or ``None`` if the conversation already exists.
    """
    conv_dir = data_dir / name
    conv_dir.mkdir(parents=True, exist_ok=True)

    target = conv_dir / "meta.json"
    ts = now_iso()

    meta = ConversationMeta(
        name=name,
        topic=topic,
        created_by=created_by,
        created_at=ts,
        last_activity=ts,
    )

    try:
        fd = os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(meta.model_dump_json(indent=2))
    except Exception:
        # Best-effort cleanup on write failure
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    return meta


# ---------------------------------------------------------------------------
# Bootstrap + Migration
# ---------------------------------------------------------------------------


def ensure_general_exists(data_dir: Path) -> ConversationMeta:
    """Ensure the ``general`` conversation exists, creating it if necessary.

    Returns the :class:`ConversationMeta` for ``general`` (loaded or
    freshly created).
    """
    existing = load_meta("general", data_dir)
    if existing is not None:
        return existing

    created = create_conversation_atomic(
        name="general",
        topic="Main lobby",
        created_by="system",
        data_dir=data_dir,
    )

    # Another process may have raced us — load from disk as fallback
    if created is None:
        loaded = load_meta("general", data_dir)
        if loaded is not None:
            return loaded
        # Should not happen, but construct a sensible default
        ts = now_iso()
        return ConversationMeta(
            name="general",
            topic="Main lobby",
            created_by="system",
            created_at=ts,
            last_activity=ts,
        )

    return created


def _last_timestamp_from_jsonl(jsonl_path: Path) -> str | None:
    """Read the last few lines of a JSONL log and return the latest timestamp.

    Returns ``None`` if the file is empty or unparseable.
    """
    try:
        raw = jsonl_path.read_bytes()
    except OSError:
        return None

    if not raw:
        return None

    # Read last 8 KB — should contain the last several messages
    tail = raw[-8192:]
    lines = tail.split(b"\n")

    latest_ts: str | None = None
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            ts = msg.get("ts")
            if ts and isinstance(ts, str):
                latest_ts = ts
                break
        except (json.JSONDecodeError, ValueError):
            continue

    return latest_ts


def _file_mtime_iso(path: Path) -> str:
    """Return the file's mtime as an ISO 8601 string."""
    mtime = path.stat().st_mtime
    dt = datetime.fromtimestamp(mtime, tz=timezone.utc).astimezone()
    return dt.isoformat()


def backfill_missing_metadata(data_dir: Path, log_dir: Path) -> int:
    """Create ``meta.json`` for conversations that have JSONL logs but no metadata.

    Scans *log_dir* for ``*.jsonl`` files and creates metadata in
    *data_dir* for any conversation that is missing it.

    Returns:
        Count of backfilled conversations.
    """
    if not log_dir.is_dir():
        return 0

    count = 0
    for jsonl_file in sorted(log_dir.glob("*.jsonl")):
        conv_name = jsonl_file.stem

        # Skip if metadata already exists
        if meta_path(conv_name, data_dir).is_file():
            continue

        # Determine timestamps
        file_ts = _file_mtime_iso(jsonl_file)
        msg_ts = _last_timestamp_from_jsonl(jsonl_file)
        last_activity = msg_ts if msg_ts else file_ts

        meta = ConversationMeta(
            name=conv_name,
            topic="",
            created_by="system-backfill",
            created_at=file_ts,
            last_activity=last_activity,
        )

        # Write atomically
        conv_dir = data_dir / conv_name
        conv_dir.mkdir(parents=True, exist_ok=True)
        target = conv_dir / "meta.json"
        tmp = conv_dir / "meta.json.tmp"

        try:
            tmp.write_text(meta.model_dump_json(indent=2), encoding="utf-8")
            os.rename(tmp, target)
            count += 1
            logger.info("Backfilled metadata for conversation %r", conv_name)
        except OSError as exc:
            logger.warning("Failed to backfill metadata for %r: %s", conv_name, exc)
            continue

    return count


# ---------------------------------------------------------------------------
# Last Activity Tracking
# ---------------------------------------------------------------------------


class LastActivityTracker:
    """Batched in-memory tracker for conversation last-activity timestamps.

    Collects ``update()`` calls in memory and periodically flushes them
    to their respective ``meta.json`` files to avoid excessive disk I/O
    on every message.
    """

    FLUSH_INTERVAL: float = 5.0  # seconds between automatic flushes

    def __init__(self) -> None:
        self._timestamps: dict[str, str] = {}
        self._last_flush: float = time.monotonic()

    def update(self, conversation: str, timestamp: str) -> None:
        """Record a new activity timestamp for *conversation* (in memory)."""
        self._timestamps[conversation] = timestamp

    def get(self, conversation: str) -> str | None:
        """Return the in-memory last-activity timestamp, or ``None``."""
        return self._timestamps.get(conversation)

    def flush_all(self, data_dir: Path) -> None:
        """Write all pending timestamps to their ``meta.json`` files."""
        pending = dict(self._timestamps)
        self._timestamps.clear()
        self._last_flush = time.monotonic()

        for conv_name, ts in pending.items():
            meta = load_meta(conv_name, data_dir)
            if meta is None:
                logger.debug(
                    "Skipping flush for %r — no meta.json on disk", conv_name
                )
                continue
            meta.last_activity = ts
            try:
                save_meta(meta, data_dir)
            except OSError as exc:
                logger.warning(
                    "Failed to flush last_activity for %r: %s", conv_name, exc
                )

    def flush_if_due(self, data_dir: Path) -> None:
        """Flush pending timestamps if at least ``FLUSH_INTERVAL`` seconds have elapsed."""
        if not self._timestamps:
            return
        if time.monotonic() - self._last_flush >= self.FLUSH_INTERVAL:
            self.flush_all(data_dir)
