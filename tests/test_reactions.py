"""Phase A backend tests for reactions (claude-phoenix).

Covers:
- Storage layer (`reactions.ReactionsStore`): apply add/remove/toggle, no-op
  detection, replay from JSONL, snapshot+truncate at threshold, post-snapshot
  replay, malformed-line tolerance.
- MCP tool functions (`tool_comms_react`, `tool_comms_reactions_get`):
  validation, op semantics, rate limiting, per-message cap, MQTT publish
  payload shape, no-op suppression of publishes.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import pytest

from claude_comms import mcp_tools
from claude_comms.mcp_tools import (
    MAX_REACTIONS_PER_MESSAGE_PER_ACTOR,
    ParticipantRegistry,
    REACTIONS_PER_ACTOR_PER_MINUTE,
    tool_comms_react,
    tool_comms_reactions_get,
)
from claude_comms.reactions import (
    MAX_EMOJI_LEN,
    Reaction,
    ReactionEvent,
    ReactionsStore,
    SNAPSHOT_LINE_THRESHOLD,
    reactions_topic,
)


# ---------------------------------------------------------------------------
# Storage layer
# ---------------------------------------------------------------------------


class TestReactionsStoreBasics:
    def test_topic_format(self) -> None:
        assert reactions_topic("general") == "claude-comms/conv/general/reactions"

    def test_apply_add_returns_event(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        event = store.apply(
            message_id="m1", emoji="heart", actor_key="deadbeef", op="add"
        )
        assert event is not None
        assert event.op == "add"
        assert event.emoji == "heart"
        assert event.message_id == "m1"
        assert event.actor_key == "deadbeef"
        assert store.get("m1") == {"heart": ["deadbeef"]}

    def test_redundant_add_is_noop(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        store.apply(message_id="m1", emoji="heart", actor_key="deadbeef", op="add")
        again = store.apply(
            message_id="m1", emoji="heart", actor_key="deadbeef", op="add"
        )
        assert again is None

    def test_remove_when_absent_is_noop(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        result = store.apply(
            message_id="m1", emoji="heart", actor_key="deadbeef", op="remove"
        )
        assert result is None

    def test_toggle_resolves_to_terminal_op(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        e1 = store.apply(
            message_id="m1", emoji="heart", actor_key="deadbeef", op="toggle"
        )
        assert e1 is not None and e1.op == "add"
        e2 = store.apply(
            message_id="m1", emoji="heart", actor_key="deadbeef", op="toggle"
        )
        assert e2 is not None and e2.op == "remove"

    def test_emoji_validation(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        with pytest.raises(ValueError):
            store.apply(message_id="m1", emoji="", actor_key="deadbeef", op="add")
        with pytest.raises(ValueError):
            store.apply(
                message_id="m1",
                emoji="x" * (MAX_EMOJI_LEN + 1),
                actor_key="deadbeef",
                op="add",
            )

    def test_actor_key_validation(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        with pytest.raises(ValueError):
            store.apply(message_id="m1", emoji="heart", actor_key="bad", op="add")
        with pytest.raises(ValueError):
            store.apply(
                message_id="m1", emoji="heart", actor_key="DEADBEEF", op="add"
            )  # uppercase

    def test_invalid_op_raises(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        with pytest.raises(ValueError):
            store.apply(
                message_id="m1", emoji="heart", actor_key="deadbeef", op="wat"
            )  # type: ignore[arg-type]


class TestReactionsStorePersistence:
    def test_replay_from_jsonl(self, tmp_path: Path) -> None:
        store1 = ReactionsStore(tmp_path)
        store1.apply(message_id="m1", emoji="heart", actor_key="deadbeef", op="add")
        store1.apply(message_id="m1", emoji="heart", actor_key="cafef00d", op="add")
        store1.apply(message_id="m1", emoji="thumbs", actor_key="deadbeef", op="add")
        snap_before = store1.get_all()

        store2 = ReactionsStore(tmp_path)
        assert store2.get_all() == snap_before

    def test_jsonl_records_only_terminal_ops(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path)
        store.apply(message_id="m1", emoji="heart", actor_key="deadbeef", op="toggle")
        store.apply(message_id="m1", emoji="heart", actor_key="deadbeef", op="toggle")
        lines = store.jsonl_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2
        ops = [json.loads(line)["op"] for line in lines]
        assert ops == ["add", "remove"]

    def test_malformed_line_is_skipped(self, tmp_path: Path) -> None:
        # Write a corrupt line, then a valid one.
        store = ReactionsStore(tmp_path)
        store.apply(message_id="m1", emoji="heart", actor_key="deadbeef", op="add")
        with open(store.jsonl_path, "a", encoding="utf-8") as fh:
            fh.write("this is not valid json\n")

        # Re-load — the bad line should be skipped, good state retained.
        store2 = ReactionsStore(tmp_path)
        assert store2.get("m1") == {"heart": ["deadbeef"]}


class TestReactionsStoreSnapshot:
    def test_snapshot_threshold_not_yet_reached(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path, line_threshold=5, msg_threshold=1_000_000)
        store.apply(message_id="m1", emoji="heart", actor_key="deadbeef", op="add")
        wrote = store.maybe_snapshot(conversation_message_count=10)
        assert wrote is False
        assert not store.snapshot_path.exists()

    def test_snapshot_on_line_threshold(self, tmp_path: Path) -> None:
        # Use small threshold so we don't generate 10K events in tests.
        store = ReactionsStore(tmp_path, line_threshold=3, msg_threshold=1_000_000)
        store.apply(message_id="m1", emoji="a", actor_key="11111111", op="add")
        store.apply(message_id="m1", emoji="b", actor_key="11111111", op="add")
        store.apply(message_id="m1", emoji="c", actor_key="11111111", op="add")
        wrote = store.maybe_snapshot(conversation_message_count=0)
        assert wrote is True
        assert store.snapshot_path.exists()
        # Log was truncated.
        assert store.jsonl_path.read_text(encoding="utf-8") == ""

    def test_snapshot_on_message_threshold(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path, line_threshold=1_000_000, msg_threshold=10)
        store.apply(message_id="m1", emoji="a", actor_key="11111111", op="add")
        wrote = store.maybe_snapshot(conversation_message_count=20)
        assert wrote is True

    def test_replay_after_snapshot(self, tmp_path: Path) -> None:
        store = ReactionsStore(tmp_path, line_threshold=2, msg_threshold=1_000_000)
        store.apply(message_id="m1", emoji="heart", actor_key="11111111", op="add")
        store.apply(message_id="m1", emoji="thumbs", actor_key="22222222", op="add")
        store.maybe_snapshot(conversation_message_count=0)

        # Add more events post-snapshot.
        store.apply(message_id="m1", emoji="star", actor_key="33333333", op="add")

        # Reconstruct from snapshot + tail.
        store2 = ReactionsStore(tmp_path, line_threshold=2, msg_threshold=1_000_000)
        assert store2.get("m1") == {
            "heart": ["11111111"],
            "thumbs": ["22222222"],
            "star": ["33333333"],
        }


# ---------------------------------------------------------------------------
# MCP tool functions
# ---------------------------------------------------------------------------


@pytest.fixture
def registry_and_alice() -> tuple[ParticipantRegistry, str]:
    """Fresh registry with one alice joined to 'general'."""
    # Reset the module-level reaction rate-limiter between tests.
    mcp_tools._reaction_event_log.clear()
    reg = ParticipantRegistry()
    p = reg.join(name="alice", conversation="general")
    return reg, p.key


@pytest.fixture
def store_factory(tmp_path: Path):
    stores: dict[str, ReactionsStore] = {}

    def get_store(conv: str) -> ReactionsStore:
        if conv not in stores:
            stores[conv] = ReactionsStore(tmp_path / conv)
        return stores[conv]

    return get_store


@pytest.fixture
def published_capture():
    published: list[tuple[str, bytes]] = []

    async def publish(topic: str, payload: bytes) -> None:
        published.append((topic, payload))

    return published, publish


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) \
        if asyncio.get_event_loop().is_running() \
        else asyncio.run(coro)


class TestCommsReactValidation:
    def test_unknown_key_errors(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, _ = registry_and_alice
        _, publish = published_capture
        result = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key="00000000",
                conversation="general",
                message_id="m1",
                emoji="heart",
                op="add",
            )
        )
        assert result.get("error") is True

    def test_invalid_op_errors(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        _, publish = published_capture
        result = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key,
                conversation="general",
                message_id="m1",
                emoji="heart",
                op="invalid",
            )
        )
        assert result.get("error") is True

    def test_not_a_member_errors(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        _, publish = published_capture
        result = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key,
                conversation="other-conv",
                message_id="m1",
                emoji="heart",
                op="add",
            )
        )
        assert result.get("error") is True

    def test_empty_emoji_errors(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        _, publish = published_capture
        result = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key,
                conversation="general",
                message_id="m1",
                emoji="   ",
                op="add",
            )
        )
        assert result.get("error") is True


class TestCommsReactSemantics:
    def test_add_publishes(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        published, publish = published_capture
        result = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key,
                conversation="general",
                message_id="m1",
                emoji="heart",
                op="add",
            )
        )
        assert result["status"] == "applied"
        assert result["op"] == "add"
        assert len(published) == 1
        assert published[0][0] == "claude-comms/conv/general/reactions"
        body = json.loads(published[0][1])
        assert body["op"] == "add"
        assert body["emoji"] == "heart"
        assert body["actor_key"] == key

    def test_redundant_add_no_op_no_publish(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        published, publish = published_capture
        for _ in range(2):
            result = asyncio.run(
                tool_comms_react(
                    reg, publish, store_factory,
                    key=key,
                    conversation="general",
                    message_id="m1",
                    emoji="heart",
                    op="add",
                )
            )
        assert result["status"] == "no_op"
        assert len(published) == 1  # only the first add was published

    def test_toggle_round_trip(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        _, publish = published_capture
        r1 = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key, conversation="general", message_id="m1",
                emoji="heart", op="toggle",
            )
        )
        r2 = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key, conversation="general", message_id="m1",
                emoji="heart", op="toggle",
            )
        )
        assert r1["op"] == "add"
        assert r2["op"] == "remove"


class TestCommsReactRateLimits:
    def test_per_message_cap_for_actor(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        _, publish = published_capture
        # Alice adds the maximum unique emojis.
        for i in range(MAX_REACTIONS_PER_MESSAGE_PER_ACTOR):
            result = asyncio.run(
                tool_comms_react(
                    reg, publish, store_factory,
                    key=key, conversation="general", message_id="m1",
                    emoji=f"emoji-{i}", op="add",
                )
            )
            assert result["status"] == "applied"
        # The N+1th add must error.
        result = asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key, conversation="general", message_id="m1",
                emoji="overflow", op="add",
            )
        )
        assert result.get("error") is True
        assert "limit reached" in result["message"].lower()

    def test_per_minute_throttle(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        _, publish = published_capture
        # Each add hits the per-minute counter once. Stay under per-message cap
        # by varying message_id, so the 60s window throttle is the only gate.
        results = []
        for i in range(REACTIONS_PER_ACTOR_PER_MINUTE + 5):
            r = asyncio.run(
                tool_comms_react(
                    reg, publish, store_factory,
                    key=key, conversation="general",
                    message_id=f"m-{i}", emoji="heart", op="add",
                )
            )
            results.append(r)
        # Last 5 must be throttled.
        throttled = [r for r in results if r.get("status") == "throttled"]
        assert len(throttled) == 5


class TestCommsReactionsGet:
    def test_empty_when_no_reactions(
        self, store_factory, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        result = tool_comms_reactions_get(
            reg, store_factory,
            key=key, conversation="general", message_id="m1",
        )
        assert result["reactions"] == {}

    def test_returns_current_state(
        self, store_factory, published_capture, registry_and_alice
    ) -> None:
        reg, key = registry_and_alice
        _, publish = published_capture
        asyncio.run(
            tool_comms_react(
                reg, publish, store_factory,
                key=key, conversation="general", message_id="m1",
                emoji="heart", op="add",
            )
        )
        result = tool_comms_reactions_get(
            reg, store_factory,
            key=key, conversation="general", message_id="m1",
        )
        assert result["reactions"] == {"heart": [key]}
        assert result["message_id"] == "m1"
        assert result["conversation"] == "general"
