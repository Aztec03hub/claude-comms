"""Tests for claude_comms.broker module."""

from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from claude_comms.broker import (
    DEFAULT_HOST,
    DEFAULT_MAX_REPLAY,
    DEFAULT_PORT,
    DEFAULT_WS_HOST,
    DEFAULT_WS_PORT,
    EmbeddedBroker,
    MessageDeduplicator,
    MessageStore,
    _build_broker_config,
    generate_client_id,
    replay_jsonl_logs,
)


# =========================================================================
# MessageDeduplicator
# =========================================================================


class TestMessageDeduplicator:
    """Tests for the bounded seen-ID set."""

    def test_new_id_returns_false(self):
        dedup = MessageDeduplicator()
        assert dedup.is_duplicate("msg-1") is False

    def test_duplicate_id_returns_true(self):
        dedup = MessageDeduplicator()
        dedup.is_duplicate("msg-1")
        assert dedup.is_duplicate("msg-1") is True

    def test_size_tracks_unique_ids(self):
        dedup = MessageDeduplicator()
        dedup.is_duplicate("a")
        dedup.is_duplicate("b")
        dedup.is_duplicate("a")  # duplicate
        assert dedup.size == 2

    def test_eviction_when_full(self):
        dedup = MessageDeduplicator(max_size=3)
        dedup.is_duplicate("a")
        dedup.is_duplicate("b")
        dedup.is_duplicate("c")
        # Now full — adding "d" should evict "a" (oldest)
        dedup.is_duplicate("d")
        assert dedup.size == 3
        # "a" was the oldest, should be evicted
        assert dedup.is_duplicate("a") is False  # re-added as new
        # "b" was evicted when "a" was re-added (it became the oldest)
        # "c" and "d" should still be there
        assert dedup.is_duplicate("c") is True
        assert dedup.is_duplicate("d") is True

    def test_lru_eviction_moves_accessed_to_end(self):
        dedup = MessageDeduplicator(max_size=3)
        dedup.is_duplicate("a")
        dedup.is_duplicate("b")
        dedup.is_duplicate("c")
        # Access "a" — moves it to end, "b" becomes oldest
        dedup.is_duplicate("a")
        # Add "d" — should evict "b" (now oldest)
        dedup.is_duplicate("d")
        assert dedup.is_duplicate("b") is False  # evicted, re-added
        assert dedup.is_duplicate("a") is True  # still present

    def test_clear_empties_set(self):
        dedup = MessageDeduplicator()
        dedup.is_duplicate("x")
        dedup.clear()
        assert dedup.size == 0
        assert dedup.is_duplicate("x") is False  # treated as new

    def test_invalid_max_size_raises(self):
        with pytest.raises(ValueError, match="max_size must be >= 1"):
            MessageDeduplicator(max_size=0)

    def test_max_size_one(self):
        dedup = MessageDeduplicator(max_size=1)
        dedup.is_duplicate("a")
        assert dedup.size == 1
        dedup.is_duplicate("b")
        assert dedup.size == 1
        # "a" evicted
        assert dedup.is_duplicate("a") is False


# =========================================================================
# MessageStore
# =========================================================================


class TestMessageStore:
    """Tests for the in-memory per-conversation message store."""

    def test_add_and_get(self):
        store = MessageStore()
        msg = {"id": "1", "conv": "general", "body": "hello"}
        store.add("general", msg)
        result = store.get("general")
        assert len(result) == 1
        assert result[0]["body"] == "hello"

    def test_get_nonexistent_conv(self):
        store = MessageStore()
        assert store.get("nope") == []

    def test_capped_at_max(self):
        store = MessageStore(max_per_conv=3)
        for i in range(5):
            store.add("c", {"id": str(i), "body": f"msg-{i}"})
        result = store.get("c")
        assert len(result) == 3
        # Should have kept the last 3
        assert [m["body"] for m in result] == ["msg-2", "msg-3", "msg-4"]

    def test_get_with_limit(self):
        store = MessageStore()
        for i in range(10):
            store.add("c", {"id": str(i)})
        result = store.get("c", limit=3)
        assert len(result) == 3
        assert result[-1]["id"] == "9"

    def test_conversations(self):
        store = MessageStore()
        store.add("alpha", {"id": "1"})
        store.add("beta", {"id": "2"})
        convs = store.conversations()
        assert set(convs) == {"alpha", "beta"}

    def test_clear(self):
        store = MessageStore()
        store.add("c", {"id": "1"})
        store.clear()
        assert store.get("c") == []
        assert store.conversations() == []


# =========================================================================
# JSONL Replay
# =========================================================================


class TestReplayJsonlLogs:
    """Tests for JSONL log replay on startup."""

    def _write_jsonl(self, path: Path, messages: list[dict]) -> None:
        """Helper: write a list of message dicts to a .jsonl file."""
        with open(path, "w", encoding="utf-8") as fh:
            for msg in messages:
                fh.write(json.dumps(msg) + "\n")

    def test_replay_populates_store(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        self._write_jsonl(
            log_dir / "general.jsonl",
            [
                {"id": "m1", "conv": "general", "body": "hello"},
                {"id": "m2", "conv": "general", "body": "world"},
            ],
        )
        store = replay_jsonl_logs(log_dir)
        msgs = store.get("general")
        assert len(msgs) == 2
        assert msgs[0]["body"] == "hello"

    def test_replay_caps_per_conversation(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        messages = [
            {"id": f"m{i}", "conv": "general", "body": f"msg-{i}"}
            for i in range(20)
        ]
        self._write_jsonl(log_dir / "general.jsonl", messages)
        store = replay_jsonl_logs(log_dir, max_per_conv=5)
        msgs = store.get("general")
        assert len(msgs) == 5
        assert msgs[0]["body"] == "msg-15"

    def test_replay_registers_ids_in_deduplicator(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        self._write_jsonl(
            log_dir / "c.jsonl",
            [{"id": "abc-123", "conv": "c", "body": "x"}],
        )
        dedup = MessageDeduplicator()
        replay_jsonl_logs(log_dir, deduplicator=dedup)
        # The ID should now be in the deduplicator
        assert dedup.is_duplicate("abc-123") is True

    def test_replay_skips_malformed_lines(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        path = log_dir / "conv.jsonl"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write('{"id": "ok", "conv": "c", "body": "good"}\n')
            fh.write("NOT VALID JSON\n")
            fh.write('{"id": "ok2", "conv": "c", "body": "also good"}\n')
        store = replay_jsonl_logs(log_dir)
        assert len(store.get("c")) == 2

    def test_replay_skips_messages_without_id_or_conv(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        self._write_jsonl(
            log_dir / "x.jsonl",
            [
                {"id": "m1", "body": "no conv field"},
                {"conv": "c", "body": "no id field"},
                {"id": "m3", "conv": "c", "body": "valid"},
            ],
        )
        store = replay_jsonl_logs(log_dir)
        assert len(store.get("c")) == 1

    def test_replay_nonexistent_directory(self, tmp_path: Path):
        store = replay_jsonl_logs(tmp_path / "does-not-exist")
        assert store.conversations() == []

    def test_replay_empty_directory(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        store = replay_jsonl_logs(log_dir)
        assert store.conversations() == []

    def test_replay_populates_existing_store(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        self._write_jsonl(
            log_dir / "c.jsonl",
            [{"id": "m1", "conv": "c", "body": "from log"}],
        )
        store = MessageStore()
        store.add("c", {"id": "existing", "conv": "c", "body": "pre-existing"})
        replay_jsonl_logs(log_dir, store=store)
        msgs = store.get("c")
        assert len(msgs) == 2
        assert msgs[0]["body"] == "pre-existing"

    def test_replay_multiple_files(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        self._write_jsonl(
            log_dir / "alpha.jsonl",
            [{"id": "a1", "conv": "alpha", "body": "hi"}],
        )
        self._write_jsonl(
            log_dir / "beta.jsonl",
            [{"id": "b1", "conv": "beta", "body": "yo"}],
        )
        store = replay_jsonl_logs(log_dir)
        assert set(store.conversations()) == {"alpha", "beta"}

    def test_replay_blank_lines_ignored(self, tmp_path: Path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        path = log_dir / "c.jsonl"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n")
            fh.write('{"id":"m1","conv":"c","body":"ok"}\n')
            fh.write("   \n")
        store = replay_jsonl_logs(log_dir)
        assert len(store.get("c")) == 1


# =========================================================================
# Broker config builder
# =========================================================================


class TestBuildBrokerConfig:
    """Tests for _build_broker_config."""

    def test_default_config(self):
        cfg = _build_broker_config()
        assert cfg["listeners"]["default"]["bind"] == "127.0.0.1:1883"
        assert cfg["listeners"]["ws-mqtt"]["bind"] == "127.0.0.1:9001"
        assert cfg["listeners"]["default"]["type"] == "tcp"
        assert cfg["listeners"]["ws-mqtt"]["type"] == "ws"
        plugins = cfg["plugins"]
        anon_key = "amqtt.plugins.authentication.AnonymousAuthPlugin"
        assert plugins[anon_key]["allow_anonymous"] is True

    def test_custom_bind(self):
        cfg = _build_broker_config(
            host="0.0.0.0", port=8883, ws_host="0.0.0.0", ws_port=8001
        )
        assert cfg["listeners"]["default"]["bind"] == "0.0.0.0:8883"
        assert cfg["listeners"]["ws-mqtt"]["bind"] == "0.0.0.0:8001"

    def test_auth_enabled(self):
        cfg = _build_broker_config(
            auth_enabled=True, auth_username="user", auth_password="pass"
        )
        anon_key = "amqtt.plugins.authentication.AnonymousAuthPlugin"
        assert cfg["plugins"][anon_key]["allow_anonymous"] is False

    def test_auth_enabled_but_no_creds_stays_anonymous(self):
        cfg = _build_broker_config(auth_enabled=True)
        anon_key = "amqtt.plugins.authentication.AnonymousAuthPlugin"
        assert cfg["plugins"][anon_key]["allow_anonymous"] is True


# =========================================================================
# EmbeddedBroker
# =========================================================================


class TestEmbeddedBroker:
    """Tests for the broker lifecycle wrapper."""

    def test_from_config_defaults(self):
        broker = EmbeddedBroker.from_config({})
        assert broker.host == DEFAULT_HOST
        assert broker.port == DEFAULT_PORT
        assert broker.ws_host == DEFAULT_WS_HOST
        assert broker.ws_port == DEFAULT_WS_PORT
        assert broker.auth_enabled is False

    def test_from_config_custom(self):
        cfg = {
            "broker": {
                "host": "0.0.0.0",
                "port": 8883,
                "ws_host": "0.0.0.0",
                "ws_port": 8001,
                "auth": {
                    "enabled": True,
                    "username": "user",
                    "password": "secret",
                },
            },
            "logging": {
                "dir": "/tmp/test-logs",
                "max_messages_replay": 500,
            },
        }
        broker = EmbeddedBroker.from_config(cfg)
        assert broker.host == "0.0.0.0"
        assert broker.port == 8883
        assert broker.ws_host == "0.0.0.0"
        assert broker.ws_port == 8001
        assert broker.auth_enabled is True
        assert broker.auth_username == "user"
        assert broker.max_replay == 500

    def test_is_running_initially_false(self):
        broker = EmbeddedBroker()
        assert broker.is_running is False

    def test_deduplicator_and_store_created(self):
        broker = EmbeddedBroker()
        assert isinstance(broker.deduplicator, MessageDeduplicator)
        assert isinstance(broker.message_store, MessageStore)

    @pytest.mark.asyncio
    async def test_start_creates_pid_file(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        log_dir = tmp_path / "logs"

        mock_broker_instance = AsyncMock()
        mock_broker_cls = MagicMock(return_value=mock_broker_instance)

        broker = EmbeddedBroker(pid_file=pid_file, log_dir=log_dir)

        with patch("claude_comms.broker.Broker", mock_broker_cls, create=True):
            # Patch the import inside start()
            with patch.dict(
                "sys.modules",
                {"amqtt": MagicMock(), "amqtt.broker": MagicMock(Broker=mock_broker_cls)},
            ):
                await broker.start()

        assert broker.is_running is True
        assert pid_file.exists()
        pid_text = pid_file.read_text().strip()
        assert pid_text == str(os.getpid())

    @pytest.mark.asyncio
    async def test_stop_removes_pid_file(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        log_dir = tmp_path / "logs"

        mock_broker_instance = AsyncMock()
        mock_broker_cls = MagicMock(return_value=mock_broker_instance)

        broker = EmbeddedBroker(pid_file=pid_file, log_dir=log_dir)

        with patch.dict(
            "sys.modules",
            {"amqtt": MagicMock(), "amqtt.broker": MagicMock(Broker=mock_broker_cls)},
        ):
            await broker.start()
            await broker.stop()

        assert broker.is_running is False
        assert not pid_file.exists()

    @pytest.mark.asyncio
    async def test_start_twice_raises(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        log_dir = tmp_path / "logs"

        mock_broker_instance = AsyncMock()
        mock_broker_cls = MagicMock(return_value=mock_broker_instance)

        broker = EmbeddedBroker(pid_file=pid_file, log_dir=log_dir)

        with patch.dict(
            "sys.modules",
            {"amqtt": MagicMock(), "amqtt.broker": MagicMock(Broker=mock_broker_cls)},
        ):
            await broker.start()
            with pytest.raises(RuntimeError, match="already running"):
                await broker.start()
            await broker.stop()

    @pytest.mark.asyncio
    async def test_stop_when_not_running_is_safe(self):
        broker = EmbeddedBroker()
        await broker.stop()  # Should not raise

    @pytest.mark.asyncio
    async def test_start_replays_jsonl(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        log_dir = tmp_path / "logs"
        log_dir.mkdir()

        # Write a JSONL log file
        jsonl_path = log_dir / "general.jsonl"
        with open(jsonl_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"id": "r1", "conv": "general", "body": "replayed"}) + "\n")

        mock_broker_instance = AsyncMock()
        mock_broker_cls = MagicMock(return_value=mock_broker_instance)

        broker = EmbeddedBroker(pid_file=pid_file, log_dir=log_dir)

        with patch.dict(
            "sys.modules",
            {"amqtt": MagicMock(), "amqtt.broker": MagicMock(Broker=mock_broker_cls)},
        ):
            await broker.start()

        # Message should be in the store
        msgs = broker.message_store.get("general")
        assert len(msgs) == 1
        assert msgs[0]["body"] == "replayed"

        # ID should be in the deduplicator
        assert broker.deduplicator.is_duplicate("r1") is True

        await broker.stop()


class TestPidFileHelpers:
    """Tests for static PID file utilities."""

    def test_read_pid_nonexistent(self, tmp_path: Path):
        assert EmbeddedBroker.read_pid(tmp_path / "nope.pid") is None

    def test_read_pid_valid(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        pid_file.write_text("12345")
        assert EmbeddedBroker.read_pid(pid_file) == 12345

    def test_read_pid_empty(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        pid_file.write_text("")
        assert EmbeddedBroker.read_pid(pid_file) is None

    def test_read_pid_non_numeric(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        pid_file.write_text("not-a-number")
        assert EmbeddedBroker.read_pid(pid_file) is None

    def test_is_daemon_running_no_pid_file(self, tmp_path: Path):
        assert EmbeddedBroker.is_daemon_running(tmp_path / "nope.pid") is False

    def test_is_daemon_running_stale_pid(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        pid_file.write_text("999999999")  # Almost certainly not a real PID
        assert EmbeddedBroker.is_daemon_running(pid_file) is False

    def test_is_daemon_running_current_pid(self, tmp_path: Path):
        pid_file = tmp_path / "daemon.pid"
        pid_file.write_text(str(os.getpid()))
        assert EmbeddedBroker.is_daemon_running(pid_file) is True


# =========================================================================
# Client ID generation
# =========================================================================


class TestGenerateClientId:
    """Tests for MQTT client ID generation."""

    def test_format(self):
        cid = generate_client_id("mcp", "a3f7b2c1")
        assert cid.startswith("claude-comms-mcp-a3f7b2c1-")
        # Random suffix is 8 hex chars
        suffix = cid.split("-")[-1]
        assert len(suffix) == 8
        int(suffix, 16)  # should not raise

    def test_uniqueness(self):
        ids = {generate_client_id("tui", "deadbeef") for _ in range(100)}
        assert len(ids) == 100


# Need os import for getpid in tests
import os
