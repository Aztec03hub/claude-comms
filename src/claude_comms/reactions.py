"""Reactions: per-message emoji/short-token responses.

Phase A scaffold (claude-phoenix). This module provides:

- :class:`Reaction` — Pydantic model for a single reaction event.
- :class:`ReactionEvent` — wire/log model representing an add or remove operation.
- :class:`ReactionsStore` — in-memory state map per conversation, replayed from
  ``reactions.jsonl`` (and optional ``reactions.snapshot.json``) on startup.
- Snapshot/truncate logic at the agreed threshold (10K log lines OR 10K msgs).

MQTT publishing and MCP tool surface are wired in later passes; this layer is
storage-only and unit-testable in isolation.

Wire format (JSONL line and MQTT body identical)::

    {"message_id": str, "emoji": str, "actor_key": str, "ts": str,
     "op": "add" | "remove"}

The ``"toggle"`` op is a client convenience; the server resolves it to
``"add"`` or ``"remove"`` against the current state before persisting, so the
on-disk log only ever records terminal ops.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import BaseModel, Field, field_validator

from claude_comms.message import now_iso
from claude_comms.participant import KEY_PATTERN

logger = logging.getLogger(__name__)

__all__ = [
    "Reaction",
    "ReactionEvent",
    "ReactionOp",
    "ReactionsStore",
    "SNAPSHOT_LINE_THRESHOLD",
    "SNAPSHOT_MSG_THRESHOLD",
    "MAX_EMOJI_LEN",
    "reactions_topic",
]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Snapshot triggers (resolved in v3 of the architecture plan).
SNAPSHOT_LINE_THRESHOLD: int = 10_000
SNAPSHOT_MSG_THRESHOLD: int = 10_000

# Emoji free-text upper bound — generous, but caps abuse.
MAX_EMOJI_LEN: int = 64

ReactionOp = Literal["add", "remove", "toggle"]
TerminalOp = Literal["add", "remove"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def reactions_topic(conv_id: str) -> str:
    """Return the MQTT topic for reaction events on *conv_id*."""
    return f"claude-comms/conv/{conv_id}/reactions"


def _validate_emoji(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("emoji must be a string")
    stripped = value.strip()
    if not stripped:
        raise ValueError("emoji must not be empty")
    if len(stripped) > MAX_EMOJI_LEN:
        raise ValueError(f"emoji exceeds {MAX_EMOJI_LEN} characters")
    return stripped


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class Reaction(BaseModel):
    """A single reaction record as returned to clients."""

    emoji: str = Field(..., description="Free-text emoji token (unicode or slug)")
    actor_key: str = Field(..., min_length=8, max_length=8)
    ts: str = Field(default_factory=now_iso)

    @field_validator("emoji")
    @classmethod
    def _v_emoji(cls, v: str) -> str:
        return _validate_emoji(v)

    @field_validator("actor_key")
    @classmethod
    def _v_actor(cls, v: str) -> str:
        if not KEY_PATTERN.match(v):
            raise ValueError("actor_key must be 8 lowercase hex chars")
        return v


class ReactionEvent(BaseModel):
    """An add/remove event as it appears in the JSONL log and on MQTT.

    The wire-level ``op`` is always terminal (``add`` or ``remove``).
    The toggle convenience is resolved by :meth:`ReactionsStore.apply` before
    an event is constructed.
    """

    message_id: str = Field(..., min_length=1)
    emoji: str = Field(...)
    actor_key: str = Field(..., min_length=8, max_length=8)
    ts: str = Field(default_factory=now_iso)
    op: TerminalOp = Field(...)

    @field_validator("emoji")
    @classmethod
    def _v_emoji(cls, v: str) -> str:
        return _validate_emoji(v)

    @field_validator("actor_key")
    @classmethod
    def _v_actor(cls, v: str) -> str:
        if not KEY_PATTERN.match(v):
            raise ValueError("actor_key must be 8 lowercase hex chars")
        return v

    def to_jsonl_line(self) -> str:
        """Serialize as a single JSONL line (newline-terminated)."""
        return self.model_dump_json() + "\n"


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class _PerMessageState:
    """Mutable map: emoji -> ordered set of actor_keys.

    Insertion order preserved for deterministic serialization.
    """

    __slots__: tuple[str, ...] = ("_by_emoji",)

    def __init__(self) -> None:
        self._by_emoji: dict[str, dict[str, None]] = {}

    def add(self, emoji: str, actor_key: str) -> bool:
        """Add (emoji, actor) to the state. Returns True if newly added."""
        actors = self._by_emoji.setdefault(emoji, {})
        if actor_key in actors:
            return False
        actors[actor_key] = None
        return True

    def remove(self, emoji: str, actor_key: str) -> bool:
        """Remove (emoji, actor) from the state. Returns True if removed."""
        actors = self._by_emoji.get(emoji)
        if actors is None or actor_key not in actors:
            return False
        del actors[actor_key]
        if not actors:
            del self._by_emoji[emoji]
        return True

    def has(self, emoji: str, actor_key: str) -> bool:
        actors = self._by_emoji.get(emoji)
        return actors is not None and actor_key in actors

    def to_dict(self) -> dict[str, list[str]]:
        return {emoji: list(actors.keys()) for emoji, actors in self._by_emoji.items()}

    @classmethod
    def from_dict(cls, raw: dict[str, list[str]]) -> _PerMessageState:
        s = cls()
        for emoji, actors in raw.items():
            for actor in actors:
                s.add(emoji, actor)
        return s


class ReactionsStore:
    """In-memory reactions state + JSONL persistence per conversation.

    Lifecycle:
      1. ``ReactionsStore(conv_dir)`` — constructs and replays from disk
         (snapshot if present, then JSONL tail).
      2. ``apply(event)`` — resolves toggle, mutates state, appends to log.
      3. ``get(message_id)`` — returns ``{emoji: [actor_key, ...]}``.
      4. ``maybe_snapshot()`` — checks thresholds, writes
         ``reactions.snapshot.json`` and truncates the JSONL log when due.

    The store is thread-safe via a single :class:`threading.Lock`. MQTT
    publishing is intentionally NOT performed here; callers wire the publish
    step around :meth:`apply`'s return value.
    """

    JSONL_FILENAME: str = "reactions.jsonl"
    SNAPSHOT_FILENAME: str = "reactions.snapshot.json"

    def __init__(
        self,
        conv_dir: Path | str,
        *,
        line_threshold: int = SNAPSHOT_LINE_THRESHOLD,
        msg_threshold: int = SNAPSHOT_MSG_THRESHOLD,
    ) -> None:
        self._conv_dir: Path = Path(conv_dir)
        self._line_threshold: int = line_threshold
        self._msg_threshold: int = msg_threshold
        self._lock: threading.Lock = threading.Lock()
        self._state: dict[str, _PerMessageState] = defaultdict(_PerMessageState)
        # Number of lines currently in reactions.jsonl on disk (after the most
        # recent snapshot). Used to drive the snapshot trigger.
        self._jsonl_line_count: int = 0
        self._conv_dir.mkdir(parents=True, exist_ok=True)
        self._replay_from_disk()

    # -- public surface ---------------------------------------------------

    @property
    def jsonl_path(self) -> Path:
        return self._conv_dir / self.JSONL_FILENAME

    @property
    def snapshot_path(self) -> Path:
        return self._conv_dir / self.SNAPSHOT_FILENAME

    def get(self, message_id: str) -> dict[str, list[str]]:
        """Return the current state for *message_id* as ``{emoji: [actors]}``."""
        with self._lock:
            state = self._state.get(message_id)
            if state is None:
                return {}
            return state.to_dict()

    def get_all(self) -> dict[str, dict[str, list[str]]]:
        """Return a snapshot of state across every message."""
        with self._lock:
            return {mid: s.to_dict() for mid, s in self._state.items()}

    def has(self, message_id: str, emoji: str, actor_key: str) -> bool:
        """Whether *actor_key* currently has *emoji* on *message_id*."""
        with self._lock:
            state = self._state.get(message_id)
            return state.has(emoji, actor_key) if state is not None else False

    def apply(
        self,
        *,
        message_id: str,
        emoji: str,
        actor_key: str,
        op: ReactionOp,
        ts: str | None = None,
    ) -> ReactionEvent | None:
        """Apply an add/remove/toggle and persist to the JSONL log.

        Returns the resolved :class:`ReactionEvent` (with terminal op) on
        state change. Returns ``None`` when the operation was a no-op
        (e.g. ``op="add"`` for a reaction that already exists).

        Callers are expected to publish the returned event over MQTT.
        """
        emoji = _validate_emoji(emoji)
        if not KEY_PATTERN.match(actor_key):
            raise ValueError("actor_key must be 8 lowercase hex chars")
        ts = ts or now_iso()

        with self._lock:
            state = self._state[message_id]
            currently_has = state.has(emoji, actor_key)

            if op == "toggle":
                resolved: TerminalOp = "remove" if currently_has else "add"
            elif op in ("add", "remove"):
                resolved = op  # type: ignore[assignment]
            else:
                raise ValueError(f"invalid op: {op!r}")  # pyright: ignore[reportUnreachable]

            changed: bool
            if resolved == "add":
                changed = state.add(emoji, actor_key)
            else:
                changed = state.remove(emoji, actor_key)

            if not changed:
                return None  # no-op

            event = ReactionEvent(
                message_id=message_id,
                emoji=emoji,
                actor_key=actor_key,
                ts=ts,
                op=resolved,
            )
            self._append_jsonl(event)
            return event

    def maybe_snapshot(self, *, conversation_message_count: int) -> bool:
        """Write a snapshot + truncate the log if either threshold is reached.

        Returns True iff a snapshot was written.
        """
        with self._lock:
            if (
                self._jsonl_line_count < self._line_threshold
                and conversation_message_count < self._msg_threshold
            ):
                return False
            self._write_snapshot_locked()
            self._truncate_jsonl_locked()
            return True

    # -- internals --------------------------------------------------------

    def _replay_from_disk(self) -> None:
        """Reload state from snapshot (if any) and the JSONL tail."""
        # Snapshot first.
        if self.snapshot_path.is_file():
            try:
                raw = self.snapshot_path.read_text(encoding="utf-8")
                snap: Any = json.loads(raw)
                if isinstance(snap, dict):
                    # cast: isinstance-narrowing of Any/JSON yields Unknown type
                    # args; the snapshot is dynamic JSON, so these dynamic shapes
                    # are correct.
                    snap_map = cast("dict[str, Any]", snap)
                    for message_id, per_msg in snap_map.items():
                        if not isinstance(per_msg, dict):
                            continue
                        emoji_map = cast("dict[str, Any]", per_msg)
                        normalized: dict[str, list[str]] = {
                            str(k): list(cast("list[Any]", v))
                            for k, v in emoji_map.items()
                            if isinstance(v, list)
                        }
                        self._state[message_id] = _PerMessageState.from_dict(normalized)
            except (OSError, json.JSONDecodeError, ValueError) as exc:
                logger.warning(
                    "Failed to load reactions snapshot at %s: %s",
                    self.snapshot_path,
                    exc,
                )

        # Then the live log on top.
        if self.jsonl_path.is_file():
            line_count = 0
            try:
                with open(self.jsonl_path, encoding="utf-8") as fh:
                    for lineno, line in enumerate(fh, 1):
                        line = line.strip()
                        if not line:
                            continue
                        line_count += 1
                        try:
                            event = ReactionEvent.model_validate_json(line)
                        except (ValueError, json.JSONDecodeError) as exc:
                            logger.warning(
                                "Skipping malformed reaction at %s:%d (%s)",
                                self.jsonl_path.name,
                                lineno,
                                exc,
                            )
                            continue
                        state = self._state[event.message_id]
                        if event.op == "add":
                            state.add(event.emoji, event.actor_key)
                        else:
                            state.remove(event.emoji, event.actor_key)
            except OSError as exc:
                logger.warning("Could not read %s: %s", self.jsonl_path, exc)

            self._jsonl_line_count = line_count

    def _append_jsonl(self, event: ReactionEvent) -> None:
        """Append an event to the JSONL log (caller holds the lock)."""
        line = event.to_jsonl_line()
        try:
            with open(self.jsonl_path, "a", encoding="utf-8") as fh:
                fh.write(line)
        except OSError as exc:
            logger.error(
                "Failed to append reaction event to %s: %s", self.jsonl_path, exc
            )
            raise
        self._jsonl_line_count += 1

    def _write_snapshot_locked(self) -> None:
        """Atomically write the snapshot file (caller holds the lock)."""
        snap: dict[str, dict[str, list[str]]] = {
            mid: s.to_dict() for mid, s in self._state.items() if s.to_dict()
        }
        tmp = self.snapshot_path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(snap, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, self.snapshot_path)
        except OSError as exc:
            logger.error("Failed to write reactions snapshot: %s", exc)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def _truncate_jsonl_locked(self) -> None:
        """Truncate the JSONL log after a successful snapshot."""
        try:
            # Open in 'w' mode to truncate, immediately close.
            with open(self.jsonl_path, "w", encoding="utf-8"):
                pass
        except OSError as exc:
            logger.error("Failed to truncate %s: %s", self.jsonl_path, exc)
            raise
        self._jsonl_line_count = 0
