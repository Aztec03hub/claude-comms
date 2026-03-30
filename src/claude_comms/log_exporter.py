"""MQTT subscriber that writes human-readable .log and structured .jsonl files.

Subscribes to ``claude-comms/conv/+/messages`` and writes each message
to per-conversation log files under ``~/.claude-comms/logs/``.

Provides:
- ``LogExporter``: async MQTT subscriber with deduplication and log rotation.
- ``format_log_entry``: render a message dict as a human-readable log block.
- ``format_presence_event``: render join/leave lines.
- ``format_log_header``: render the conversation header block.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from claude_comms.broker import MessageDeduplicator
from claude_comms.message import validate_conv_id

logger = logging.getLogger(__name__)

__all__ = [
    "LogExporter",
    "format_log_entry",
    "format_log_header",
    "format_presence_event",
]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LogFormat = Literal["text", "jsonl", "both"]

_HEADER_SEPARATOR = "=" * 80

_LOCAL_TZ = datetime.now(timezone.utc).astimezone().tzinfo


# ---------------------------------------------------------------------------
# Timestamp formatting
# ---------------------------------------------------------------------------


def _parse_ts(ts_str: str) -> datetime:
    """Parse an ISO 8601 timestamp string into a timezone-aware datetime."""
    return datetime.fromisoformat(ts_str)


def _format_ts_full(dt: datetime) -> str:
    """Format datetime as ``2026-03-13 02:15:23PM CDT``."""
    local_dt = dt.astimezone()
    return local_dt.strftime("%Y-%m-%d %I:%M:%S%p %Z")


def _format_ts_short(dt: datetime) -> str:
    """Format datetime as ``02:15:23PM CDT`` (time only)."""
    local_dt = dt.astimezone()
    return local_dt.strftime("%I:%M:%S%p %Z")


# ---------------------------------------------------------------------------
# Human-readable formatting
# ---------------------------------------------------------------------------


def format_log_header(conv_id: str, created_ts: str | None = None) -> str:
    """Build the conversation header block.

    Parameters
    ----------
    conv_id:
        Conversation identifier.
    created_ts:
        ISO 8601 timestamp for creation time.  If *None*, the current
        time is used.

    Returns
    -------
    str
        Multi-line header string (no trailing newline).
    """
    if created_ts is None:
        dt = datetime.now(timezone.utc).astimezone()
    else:
        dt = _parse_ts(created_ts)
    ts_formatted = _format_ts_full(dt)

    return (
        f"{_HEADER_SEPARATOR}\n"
        f"CONVERSATION: {conv_id}\n"
        f"CREATED: {ts_formatted}\n"
        f"{_HEADER_SEPARATOR}"
    )


def format_log_entry(msg: dict[str, Any]) -> str:
    """Render a message dict as a human-readable log entry.

    The format is::

        [2026-03-13 02:15:23PM CDT] @claude-veridian (a3f7b2c1):
            First line of message body.
            Second line of message body.

    Parameters
    ----------
    msg:
        A message dict matching the MQTT payload schema.

    Returns
    -------
    str
        The formatted entry (no trailing newline).

    Raises
    ------
    KeyError
        If required fields (``ts``, ``sender``, ``body``) are missing.
    """
    if not msg:
        return "[EMPTY MESSAGE]"

    ts_str = msg.get("ts", "")
    if not ts_str:
        ts_full = "UNKNOWN TIME"
    else:
        try:
            dt = _parse_ts(ts_str)
            ts_full = _format_ts_full(dt)
        except (ValueError, TypeError):
            ts_full = ts_str

    sender = msg.get("sender", {})
    sender_name = sender.get("name", "unknown") if isinstance(sender, dict) else "unknown"
    sender_key = sender.get("key", "????????") if isinstance(sender, dict) else "????????"

    # Indent every line of the body with 4 spaces
    body = msg.get("body", "")
    indented_lines = []
    for line in body.split("\n"):
        indented_lines.append(f"    {line}")
    indented_body = "\n".join(indented_lines)

    return f"[{ts_full}] @{sender_name} ({sender_key}):\n{indented_body}"


def format_presence_event(
    name: str | None,
    key: str | None,
    event: Literal["joined", "left"],
    ts_str: str | None = None,
) -> str:
    """Render a join/leave event line.

    Format::

        --- claude-nebula (c9d3e5f7) joined the conversation [02:46:00PM CDT] ---

    Parameters
    ----------
    name:
        Participant display name.  Falls back to ``"unknown"`` if *None*.
    key:
        Participant 8-hex-char key.  Falls back to ``"????????"`` if *None*.
    event:
        ``"joined"`` or ``"left"``.
    ts_str:
        ISO 8601 timestamp.  If *None*, current time is used.

    Returns
    -------
    str
        The formatted presence line (no trailing newline).
    """
    name = name or "unknown"
    key = key or "????????"

    if ts_str is None:
        dt = datetime.now(timezone.utc).astimezone()
    else:
        try:
            dt = _parse_ts(ts_str)
        except (ValueError, TypeError):
            dt = datetime.now(timezone.utc).astimezone()
    ts_short = _format_ts_short(dt)

    return f"--- {name} ({key}) {event} the conversation [{ts_short}] ---"


# ---------------------------------------------------------------------------
# Log rotation
# ---------------------------------------------------------------------------


def _rotate_file(path: Path, max_files: int) -> None:
    """Rotate a log file using numbered suffixes (.1, .2, ...).

    ``path`` is renamed to ``path.1``, ``path.1`` to ``path.2``, etc.
    Files beyond *max_files* are deleted.
    """
    # Delete the oldest if it would exceed max_files
    for i in range(max_files, 0, -1):
        older = path.parent / f"{path.name}.{i}"
        if i == max_files:
            older.unlink(missing_ok=True)
        else:
            newer = path.parent / f"{path.name}.{i + 1}"
            if older.exists():
                older.rename(newer)

    # Rotate current to .1
    if path.exists():
        path.rename(path.parent / f"{path.name}.1")


def _check_rotation(
    path: Path, max_size_bytes: int, max_files: int
) -> None:
    """Rotate *path* if it exceeds *max_size_bytes*."""
    if max_size_bytes <= 0 or max_files <= 0:
        return
    try:
        if path.exists() and path.stat().st_size >= max_size_bytes:
            _rotate_file(path, max_files)
    except OSError as exc:
        logger.warning("Log rotation failed for %s: %s", path, exc)


# ---------------------------------------------------------------------------
# LogExporter
# ---------------------------------------------------------------------------


class LogExporter:
    """Writes incoming messages to ``.log`` and ``.jsonl`` files.

    This class is designed to be used as a component within the daemon
    process.  Call :meth:`write_message` for each new MQTT message
    received on ``claude-comms/conv/+/messages``.

    Parameters
    ----------
    log_dir:
        Directory for log files.  Defaults to ``~/.claude-comms/logs``.
    fmt:
        Output format — ``"text"``, ``"jsonl"``, or ``"both"``.
    max_size_mb:
        Maximum size in MB before rotating a log file.  0 disables rotation.
    max_files:
        Maximum number of rotated files to keep per conversation.
    deduplicator:
        A :class:`MessageDeduplicator` instance.  If *None*, a new one
        is created internally.
    """

    def __init__(
        self,
        log_dir: Path | str | None = None,
        fmt: LogFormat = "both",
        max_size_mb: int | float = 50,
        max_files: int = 10,
        deduplicator: MessageDeduplicator | None = None,
    ) -> None:
        if log_dir is None:
            self.log_dir = Path.home() / ".claude-comms" / "logs"
        else:
            self.log_dir = Path(log_dir).expanduser()

        self.fmt: LogFormat = fmt
        self.max_size_bytes: int = int(max_size_mb * 1024 * 1024)
        self.max_files: int = max_files
        self.deduplicator = deduplicator or MessageDeduplicator()

        # Track which conversations have had their header written
        self._headers_written: set[str] = set()

    # -- Factory -----------------------------------------------------------

    @classmethod
    def from_config(
        cls,
        config: dict[str, Any],
        deduplicator: MessageDeduplicator | None = None,
    ) -> "LogExporter":
        """Create a :class:`LogExporter` from a parsed config dict.

        Expected keys::

            logging.dir, logging.format,
            logging.rotation.max_size_mb, logging.rotation.max_files
        """
        log_cfg = config.get("logging", {})
        rotation_cfg = log_cfg.get("rotation", {})

        return cls(
            log_dir=log_cfg.get("dir", str(Path.home() / ".claude-comms" / "logs")),
            fmt=log_cfg.get("format", "both"),
            max_size_mb=rotation_cfg.get("max_size_mb", 50),
            max_files=rotation_cfg.get("max_files", 10),
            deduplicator=deduplicator,
        )

    # -- Path helpers ------------------------------------------------------

    def _log_path(self, conv_id: str) -> Path:
        """Return the ``.log`` file path for a conversation."""
        return self.log_dir / f"{conv_id}.log"

    def _jsonl_path(self, conv_id: str) -> Path:
        """Return the ``.jsonl`` file path for a conversation."""
        return self.log_dir / f"{conv_id}.jsonl"

    # -- Header management -------------------------------------------------

    def _ensure_header(self, conv_id: str, ts: str | None = None) -> None:
        """Write the conversation header to the .log file if not yet written."""
        if conv_id in self._headers_written:
            return
        if self.fmt not in ("text", "both"):
            self._headers_written.add(conv_id)
            return

        log_path = self._log_path(conv_id)

        # If the file already exists and has content, assume header is present
        if log_path.exists() and log_path.stat().st_size > 0:
            self._headers_written.add(conv_id)
            return

        self.log_dir.mkdir(parents=True, exist_ok=True)
        header = format_log_header(conv_id, created_ts=ts)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(header + "\n\n")
        self._headers_written.add(conv_id)

    # -- Core write methods ------------------------------------------------

    def write_message(self, msg: dict[str, Any]) -> bool:
        """Write a message to the appropriate log file(s).

        Validates the conversation ID, checks for duplicates, and writes
        to ``.log`` and/or ``.jsonl`` depending on the configured format.

        Parameters
        ----------
        msg:
            A message dict matching the MQTT payload schema.  Must
            contain at least ``id``, ``conv``, ``ts``, ``sender``,
            and ``body``.

        Returns
        -------
        bool
            ``True`` if the message was written, ``False`` if it was
            rejected (invalid conv_id or duplicate).
        """
        conv_id = msg.get("conv", "")
        msg_id = msg.get("id", "")

        # Validate conversation ID
        if not conv_id or not validate_conv_id(conv_id):
            logger.warning("Rejected message with invalid conv_id: %r", conv_id)
            return False

        # Deduplicate
        if not msg_id:
            logger.warning("Rejected message without id")
            return False

        if self.deduplicator.is_duplicate(msg_id):
            logger.debug("Dropping duplicate message: %s", msg_id)
            return False

        # Ensure log directory exists
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # Ensure header is written for human-readable logs
        self._ensure_header(conv_id, ts=msg.get("ts"))

        # Write JSONL
        if self.fmt in ("jsonl", "both"):
            self._write_jsonl(conv_id, msg)

        # Write human-readable
        if self.fmt in ("text", "both"):
            self._write_text(conv_id, msg)

        return True

    def write_presence(
        self,
        conv_id: str,
        name: str,
        key: str,
        event: Literal["joined", "left"],
        ts_str: str | None = None,
    ) -> bool:
        """Write a presence event (join/leave) to the human-readable log.

        Parameters
        ----------
        conv_id:
            Conversation ID.
        name:
            Participant display name.
        key:
            Participant 8-hex-char key.
        event:
            ``"joined"`` or ``"left"``.
        ts_str:
            ISO 8601 timestamp.

        Returns
        -------
        bool
            ``True`` if written, ``False`` if conv_id is invalid.
        """
        if not conv_id or not validate_conv_id(conv_id):
            logger.warning("Rejected presence event with invalid conv_id: %r", conv_id)
            return False

        if self.fmt not in ("text", "both"):
            return True  # Nothing to write for jsonl-only mode

        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_header(conv_id, ts=ts_str)

        log_path = self._log_path(conv_id)
        _check_rotation(log_path, self.max_size_bytes, self.max_files)

        line = format_presence_event(name, key, event, ts_str)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")

        return True

    # -- Internal writers --------------------------------------------------

    def _write_jsonl(self, conv_id: str, msg: dict[str, Any]) -> None:
        """Append a JSON line to the ``.jsonl`` file."""
        jsonl_path = self._jsonl_path(conv_id)
        _check_rotation(jsonl_path, self.max_size_bytes, self.max_files)

        try:
            with open(jsonl_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(msg, ensure_ascii=False) + "\n")
        except OSError as exc:
            logger.error("Failed to write JSONL for %s: %s", conv_id, exc)

    def _write_text(self, conv_id: str, msg: dict[str, Any]) -> None:
        """Append a formatted entry to the ``.log`` file."""
        log_path = self._log_path(conv_id)
        _check_rotation(log_path, self.max_size_bytes, self.max_files)

        try:
            entry = format_log_entry(msg)
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(entry + "\n\n")
        except OSError as exc:
            logger.error("Failed to write text log for %s: %s", conv_id, exc)
