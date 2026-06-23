"""Unit tests for ``RegistryStore`` -- SQLite-backed persistence.

Validates the low-level CRUD surface used by ``ParticipantRegistry``:
schema initialization, round-trip persistence, foreign-key cascades, the
``purge_stale`` admin helper, and basic concurrent-write safety.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from claude_comms.participant import Participant
from claude_comms.registry_store import (
    SCHEMA_VERSION,
    RegistrySnapshot,
    RegistryStore,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> Iterator[RegistryStore]:
    """Fresh ``RegistryStore`` rooted at ``tmp_path``."""
    s = RegistryStore.open(tmp_path)
    yield s
    s.close()


def _make_participant(key: str, name: str, ptype: str = "claude") -> Participant:
    return Participant(key=key, name=name, type=ptype)  # pyright: ignore[reportArgumentType]


# ---------------------------------------------------------------------------
# Schema + open
# ---------------------------------------------------------------------------


def test_open_creates_db_file_and_parent_dir(tmp_path: Path) -> None:
    target_dir = tmp_path / "nested" / "dir"
    store = RegistryStore.open(target_dir)
    try:
        assert (target_dir / "registry.db").exists()
        assert store.db_path == target_dir / "registry.db"
    finally:
        store.close()


def test_open_defaults_to_home_claude_comms(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Default ``data_dir`` is ``~/.claude-comms``."""
    monkeypatch.setenv("HOME", str(tmp_path))
    store = RegistryStore.open()
    try:
        assert store.db_path == tmp_path / ".claude-comms" / "registry.db"
        assert store.db_path.exists()
    finally:
        store.close()


def test_schema_meta_records_version(store: RegistryStore) -> None:
    row = store._conn.execute(  # noqa: SLF001 — schema-level inspection
        "SELECT value FROM schema_meta WHERE key='schema_version'"
    ).fetchone()
    assert row is not None
    assert row[0] == str(SCHEMA_VERSION)


def test_wal_mode_is_active(store: RegistryStore) -> None:
    row = store._conn.execute("PRAGMA journal_mode").fetchone()  # noqa: SLF001
    assert row[0].lower() == "wal"


def test_foreign_keys_enabled(store: RegistryStore) -> None:
    row = store._conn.execute("PRAGMA foreign_keys").fetchone()  # noqa: SLF001
    assert row[0] == 1


# ---------------------------------------------------------------------------
# Bulk load on empty store
# ---------------------------------------------------------------------------


def test_load_all_empty_returns_empty_snapshot(store: RegistryStore) -> None:
    snap = store.load_all()
    assert isinstance(snap, RegistrySnapshot)
    assert snap.participants == {}
    assert snap.memberships == {}
    assert snap.read_cursors == {}
    assert snap.thread_read_cursors == {}


# ---------------------------------------------------------------------------
# Participant round-trip
# ---------------------------------------------------------------------------


def test_upsert_participant_round_trip(tmp_path: Path) -> None:
    store = RegistryStore.open(tmp_path)
    p = _make_participant("abcd1234", "alice", "claude")
    store.upsert_participant(p)
    store.close()

    # Reopen and verify
    store = RegistryStore.open(tmp_path)
    snap = store.load_all()
    assert "abcd1234" in snap.participants
    loaded = snap.participants["abcd1234"]
    assert loaded.name == "alice"
    assert loaded.type == "claude"
    assert loaded.connections == {}  # not persisted
    store.close()


def test_upsert_participant_idempotent(store: RegistryStore) -> None:
    p = _make_participant("abcd1234", "alice")
    store.upsert_participant(p)
    store.upsert_participant(p)
    snap = store.load_all()
    assert len(snap.participants) == 1


def test_update_participant_name_persists(tmp_path: Path) -> None:
    store = RegistryStore.open(tmp_path)
    store.upsert_participant(_make_participant("abcd1234", "alice"))
    store.update_participant_name("abcd1234", "alice_renamed")
    store.close()

    store = RegistryStore.open(tmp_path)
    snap = store.load_all()
    assert snap.participants["abcd1234"].name == "alice_renamed"
    store.close()


# ---------------------------------------------------------------------------
# Membership round-trip
# ---------------------------------------------------------------------------


def test_add_membership_round_trip(tmp_path: Path) -> None:
    store = RegistryStore.open(tmp_path)
    store.upsert_participant(_make_participant("abcd1234", "alice"))
    store.add_membership("abcd1234", "general")
    store.add_membership("abcd1234", "ops")
    store.close()

    store = RegistryStore.open(tmp_path)
    snap = store.load_all()
    assert snap.memberships["abcd1234"] == {"general", "ops"}
    store.close()


def test_remove_membership_removes_only_named_conv(store: RegistryStore) -> None:
    store.upsert_participant(_make_participant("abcd1234", "alice"))
    store.add_membership("abcd1234", "general")
    store.add_membership("abcd1234", "ops")
    store.remove_membership("abcd1234", "ops")
    snap = store.load_all()
    assert snap.memberships["abcd1234"] == {"general"}


def test_add_membership_is_idempotent(store: RegistryStore) -> None:
    store.upsert_participant(_make_participant("abcd1234", "alice"))
    store.add_membership("abcd1234", "general")
    store.add_membership("abcd1234", "general")
    snap = store.load_all()
    assert snap.memberships["abcd1234"] == {"general"}


# ---------------------------------------------------------------------------
# Read-cursor round-trip
# ---------------------------------------------------------------------------


def test_read_cursor_round_trip(tmp_path: Path) -> None:
    store = RegistryStore.open(tmp_path)
    store.upsert_participant(_make_participant("abcd1234", "alice"))
    store.upsert_read_cursor("abcd1234", "general", "2026-05-12T10:00:00Z")
    store.upsert_read_cursor("abcd1234", "general", "2026-05-12T11:00:00Z")  # update
    store.close()

    store = RegistryStore.open(tmp_path)
    snap = store.load_all()
    assert snap.read_cursors[("abcd1234", "general")] == "2026-05-12T11:00:00Z"
    store.close()


def test_thread_read_cursor_round_trip(tmp_path: Path) -> None:
    store = RegistryStore.open(tmp_path)
    store.upsert_participant(_make_participant("abcd1234", "alice"))
    store.upsert_thread_read_cursor(
        "abcd1234", "general", "root-abc", "2026-05-12T10:00:00Z"
    )
    store.upsert_thread_read_cursor(
        "abcd1234", "general", "root-abc", "2026-05-12T11:00:00Z"
    )
    store.close()

    store = RegistryStore.open(tmp_path)
    snap = store.load_all()
    assert (
        snap.thread_read_cursors[("abcd1234", "general", "root-abc")]
        == "2026-05-12T11:00:00Z"
    )
    store.close()


# ---------------------------------------------------------------------------
# Foreign-key cascade
# ---------------------------------------------------------------------------


def test_purge_stale_cascades_memberships_and_cursors(store: RegistryStore) -> None:
    # Create a participant with last_seen way in the past, plus memberships
    # and cursors that should cascade away when the participant is purged.
    store.upsert_participant(_make_participant("aaaaaaaa", "stale"))
    store.add_membership("aaaaaaaa", "general")
    store.upsert_read_cursor("aaaaaaaa", "general", "2026-05-12T00:00:00Z")
    store.upsert_thread_read_cursor(
        "aaaaaaaa", "general", "root-x", "2026-05-12T00:00:00Z"
    )
    # Force last_seen back-dated so the purge cutoff captures it.
    store._conn.execute(  # noqa: SLF001 — direct schema poke is the point
        "UPDATE participants SET last_seen = ? WHERE key = ?",
        ("2025-01-01T00:00:00Z", "aaaaaaaa"),
    )
    store._conn.commit()  # noqa: SLF001

    # Fresh participant on the other side of the cutoff -- must NOT be purged.
    store.upsert_participant(_make_participant("bbbbbbbb", "fresh"))
    store.add_membership("bbbbbbbb", "general")

    deleted = store.purge_stale("2026-01-01T00:00:00Z")
    assert deleted == 1

    snap = store.load_all()
    assert "aaaaaaaa" not in snap.participants
    assert "bbbbbbbb" in snap.participants
    assert "aaaaaaaa" not in snap.memberships
    assert ("aaaaaaaa", "general") not in snap.read_cursors
    assert ("aaaaaaaa", "general", "root-x") not in snap.thread_read_cursors


def test_purge_stale_returns_zero_when_no_match(store: RegistryStore) -> None:
    store.upsert_participant(_make_participant("aaaaaaaa", "fresh"))
    deleted = store.purge_stale("2000-01-01T00:00:00Z")
    assert deleted == 0


# ---------------------------------------------------------------------------
# Concurrent writes
# ---------------------------------------------------------------------------


def test_concurrent_writes_do_not_corrupt(store: RegistryStore) -> None:
    """Two threads spamming inserts must not corrupt the schema or lose rows.

    Not a stress test — just a basic sanity check that the lock + WAL combo
    handles parallel writes from the same store handle.
    """
    keys_thread_a = [f"a{i:07x}" for i in range(50)]
    keys_thread_b = [f"b{i:07x}" for i in range(50)]

    def writer(keys: list[str]) -> None:
        for k in keys:
            store.upsert_participant(_make_participant(k, f"p_{k}"))

    t_a = threading.Thread(target=writer, args=(keys_thread_a,))
    t_b = threading.Thread(target=writer, args=(keys_thread_b,))
    t_a.start()
    t_b.start()
    t_a.join()
    t_b.join()

    snap = store.load_all()
    assert len(snap.participants) == 100
    for k in keys_thread_a + keys_thread_b:
        assert k in snap.participants


# ---------------------------------------------------------------------------
# Connections are NOT persisted
# ---------------------------------------------------------------------------


def test_connections_field_absent_from_schema(store: RegistryStore) -> None:
    """``Participant.connections`` MUST NOT have a column — it is ephemeral."""
    rows = store._conn.execute(  # noqa: SLF001
        "PRAGMA table_info(participants)"
    ).fetchall()
    column_names = {row[1] for row in rows}
    assert "connections" not in column_names
    # And the columns we DO expect are present.
    assert {"key", "name", "type", "created_at", "last_seen"} <= column_names


# ---------------------------------------------------------------------------
# Close is idempotent
# ---------------------------------------------------------------------------


def test_close_is_idempotent(tmp_path: Path) -> None:
    store = RegistryStore.open(tmp_path)
    store.close()
    store.close()  # must not raise
