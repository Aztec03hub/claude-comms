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
from claude_comms.participant import (
    DEFAULT_ROLE,
    OWNER_ROLE,
    ChannelRole,
    Participant,
)

logger = logging.getLogger(__name__)


SCHEMA_VERSION = 3


# Schema DDL is kept verbatim so it can be inspected from tests and audit logs.
#
# The participants table has three profile_status_* columns appended in
# schema v3 (v0.4.2 Step 3.14, Wave A2 re-issue post-§I.18-collision-rename).
# Fresh installs get them via the inline DDL below; v0.4.0-v0.4.2-Wave-A
# installs get them via the idempotent ``PRAGMA table_info(participants)``
# guarded ALTER TABLE block in ``_init_schema`` (2 -> 3 migration).
_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS participants (
    key                         TEXT PRIMARY KEY,
    name                        TEXT NOT NULL,
    type                        TEXT NOT NULL CHECK (type IN ('claude','human')),
    created_at                  TEXT NOT NULL,
    last_seen                   TEXT NOT NULL,
    profile_status_emoji        TEXT NULL,
    profile_status_text         TEXT NULL,
    profile_status_expires_at   TEXT NULL
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

CREATE TABLE IF NOT EXISTS conversation_roles (
    conversation     TEXT NOT NULL,
    participant_key  TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    granted_at       TEXT NOT NULL,
    PRIMARY KEY (conversation, participant_key),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
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

    def __init__(self, db_path: Path, data_dir: Path | None = None) -> None:
        self._db_path = db_path
        # Conversation metadata lives next to registry.db in the data dir.
        # The 1->2 migration needs this to locate meta.json files for the
        # creator-grandfather backfill (Q6 lock-in, v0.4.2 Step 3.0a).
        self._data_dir = data_dir if data_dir is not None else db_path.parent
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
        return cls(db_path, data_dir=data_dir)

    @property
    def db_path(self) -> Path:
        """Absolute path to the SQLite file."""
        return self._db_path

    # -- Schema ------------------------------------------------------------

    def _init_schema(self) -> None:
        """Create tables if missing and run any pending migrations.

        Migration strategy: the DDL itself is idempotent (every CREATE uses
        IF NOT EXISTS) so re-running it on an old database simply adds any
        new tables. Column-level additions (e.g. v3's
        ``profile_status_*`` triplet on the ``participants`` table) cannot
        ride on ``CREATE TABLE IF NOT EXISTS`` and need explicit
        ``ALTER TABLE`` statements gated by ``PRAGMA table_info(...)`` so
        they are idempotent across daemon restarts.

        The schema_version row tells us which structural migrations still
        need to run; per-version blocks below remain in chronological
        order (1 -> 2 first, then 2 -> 3).
        """
        with self._lock:
            # Observe prior version BEFORE we touch the schema, so we can
            # distinguish "fresh install, just pin the version" from
            # "upgrade from v1, run the backfill". On a brand-new DB the
            # schema_meta table does not yet exist - that case is fresh.
            prior_version: int | None
            try:
                prior_row = self._conn.execute(
                    "SELECT value FROM schema_meta WHERE key='schema_version'"
                ).fetchone()
                prior_version = (
                    int(prior_row[0]) if prior_row is not None else None
                )
            except sqlite3.OperationalError:
                # schema_meta table does not exist yet (fresh install).
                prior_version = None

            self._conn.executescript(_SCHEMA_DDL)
            self._conn.execute(
                "INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)",
                ("schema_version", str(SCHEMA_VERSION)),
            )

            # 2 -> 3 column-level migration: add the three profile_status_*
            # columns to ``participants``. Idempotent via
            # ``PRAGMA table_info(...)`` introspection so re-running on a
            # post-v3 database is a guaranteed no-op. Fresh installs already
            # have these columns from ``_SCHEMA_DDL`` above, so the guard
            # short-circuits on the first iteration.
            existing_cols = {
                row[1]
                for row in self._conn.execute("PRAGMA table_info(participants)")
            }
            for col_name, col_type in (
                ("profile_status_emoji", "TEXT NULL"),
                ("profile_status_text", "TEXT NULL"),
                ("profile_status_expires_at", "TEXT NULL"),
            ):
                if col_name not in existing_cols:
                    self._conn.execute(
                        f"ALTER TABLE participants ADD COLUMN {col_name} {col_type}"
                    )

            self._conn.commit()

        # Run the 1 -> 2 backfill only on an actual upgrade. Fresh installs
        # have no conversations on disk to grandfather, and post-v2 restarts
        # already saw the bump and skipped it.
        if prior_version == 1:
            self._backfill_creator_roles_v1_to_v2()

        if prior_version is not None and prior_version > SCHEMA_VERSION:
            logger.warning(
                "registry.db schema_version=%s is newer than supported %s; "
                "proceeding read-only-ish, expect missing columns/tables",
                prior_version,
                SCHEMA_VERSION,
            )

        # Pin the version after migrations succeed.
        with self._lock:
            self._conn.execute(
                "UPDATE schema_meta SET value = ? WHERE key = 'schema_version'",
                (str(SCHEMA_VERSION),),
            )
            self._conn.commit()

    def _backfill_creator_roles_v1_to_v2(self) -> None:
        """One-shot: grandfather each channel's ``created_by`` as owner.

        For every conversation meta found on disk, look up ``created_by``
        (a display name, not a participant key) against ``participants``
        via the existing ``LOWER(name)`` index. If exactly one match,
        insert ``(conv, key, 'owner')`` via ``INSERT OR IGNORE`` so a
        pre-existing role row from a manual repair is never clobbered.

        Display-name collisions log a WARNING and skip the seed - the
        channel stays un-owned until an explicit ``set_channel_role``
        call sorts it out. This is the safer default than guessing.

        Channels whose ``created_by`` is a reserved system label
        (``"system"``, ``"system-backfill"``, ``"system-implicit"``) are
        also skipped because no real participant key can map to them.
        """
        # Import lazily so the registry_store module does not pull in
        # conversation.py at import time (avoids any cycle if conversation
        # ever needs registry types).
        from claude_comms.conversation import list_all_conversations

        try:
            metas = list_all_conversations(self._data_dir)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "v1->v2 role backfill: could not list conversations in %s: %s",
                self._data_dir,
                exc,
            )
            return

        if not metas:
            return

        now = now_iso()
        seeded = 0
        skipped_collision = 0
        skipped_unknown = 0

        with self._lock:
            for meta in metas:
                creator_name = (meta.created_by or "").strip()
                if not creator_name or creator_name.startswith("system"):
                    # Reserved system label or empty - nothing to map.
                    continue

                rows = self._conn.execute(
                    "SELECT key FROM participants WHERE LOWER(name) = LOWER(?)",
                    (creator_name,),
                ).fetchall()

                if len(rows) == 0:
                    skipped_unknown += 1
                    logger.info(
                        "v1->v2 role backfill: no participant matches creator "
                        "%r of channel %r; leaving un-owned",
                        creator_name,
                        meta.name,
                    )
                    continue

                if len(rows) > 1:
                    skipped_collision += 1
                    logger.warning(
                        "v1->v2 role backfill: display-name %r matches %d "
                        "participants for channel %r; skipping seed to avoid "
                        "ambiguous owner assignment (use set_channel_role)",
                        creator_name,
                        len(rows),
                        meta.name,
                    )
                    continue

                self._conn.execute(
                    """
                    INSERT OR IGNORE INTO conversation_roles
                        (conversation, participant_key, role, granted_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (meta.name, rows[0]["key"], OWNER_ROLE, now),
                )
                seeded += 1

            self._conn.commit()

        logger.info(
            "v1->v2 role backfill complete: %d seeded, %d skipped (collision), "
            "%d skipped (unknown creator)",
            seeded,
            skipped_collision,
            skipped_unknown,
        )

    # -- Bulk load ---------------------------------------------------------

    def load_all(self) -> RegistrySnapshot:
        """Return a snapshot of everything needed to rehydrate the registry.

        ``Participant.connections`` is left empty on every rehydrated
        participant — connections are ephemeral and not persisted.
        """
        with self._lock:
            snap = RegistrySnapshot()
            for row in self._conn.execute(
                "SELECT key, name, type, "
                "profile_status_emoji, profile_status_text, "
                "profile_status_expires_at "
                "FROM participants"
            ):
                snap.participants[row["key"]] = Participant(
                    key=row["key"],
                    name=row["name"],
                    type=row["type"],
                    profile_status_emoji=row["profile_status_emoji"],
                    profile_status_text=row["profile_status_text"],
                    profile_status_expires_at=row["profile_status_expires_at"],
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

    # -- Channel roles (v0.4.2 Step 3.0a) ---------------------------------

    def get_channel_role(
        self, conversation: str, participant_key: str
    ) -> ChannelRole:
        """Return ``participant_key``'s explicit role in ``conversation``.

        Defaults to ``"member"`` for any (conversation, key) pair with no
        explicit row, so role-gated frontend actions degrade safely on
        legacy v0.4.0 data that has never been touched by Step 3.5's admin
        UI. Callers that need to distinguish "explicit member" from
        "implicit default" should use ``list_channel_roles`` instead.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT role FROM conversation_roles "
                "WHERE conversation = ? AND participant_key = ?",
                (conversation, participant_key),
            ).fetchone()
        if row is None:
            return DEFAULT_ROLE
        return row["role"]

    def set_channel_role(
        self, conversation: str, participant_key: str, role: ChannelRole
    ) -> None:
        """Upsert a role assignment for ``participant_key`` in ``conversation``.

        Idempotent: re-setting the same role refreshes ``granted_at`` so
        audit downstreams can tell when the role was last (re)confirmed.
        Raises ``sqlite3.IntegrityError`` if ``role`` is not one of
        ``'owner'``, ``'admin'``, ``'member'`` (CHECK constraint).
        """
        now = now_iso()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO conversation_roles
                    (conversation, participant_key, role, granted_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(conversation, participant_key) DO UPDATE SET
                    role = excluded.role,
                    granted_at = excluded.granted_at
                """,
                (conversation, participant_key, role, now),
            )
            self._conn.commit()

    def list_channel_roles(self, conversation: str) -> dict[str, ChannelRole]:
        """Return all explicit role rows for ``conversation``.

        Keys are participant_keys, values are the literal role strings.
        Returns an empty dict for channels with no explicit role rows
        (those participants implicitly read as ``'member'`` via
        ``get_channel_role``).
        """
        with self._lock:
            cur = self._conn.execute(
                "SELECT participant_key, role FROM conversation_roles "
                "WHERE conversation = ?",
                (conversation,),
            )
            return {row["participant_key"]: row["role"] for row in cur}

    # -- Profile status (v0.4.2 Step 3.14, Wave A2 re-issue) --------------

    def set_profile_status(
        self,
        participant_key: str,
        *,
        emoji: str | None,
        text: str | None,
        expires_at: str | None,
    ) -> None:
        """Persist the profile-status triplet for ``participant_key``.

        Single UPDATE statement so the three columns always move together
        — mirrors the §I.18-collision rename rule that profile_status is
        one logical fact, not three independent toggles. Idempotent: a
        repeated identical call simply re-writes the same values.

        ``expires_at`` is the caller-canonical ISO 8601 string OR None.
        Storage is TEXT (NULL when None); the auto-expire coroutine compares
        as ISO strings via ``expire_profile_statuses_before``.
        """
        with self._lock:
            self._conn.execute(
                "UPDATE participants SET "
                "profile_status_emoji = ?, "
                "profile_status_text = ?, "
                "profile_status_expires_at = ? "
                "WHERE key = ?",
                (emoji, text, expires_at, participant_key),
            )
            self._conn.commit()

    def clear_profile_status(self, participant_key: str) -> None:
        """NULL out the profile-status triplet for ``participant_key``.

        Idempotent: clearing an already-cleared row is a no-op (single
        UPDATE that writes the same NULLs). Used by both the explicit
        ``comms_profile_status_clear`` MCP tool and the auto-expire sweep.
        """
        with self._lock:
            self._conn.execute(
                "UPDATE participants SET "
                "profile_status_emoji = NULL, "
                "profile_status_text = NULL, "
                "profile_status_expires_at = NULL "
                "WHERE key = ?",
                (participant_key,),
            )
            self._conn.commit()

    def list_expired_profile_statuses(self, now_iso_str: str) -> list[str]:
        """Return participant keys whose ``profile_status_expires_at`` < now.

        The auto-expire coroutine calls this on each tick, then issues
        per-key ``clear_profile_status`` + presence republish. Returning
        a small list (not a generator) keeps the lock window tight and
        the sweep idempotent — repeated reads see fewer expired rows
        each pass.
        """
        with self._lock:
            cur = self._conn.execute(
                "SELECT key FROM participants "
                "WHERE profile_status_expires_at IS NOT NULL "
                "  AND profile_status_expires_at < ?",
                (now_iso_str,),
            )
            return [row["key"] for row in cur]

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
