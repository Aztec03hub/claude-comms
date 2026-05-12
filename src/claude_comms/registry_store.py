"""SQLite-backed persistence for ``ParticipantRegistry`` state.

The participant registry was historically pure in-memory state — every daemon
restart silently invalidated every participant key, breaking the "standing
agent" use case where a Claude Code agent joins once and expects its key to
keep working across ``claude-comms stop && start`` cycles.

This module persists the durable parts of that registry (participants,
conversation memberships, and read cursors) to a single SQLite file at
``~/.claude-comms/registry.db``. Ephemeral presence state
(``Participant.connections``) is **NOT** persisted — agents come back offline
on restart and re-populate connections via MQTT presence + the MCP
``_ensure_mcp_connection`` synthesis on next interaction.

Schema is at v1; ``schema_meta`` is a forward-compat anchor for future
migrations. Connections are opened with WAL mode, ``synchronous=NORMAL``, and
foreign keys ON — the right tradeoff for a single-process daemon (durability
across process crashes is preserved; only literal power loss can lose the
last commit, which doesn't matter for this kind of state).
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path

from claude_comms.message import now_iso
from claude_comms.participant import Participant

logger = logging.getLogger(__name__)


SCHEMA_VERSION = 1


# Schema DDL is kept verbatim so it can be inspected from tests and audit logs.
_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS participants (
    key         TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('claude','human')),
    created_at  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_name_lower ON participants (LOWER(name));

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation     TEXT NOT NULL,
    participant_key  TEXT NOT NULL,
    joined_at        TEXT NOT NULL,
    PRIMARY KEY (conversation, participant_key),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS read_cursors (
    participant_key  TEXT NOT NULL,
    conversation     TEXT NOT NULL,
    last_read_ts     TEXT NOT NULL,
    PRIMARY KEY (participant_key, conversation),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS thread_read_cursors (
    participant_key  TEXT NOT NULL,
    conversation     TEXT NOT NULL,
    root_id          TEXT NOT NULL,
    last_read_ts     TEXT NOT NULL,
    PRIMARY KEY (participant_key, conversation, root_id),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@dataclass
class RegistrySnapshot:
    """Everything needed to rehydrate ``ParticipantRegistry`` in-memory state.

    Fields mirror ``ParticipantRegistry``'s private dict layout 1:1 so the
    registry's ``__init__`` can swap them in directly.
    """

    participants: dict[str, Participant] = field(default_factory=dict)
    memberships: dict[str, set[str]] = field(default_factory=dict)
    read_cursors: dict[tuple[str, str], str] = field(default_factory=dict)
    thread_read_cursors: dict[tuple[str, str, str], str] = field(default_factory=dict)


class RegistryStore:
    """SQLite-backed persistence for ``ParticipantRegistry`` state.

    Thread-safe: the connection is opened with ``check_same_thread=False`` and
    every write goes through a single ``threading.Lock``. All mutating
    methods commit in a single transaction so the on-disk state is never
    half-updated.

    Connections are NOT persisted — ``Participant.connections`` is ephemeral
    presence state. Rehydrated participants always come back with empty
    ``connections`` (i.e. ``is_online == False``) and re-populate via MQTT
    presence or ``_ensure_mcp_connection`` on next interaction.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        # PRAGMAs in spec-prescribed order. WAL keeps reads non-blocking
        # during the rare write; synchronous=NORMAL is the right tradeoff
        # for a single-process daemon; foreign_keys=ON makes cascades work.
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    # -- Construction ------------------------------------------------------

    @classmethod
    def open(cls, data_dir: Path | None = None) -> RegistryStore:
        """Open or create the registry DB at ``<data_dir>/registry.db``.

        ``data_dir`` defaults to ``~/.claude-comms/``. Creates parent dirs
        as needed. Runs schema initialization/migration on open.
        """
        if data_dir is None:
            data_dir = Path.home() / ".claude-comms"
        data_dir.mkdir(parents=True, exist_ok=True)
        db_path = data_dir / "registry.db"
        return cls(db_path)

    @property
    def db_path(self) -> Path:
        """Absolute path to the SQLite file."""
        return self._db_path

    # -- Schema ------------------------------------------------------------

    def _init_schema(self) -> None:
        """Create tables if missing and pin the schema version."""
        with self._lock:
            self._conn.executescript(_SCHEMA_DDL)
            self._conn.execute(
                "INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)",
                ("schema_version", str(SCHEMA_VERSION)),
            )
            self._conn.commit()
            # Future migration blocks would go here, gated on
            # SELECT value FROM schema_meta WHERE key='schema_version'.

    # -- Bulk load ---------------------------------------------------------

    def load_all(self) -> RegistrySnapshot:
        """Return a snapshot of everything needed to rehydrate the registry.

        ``Participant.connections`` is left empty on every rehydrated
        participant — connections are ephemeral and not persisted.
        """
        with self._lock:
            snap = RegistrySnapshot()
            for row in self._conn.execute("SELECT key, name, type FROM participants"):
                snap.participants[row["key"]] = Participant(
                    key=row["key"],
                    name=row["name"],
                    type=row["type"],
                )
                # Ensure every participant has at least an empty membership
                # set so callers can do ``setdefault`` style mutations
                # without an extra existence check.
                snap.memberships.setdefault(row["key"], set())

            for row in self._conn.execute(
                "SELECT participant_key, conversation FROM conversation_members"
            ):
                snap.memberships.setdefault(row["participant_key"], set()).add(
                    row["conversation"]
                )

            for row in self._conn.execute(
                "SELECT participant_key, conversation, last_read_ts FROM read_cursors"
            ):
                snap.read_cursors[(row["participant_key"], row["conversation"])] = row[
                    "last_read_ts"
                ]

            for row in self._conn.execute(
                "SELECT participant_key, conversation, root_id, last_read_ts "
                "FROM thread_read_cursors"
            ):
                snap.thread_read_cursors[
                    (row["participant_key"], row["conversation"], row["root_id"])
                ] = row["last_read_ts"]

            return snap

    # -- Mutations ---------------------------------------------------------

    def upsert_participant(self, p: Participant) -> None:
        """Insert a new participant or refresh an existing one's ``last_seen``.

        ``created_at`` is set only on first insert; subsequent calls only bump
        ``last_seen`` (and refresh name/type defensively in case caller renamed
        without going through ``update_participant_name``).
        """
        now = now_iso()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO participants (key, name, type, created_at, last_seen)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    name = excluded.name,
                    type = excluded.type,
                    last_seen = excluded.last_seen
                """,
                (p.key, p.name, p.type, now, now),
            )
            self._conn.commit()

    def update_participant_name(self, key: str, new_name: str) -> None:
        """Change a participant's display name. Bumps ``last_seen``."""
        now = now_iso()
        with self._lock:
            self._conn.execute(
                "UPDATE participants SET name = ?, last_seen = ? WHERE key = ?",
                (new_name, now, key),
            )
            self._conn.commit()

    def add_membership(self, key: str, conversation: str) -> None:
        """Record that ``key`` is a member of ``conversation``.

        Idempotent — re-adding an existing membership leaves ``joined_at``
        untouched so the original join timestamp survives re-joins.
        """
        now = now_iso()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO conversation_members
                    (conversation, participant_key, joined_at)
                VALUES (?, ?, ?)
                ON CONFLICT(conversation, participant_key) DO NOTHING
                """,
                (conversation, key, now),
            )
            self._conn.execute(
                "UPDATE participants SET last_seen = ? WHERE key = ?",
                (now, key),
            )
            self._conn.commit()

    def remove_membership(self, key: str, conversation: str) -> None:
        """Drop ``key``'s membership in ``conversation``. No-op if missing."""
        now = now_iso()
        with self._lock:
            self._conn.execute(
                "DELETE FROM conversation_members "
                "WHERE participant_key = ? AND conversation = ?",
                (key, conversation),
            )
            self._conn.execute(
                "UPDATE participants SET last_seen = ? WHERE key = ?",
                (now, key),
            )
            self._conn.commit()

    def upsert_read_cursor(self, key: str, conversation: str, ts: str) -> None:
        """Set the per-conversation read cursor for ``key``."""
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO read_cursors
                    (participant_key, conversation, last_read_ts)
                VALUES (?, ?, ?)
                ON CONFLICT(participant_key, conversation) DO UPDATE SET
                    last_read_ts = excluded.last_read_ts
                """,
                (key, conversation, ts),
            )
            self._conn.commit()

    def upsert_thread_read_cursor(
        self, key: str, conversation: str, root_id: str, ts: str
    ) -> None:
        """Set the per-thread read cursor for ``key``'s view of ``root_id``."""
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO thread_read_cursors
                    (participant_key, conversation, root_id, last_read_ts)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(participant_key, conversation, root_id) DO UPDATE SET
                    last_read_ts = excluded.last_read_ts
                """,
                (key, conversation, root_id, ts),
            )
            self._conn.commit()

    # -- Admin -------------------------------------------------------------

    def purge_stale(self, before_iso: str) -> int:
        """Delete participants whose ``last_seen`` is older than ``before_iso``.

        Memberships and cursors cascade via the FK ON DELETE CASCADE.
        Returns the number of participants deleted.
        """
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM participants WHERE last_seen < ?",
                (before_iso,),
            )
            self._conn.commit()
            return cur.rowcount

    def close(self) -> None:
        """Close the underlying SQLite connection. Safe to call repeatedly."""
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.ProgrammingError:
                # Already closed.
                pass

    # -- Context manager sugar --------------------------------------------

    def __enter__(self) -> RegistryStore:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()
