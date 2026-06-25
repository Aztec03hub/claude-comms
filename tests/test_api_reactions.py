"""Tests for the ``/api/reactions/{conversation}`` batch hydration endpoint.

Covers (M9 of the reactions hover/tooltip + detail panel feature):

- :func:`claude_comms.cli.build_reactions_route` HTTP wiring through a Starlette
  TestClient: 200 ``{conversation, reactions}`` shape and 400 on a bad
  conversation id.
- :func:`claude_comms.mcp_server.get_conversation_reactions` mirrors the backing
  ``ReactionsStore.get_all()`` snapshot shape ``{message_id: {emoji: [key]}}``.

The route's data source is injected (mirroring ``build_conversations_route``
tests) so no broker/daemon is required.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

import claude_comms.mcp_server as mcp_mod
from claude_comms.cli import build_reactions_route
from claude_comms.reactions import ReactionsStore


# ---------------------------------------------------------------------------
# 1. build_reactions_route — HTTP wiring (shape + validation)
# ---------------------------------------------------------------------------


class TestReactionsRoute:
    """GET /api/reactions/{conversation} through the real route builder."""

    @staticmethod
    def _client(reactions_by_conv):
        captured = {}

        def fake_get(conversation):
            captured["conversation"] = conversation
            return reactions_by_conv.get(conversation, {})

        client = TestClient(Starlette(routes=[build_reactions_route(fake_get)]))
        return client, captured

    def test_returns_conversation_and_reactions_shape(self):
        snapshot = {
            "msg-1": {"👍": ["aabbccdd", "11223344"], "🎉": ["aabbccdd"]},
            "msg-2": {"❤️": ["deadbeef"]},
        }
        client, captured = self._client({"general": snapshot})
        resp = client.get("/api/reactions/general")
        assert resp.status_code == 200
        body = resp.json()
        assert body["conversation"] == "general"
        assert body["reactions"] == snapshot
        assert captured["conversation"] == "general"

    def test_empty_conversation_yields_empty_reactions(self):
        client, _ = self._client({})
        resp = client.get("/api/reactions/general")
        assert resp.status_code == 200
        assert resp.json() == {"conversation": "general", "reactions": {}}

    def test_bad_conversation_id_returns_400(self):
        client, _ = self._client({})
        # Slashes can't appear in a single path segment; use an id with an
        # invalid character that still routes to the handler.
        resp = client.get("/api/reactions/bad id with spaces")
        assert resp.status_code == 400
        assert "error" in resp.json()


# ---------------------------------------------------------------------------
# 2. get_conversation_reactions — mirrors ReactionsStore.get_all()
# ---------------------------------------------------------------------------


@pytest.fixture
def reactions_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point mcp_server at a fresh per-conversation reactions data dir and
    reset the lazily-built store cache so each test is isolated."""
    data_dir = tmp_path / "conv_data"
    data_dir.mkdir()
    monkeypatch.setattr(mcp_mod, "_conv_data_dir", data_dir)
    monkeypatch.setattr(mcp_mod, "_reactions_stores", {})
    return data_dir


class TestGetConversationReactions:
    """The backing function delegates straight to ReactionsStore.get_all()."""

    def test_mirrors_get_all_shape(self, reactions_data_dir: Path) -> None:
        store = mcp_mod._get_reactions_store("general")
        store.apply(message_id="m1", emoji="👍", actor_key="aabbccdd", op="add")
        store.apply(message_id="m1", emoji="👍", actor_key="11223344", op="add")
        store.apply(message_id="m1", emoji="🎉", actor_key="aabbccdd", op="add")
        store.apply(message_id="m2", emoji="❤️", actor_key="deadbeef", op="add")

        result = mcp_mod.get_conversation_reactions("general")
        assert result == {
            "m1": {"👍": ["aabbccdd", "11223344"], "🎉": ["aabbccdd"]},
            "m2": {"❤️": ["deadbeef"]},
        }
        # Identical to the store's own snapshot.
        assert result == store.get_all()

    def test_empty_conversation_returns_empty_dict(
        self, reactions_data_dir: Path
    ) -> None:
        assert mcp_mod.get_conversation_reactions("never-used") == {}

    def test_get_of_nonexistent_conv_creates_no_dir_or_cache(
        self, reactions_data_dir: Path
    ) -> None:
        """A pure GET must not mkdir or cache a store for a conversation that
        has never had a reaction (M-3: read must be side-effect-free)."""
        result = mcp_mod.get_conversation_reactions("ghost-conv")
        assert result == {}
        # No directory was created on disk for the non-existent conversation.
        assert not (reactions_data_dir / "ghost-conv").exists()
        # No store was cached for it either (unbounded-growth guard).
        assert "ghost-conv" not in mcp_mod._reactions_stores

    def test_get_reuses_existing_store_after_write(
        self, reactions_data_dir: Path
    ) -> None:
        """Once a write path has built+cached the store, a later GET reads it
        (the dir now exists and the cache hit short-circuits the disk check)."""
        store = mcp_mod._get_reactions_store("general")
        store.apply(message_id="m1", emoji="👍", actor_key="aabbccdd", op="add")
        assert mcp_mod.get_conversation_reactions("general") == {
            "m1": {"👍": ["aabbccdd"]}
        }

    def test_get_reads_existing_dir_without_cached_store(
        self, reactions_data_dir: Path
    ) -> None:
        """When the conversation dir already exists on disk but no store is
        cached (e.g. fresh process after a restart), the GET builds the store
        and replays the persisted reactions."""
        # Simulate a prior process having persisted reactions for the conv.
        store = mcp_mod._get_reactions_store("general")
        store.apply(message_id="m1", emoji="🎉", actor_key="deadbeef", op="add")
        # Drop the in-memory cache, keeping the on-disk dir + log.
        mcp_mod._reactions_stores.clear()
        assert (reactions_data_dir / "general").exists()
        assert mcp_mod.get_conversation_reactions("general") == {
            "m1": {"🎉": ["deadbeef"]}
        }

    def test_remove_reflected_in_snapshot(self, reactions_data_dir: Path) -> None:
        store = mcp_mod._get_reactions_store("general")
        store.apply(message_id="m1", emoji="👍", actor_key="aabbccdd", op="add")
        store.apply(message_id="m1", emoji="👍", actor_key="11223344", op="add")
        store.apply(message_id="m1", emoji="👍", actor_key="aabbccdd", op="remove")
        result = mcp_mod.get_conversation_reactions("general")
        assert result == {"m1": {"👍": ["11223344"]}}

    def test_insertion_order_preserved(self, reactions_data_dir: Path) -> None:
        """Actor order must match server insertion order (first-reacted-first),
        which the client relies on for deterministic 'You'/+N rendering."""
        store = mcp_mod._get_reactions_store("general")
        for key in ("aabbccdd", "11223344", "deadbeef"):
            store.apply(message_id="m1", emoji="👍", actor_key=key, op="add")
        result = mcp_mod.get_conversation_reactions("general")
        assert result["m1"]["👍"] == ["aabbccdd", "11223344", "deadbeef"]


def test_route_uses_real_backing_fn_end_to_end(
    reactions_data_dir: Path,
) -> None:
    """Wire the REAL get_conversation_reactions into the REAL route."""
    store = mcp_mod._get_reactions_store("general")
    store.apply(message_id="m1", emoji="👍", actor_key="aabbccdd", op="add")

    _ = ReactionsStore  # imported for parity with reactions module under test
    client = TestClient(
        Starlette(routes=[build_reactions_route(mcp_mod.get_conversation_reactions)])
    )
    resp = client.get("/api/reactions/general")
    assert resp.status_code == 200
    assert resp.json() == {
        "conversation": "general",
        "reactions": {"m1": {"👍": ["aabbccdd"]}},
    }
