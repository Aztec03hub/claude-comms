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

from pydantic import BaseModel, Field

from claude_comms.message import now_iso

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
    archived: bool = Field(
        default=False, description="Whether the conversation is archived"
    )
    deleted_at: str | None = Field(
        default=None,
        description=(
            "ISO 8601 timestamp the conversation was soft-deleted, or None if live. "
            "Soft-deleted conversations preserve their history on disk and only "
            "disappear from sidebars; a future purge job hard-deletes them."
        ),
    )
    deleted_by: str | None = Field(
        default=None,
        description=(
            "Participant name that requested the soft-delete, or None if live. "
            "Pairs with ``deleted_at`` -- both fields move together."
        ),
    )
    archived_at: str | None = Field(
        default=None,
        description="ISO 8601 timestamp the conversation was archived (None when not archived)",
    )
    archived_by: str | None = Field(
        default=None,
        description="Display name of the participant who archived the conversation",
    )

    # ------------------------------------------------------------------
    # v0.4.0: soft-delete (step 2.2)
    # ------------------------------------------------------------------

    def mark_deleted(self, deleted_by: str) -> None:
        """Mark this conversation as soft-deleted (in-memory only).

        Sets ``deleted_at`` to the current ISO 8601 timestamp and stores
        the requesting participant's display name in ``deleted_by``.  The
        caller is responsible for persisting the updated meta via
        :func:`save_meta` -- this method is intentionally pure so unit
        tests can exercise the state transition without touching disk.

        Idempotent: re-calling with a different ``deleted_by`` overwrites
        the prior values, which is the correct behavior when an admin
        purge runs after the original creator's request.
        """
        self.deleted_at = now_iso()
        self.deleted_by = deleted_by

    @property
    def is_deleted(self) -> bool:
        """True iff this conversation has been soft-deleted.

        Both ``deleted_at`` and ``deleted_by`` must be set; a partial
        state (e.g. ``deleted_at`` set but ``deleted_by`` cleared by a
        manual JSON edit) reads as live so the conversation stays
        recoverable instead of silently vanishing.
        """
        return self.deleted_at is not None and self.deleted_by is not None

    # ----- Archive transitions (v0.4.0 Step 2.3) --------------------------
    #
    # These helpers mutate the model in place. They are intentionally tiny
    # and self-contained so the MCP archive / unarchive tools can call them
    # without re-implementing the timestamp + flag bookkeeping each time.
    # Callers still own persistence (``save_meta``); these methods are
    # pure metadata transitions on the in-memory model.

    def mark_archived(self, archived_by: str) -> None:
        """Flip the conversation into the archived state.

        Sets ``archived=True``, stamps ``archived_at`` with the current
        ISO 8601 timestamp, and records *archived_by* (the display name of
        the participant who initiated the archive). Idempotent re-archive
        refreshes the timestamp + actor so a second archive call wins.
        """
        self.archived = True
        self.archived_at = now_iso()
        self.archived_by = archived_by

    def mark_unarchived(self) -> None:
        """Revert the conversation to the live (non-archived) state.

        Clears ``archived``, ``archived_at``, and ``archived_by`` so the
        on-disk record is indistinguishable from a never-archived one
        once persisted. Members are NOT auto-re-joined; by design, they
        re-join via their own ``comms_join`` (see Design Spec §4.4).
        """
        self.archived = False
        self.archived_at = None
        self.archived_by = None


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
            logger.warning(
                "Skipping malformed conversation meta %s: %s", meta_file, exc
            )
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
                logger.debug("Skipping flush for %r — no meta.json on disk", conv_name)
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
