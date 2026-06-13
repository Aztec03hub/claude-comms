"""Unit tests for the per-channel role field (Q6 lock-in, v0.4.2 Step 3.0a).

Covers the new ``conversation_roles`` table, its 1->2 migration, the
creator-grandfather backfill, the three new ``RegistryStore`` methods
(``get_channel_role`` / ``set_channel_role`` / ``list_channel_roles``),
and the FK cascade + CHECK constraints that protect the table.

Test names match the spec block (Step 3.0a, plan lines 2409-2424) verbatim
so the orchestrator can audit coverage by grep.
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from claude_comms.conversation import (
    create_conversation_atomic,
    ensure_general_exists,
)
from claude_comms.participant import DEFAULT_ROLE, OWNER_ROLE, Participant
from claude_comms.registry_store import (
    SCHEMA_VERSION,
    RegistryStore,
    _SCHEMA_DDL,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> RegistryStore:
    """Fresh ``RegistryStore`` rooted at ``tmp_path`` (data_dir == tmp_path)."""
    s = RegistryStore.open(tmp_path)
    yield s
    s.close()


def _make_participant(key: str, name: str, ptype: str = "claude") -> Participant:
    return Participant(key=key, name=name, type=ptype)


def _seed_v1_db(tmp_path: Path) -> Path:
    """Bake a v0.4.0-era registry.db (schema_version=1, no roles table).

    Returns the data_dir. Caller is responsible for opening a fresh
    ``RegistryStore`` against this path to trigger the 1->2 migration.
    """
    db_path = tmp_path / "registry.db"
    conn = sqlite3.connect(str(db_path))
    try:
        # Replay only the v1 portion of the DDL (everything except the
        # v2 conversation_roles table). We do this by stripping that
        # block out of the live DDL string at runtime so this fixture
        # cannot drift from production schema if the v1 tables ever get
        # tweaked.
        v1_only = _SCHEMA_DDL.split("CREATE TABLE IF NOT EXISTS conversation_roles")[0]
        conn.executescript(v1_only)
        conn.execute(
            "INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)",
            ("schema_version", "1"),
        )
        conn.commit()
    finally:
        conn.close()
    return tmp_path


# ---------------------------------------------------------------------------
# Schema-level tests (1, 2)
# ---------------------------------------------------------------------------


def test_role_table_exists_after_init(store: RegistryStore) -> None:
    """conversation_roles table is present on fresh ``RegistryStore.open()``."""
    row = store._conn.execute(  # noqa: SLF001 - schema introspection
        "SELECT name FROM sqlite_master "
        "WHERE type='table' AND name='conversation_roles'"
    ).fetchone()
    assert row is not None, "conversation_roles table was not created by _init_schema"

    # And the four expected columns are there.
    cols = {
        r["name"]
        for r in store._conn.execute(  # noqa: SLF001
            "PRAGMA table_info(conversation_roles)"
        )
    }
    assert cols == {"conversation", "participant_key", "role", "granted_at"}


def test_schema_version_matches_constant(store: RegistryStore) -> None:
    """schema_meta records the current ``SCHEMA_VERSION`` after init.

    Originally named test_schema_version_bumped_to_2 (Step 3.0a); renamed
    in the P2/P3 cleanup pass because the literal "2" in the name was
    actively misleading after Step 3.14 bumped SCHEMA_VERSION to 3. The
    assertion body is unchanged — it compares against str(SCHEMA_VERSION).
    """
    row = store._conn.execute(  # noqa: SLF001
        "SELECT value FROM schema_meta WHERE key='schema_version'"
    ).fetchone()
    assert row is not None
    assert row[0] == str(SCHEMA_VERSION)


# ---------------------------------------------------------------------------
# get_channel_role / set_channel_role round-trips (3-7)
# ---------------------------------------------------------------------------


def test_get_role_defaults_to_member_for_unseen_pair(store: RegistryStore) -> None:
    """Unseen (conversation, key) pairs read as the ``'member'`` default."""
    assert store.get_channel_role("any-channel", "deadbeef") == "member"
    assert DEFAULT_ROLE == "member"


def test_set_then_get_owner_role(store: RegistryStore) -> None:
    """Round-trip: set owner -> get owner."""
    store.upsert_participant(_make_participant("aaaaaaaa", "alice"))
    store.set_channel_role("general", "aaaaaaaa", "owner")
    assert store.get_channel_role("general", "aaaaaaaa") == "owner"


def test_set_then_get_admin_role(store: RegistryStore) -> None:
    """Round-trip: set admin -> get admin."""
    store.upsert_participant(_make_participant("bbbbbbbb", "bob"))
    store.set_channel_role("ops", "bbbbbbbb", "admin")
    assert store.get_channel_role("ops", "bbbbbbbb") == "admin"


def test_set_role_is_idempotent(store: RegistryStore) -> None:
    """Re-setting the same role refreshes granted_at but does not raise."""
    store.upsert_participant(_make_participant("cccccccc", "carol"))
    store.set_channel_role("ops", "cccccccc", "admin")
    first = store._conn.execute(  # noqa: SLF001
        "SELECT granted_at FROM conversation_roles "
        "WHERE conversation='ops' AND participant_key='cccccccc'"
    ).fetchone()["granted_at"]

    # Idempotent re-assert. Should not raise; should still be 'admin'.
    store.set_channel_role("ops", "cccccccc", "admin")
    assert store.get_channel_role("ops", "cccccccc") == "admin"

    # And there is still exactly one row (PK constraint held).
    count = store._conn.execute(  # noqa: SLF001
        "SELECT COUNT(*) FROM conversation_roles "
        "WHERE conversation='ops' AND participant_key='cccccccc'"
    ).fetchone()[0]
    assert count == 1

    # granted_at was refreshed (or at least re-written - same value is fine).
    second = store._conn.execute(  # noqa: SLF001
        "SELECT granted_at FROM conversation_roles "
        "WHERE conversation='ops' AND participant_key='cccccccc'"
    ).fetchone()["granted_at"]
    assert second >= first


def test_set_role_overwrites_existing(store: RegistryStore) -> None:
    """member -> admin -> owner upgrade chain persists final role."""
    store.upsert_participant(_make_participant("dddddddd", "dave"))
    store.set_channel_role("general", "dddddddd", "member")
    assert store.get_channel_role("general", "dddddddd") == "member"
    store.set_channel_role("general", "dddddddd", "admin")
    assert store.get_channel_role("general", "dddddddd") == "admin"
    store.set_channel_role("general", "dddddddd", "owner")
    assert store.get_channel_role("general", "dddddddd") == "owner"


# ---------------------------------------------------------------------------
# list_channel_roles (8, 9)
# ---------------------------------------------------------------------------


def test_list_channel_roles_empty_default(store: RegistryStore) -> None:
    """Channels with no explicit role rows return an empty dict."""
    assert store.list_channel_roles("untouched") == {}


def test_list_channel_roles_includes_explicit_assignments(
    store: RegistryStore,
) -> None:
    """All explicit role rows for a channel are listed."""
    store.upsert_participant(_make_participant("11111111", "one"))
    store.upsert_participant(_make_participant("22222222", "two"))
    store.upsert_participant(_make_participant("33333333", "three"))
    store.set_channel_role("general", "11111111", "owner")
    store.set_channel_role("general", "22222222", "admin")
    # Channel with a different role row should not leak in.
    store.set_channel_role("ops", "33333333", "owner")

    roles = store.list_channel_roles("general")
    assert roles == {"11111111": "owner", "22222222": "admin"}


# ---------------------------------------------------------------------------
# FK cascade + CHECK constraint (10, 13)
# ---------------------------------------------------------------------------


def test_fk_cascade_on_participant_delete(store: RegistryStore) -> None:
    """Deleting a participant cascades the conversation_roles row away."""
    store.upsert_participant(_make_participant("ffffffff", "frank"))
    store.set_channel_role("general", "ffffffff", "owner")
    assert store.get_channel_role("general", "ffffffff") == "owner"

    # Trigger the ON DELETE CASCADE by removing the participant directly.
    with store._lock:  # noqa: SLF001 - direct delete for cascade verification
        store._conn.execute(  # noqa: SLF001
            "DELETE FROM participants WHERE key = ?", ("ffffffff",)
        )
        store._conn.commit()

    # Cascade should have wiped the role row, leaving the default behind.
    assert store.get_channel_role("general", "ffffffff") == "member"
    assert store.list_channel_roles("general") == {}


def test_invalid_role_raises(store: RegistryStore) -> None:
    """CHECK constraint rejects non-canonical role strings."""
    store.upsert_participant(_make_participant("99999999", "nine"))
    with pytest.raises(sqlite3.IntegrityError):
        # Cast through Any-ish call so the runtime CHECK is what catches it,
        # not just the static Literal type. The Literal exists for IDE / mypy
        # support; the DB is the actual enforcement boundary.
        store.set_channel_role("general", "99999999", "superadmin")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Backfill + cross-table behavior (11, 12, 14)
# ---------------------------------------------------------------------------


def test_backfill_grandfathers_creator_as_owner(tmp_path: Path) -> None:
    """1->2 migration: creator of a pre-existing channel becomes owner."""
    data_dir = _seed_v1_db(tmp_path)

    # Seed a participant + a conversation that points to it by display name.
    conn = sqlite3.connect(str(data_dir / "registry.db"))
    try:
        conn.execute(
            "INSERT INTO participants (key, name, type, created_at, last_seen) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                "1234abcd",
                "claude",
                "claude",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    # Conversation meta on disk with created_by='claude'.
    meta = create_conversation_atomic(
        name="general",
        topic="Main lobby",
        created_by="claude",
        data_dir=data_dir,
    )
    assert meta is not None

    # Confirm the seeded DB really is at schema_version=1 before we open
    # via RegistryStore (which triggers the migration).
    check = sqlite3.connect(str(data_dir / "registry.db"))
    try:
        pre_version = check.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        assert pre_version is not None and pre_version[0] == "1"
    finally:
        check.close()

    store = RegistryStore.open(data_dir)
    try:
        # Post-migration: version bumped, backfill seeded the owner row.
        # Compares against the live ``SCHEMA_VERSION`` constant so this
        # assertion survives v0.4.2 Step 3.14's 2 -> 3 bump (and any
        # future bumps) — historical "must end at v2 specifically"
        # intent is preserved by the 1 -> 2 backfill assertion below
        # (which is what this test actually covers).
        ver = store._conn.execute(  # noqa: SLF001
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        assert ver[0] == str(SCHEMA_VERSION)
        assert store.get_channel_role("general", "1234abcd") == OWNER_ROLE
        assert store.list_channel_roles("general") == {"1234abcd": "owner"}
    finally:
        store.close()


def test_backfill_skips_ambiguous_name_collision(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Two participants both named 'claude' -> backfill logs WARNING, skips."""
    data_dir = _seed_v1_db(tmp_path)

    conn = sqlite3.connect(str(data_dir / "registry.db"))
    try:
        conn.execute(
            "INSERT INTO participants (key, name, type, created_at, last_seen) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                "aaaa0001",
                "claude",
                "claude",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )
        conn.execute(
            "INSERT INTO participants (key, name, type, created_at, last_seen) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                "bbbb0002",
                "claude",
                "claude",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    meta = create_conversation_atomic(
        name="general",
        topic="Main lobby",
        created_by="claude",
        data_dir=data_dir,
    )
    assert meta is not None

    with caplog.at_level(logging.WARNING, logger="claude_comms.registry_store"):
        store = RegistryStore.open(data_dir)
        try:
            # No role row seeded for either ambiguous candidate.
            assert store.list_channel_roles("general") == {}
            assert store.get_channel_role("general", "aaaa0001") == "member"
            assert store.get_channel_role("general", "bbbb0002") == "member"
        finally:
            store.close()

    # And the operator-facing WARNING was emitted so the ambiguity is visible.
    collision_messages = [
        rec.message
        for rec in caplog.records
        if rec.levelno >= logging.WARNING and "ambiguous" in rec.message.lower()
    ]
    assert collision_messages, (
        "expected at least one WARNING about ambiguous display-name collision"
    )


def test_role_table_unaffected_by_membership_drop(store: RegistryStore) -> None:
    """``remove_membership`` does NOT clear role rows (Step 3.0a §14)."""
    store.upsert_participant(_make_participant("eeee0001", "erin"))
    store.add_membership("eeee0001", "general")
    store.set_channel_role("general", "eeee0001", "admin")
    assert store.get_channel_role("general", "eeee0001") == "admin"

    # Drop membership. Role row should survive so re-joining preserves role.
    store.remove_membership("eeee0001", "general")
    assert store.get_channel_role("general", "eeee0001") == "admin"
    assert store.list_channel_roles("general") == {"eeee0001": "admin"}


# ---------------------------------------------------------------------------
# Migration smoke - populated v0.4.0 fixture (worklog gate)
# ---------------------------------------------------------------------------


def test_migration_smoke_v1_db_opens_clean_at_v2(tmp_path: Path) -> None:
    """Open a fresh v1-baked DB and confirm post-open version == 2."""
    data_dir = _seed_v1_db(tmp_path)
    # ensure_general_exists builds a default meta with created_by='system'
    # which the backfill skips (reserved label). Used here to make sure the
    # 'system' skip path runs without error on a non-empty data_dir.
    ensure_general_exists(data_dir)

    store = RegistryStore.open(data_dir)
    try:
        ver = store._conn.execute(  # noqa: SLF001
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        # Widened from literal "2" to ``str(SCHEMA_VERSION)`` so this
        # 1 -> latest smoke survives v0.4.2 Step 3.14's 2 -> 3 bump and
        # any future column-only bumps. The test's substantive coverage
        # (system-creator skip + clean open) is unchanged.
        assert ver[0] == str(SCHEMA_VERSION)
        # No role row for 'general' because created_by='system'.
        assert store.list_channel_roles("general") == {}
    finally:
        store.close()
