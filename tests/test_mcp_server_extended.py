"""Extended tests for mcp_server.py — targeting testable functions without a running server.

Covers:
- get_channel_messages() edge cases
- get_channel_participants() with various registry states
- create_server() returns a valid FastMCP instance
- Module-level getter guards (_get_registry, _get_store)
- Tool wrapper registration on the FastMCP instance
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from claude_comms.broker import MessageStore
from claude_comms.mcp_tools import ParticipantRegistry, tool_comms_join


# ---------------------------------------------------------------------------
# get_channel_messages() tests
# ---------------------------------------------------------------------------


class TestGetChannelMessages:
    """Tests for mcp_server.get_channel_messages()."""

    def test_returns_empty_when_store_is_none(self):
        """Should return [] when the module-level _store is None (daemon not started)."""
        import claude_comms.mcp_server as srv

        original = srv._store
        try:
            srv._store = None
            assert srv.get_channel_messages("general") == []
        finally:
            srv._store = original

    def test_returns_messages_from_store(self, store: MessageStore):
        """Should proxy through to store.get() when store is initialised."""
        import claude_comms.mcp_server as srv

        store.add("general", {"id": "m1", "body": "hello"})
        store.add("general", {"id": "m2", "body": "world"})
        original = srv._store
        try:
            srv._store = store
            result = srv.get_channel_messages("general")
            assert len(result) == 2
            assert result[0]["body"] == "hello"
            assert result[1]["body"] == "world"
        finally:
            srv._store = original

    def test_respects_count_parameter(self, store: MessageStore):
        """Should limit the number of returned messages via count."""
        import claude_comms.mcp_server as srv

        for i in range(10):
            store.add("dev", {"id": f"m{i}", "body": f"msg-{i}"})
        original = srv._store
        try:
            srv._store = store
            result = srv.get_channel_messages("dev", count=3)
            assert len(result) == 3
            # Should be the 3 most recent
            assert result[0]["body"] == "msg-7"
        finally:
            srv._store = original

    def test_default_count_is_50(self, store: MessageStore):
        """Default count parameter is 50."""
        import claude_comms.mcp_server as srv

        for i in range(60):
            store.add("bulk", {"id": f"m{i}", "body": f"msg-{i}"})
        original = srv._store
        try:
            srv._store = store
            result = srv.get_channel_messages("bulk")
            assert len(result) == 50
        finally:
            srv._store = original

    def test_nonexistent_channel_returns_empty(self, store: MessageStore):
        """Querying a channel with no messages should return []."""
        import claude_comms.mcp_server as srv

        original = srv._store
        try:
            srv._store = store
            assert srv.get_channel_messages("nonexistent") == []
        finally:
            srv._store = original


# ---------------------------------------------------------------------------
# get_channel_participants() tests
# ---------------------------------------------------------------------------


class TestGetChannelParticipants:
    """Tests for mcp_server.get_channel_participants()."""

    def test_returns_empty_when_registry_is_none(self):
        """Should return [] when the module-level _registry is None."""
        import claude_comms.mcp_server as srv

        original = srv._registry
        try:
            srv._registry = None
            assert srv.get_channel_participants("general") == []
        finally:
            srv._registry = original

    def test_returns_participants_with_correct_shape(
        self, registry: ParticipantRegistry
    ):
        """Each participant dict should have key, name, type, client, status."""
        import claude_comms.mcp_server as srv

        tool_comms_join(registry, name="alice", conversation="general")
        original = srv._registry
        try:
            srv._registry = registry
            result = srv.get_channel_participants("general")
            assert len(result) == 1
            p = result[0]
            assert set(p.keys()) == {"key", "name", "type", "client", "status"}
            assert p["name"] == "alice"
            assert p["client"] == "mcp"
            assert p["status"] == "online"
            assert p["type"] == "claude"
        finally:
            srv._registry = original

    def test_multiple_participants(self, registry: ParticipantRegistry):
        """Should return all participants in the given channel."""
        import claude_comms.mcp_server as srv

        tool_comms_join(registry, name="alice", conversation="general")
        tool_comms_join(registry, name="bob", conversation="general")
        tool_comms_join(registry, name="charlie", conversation="other")
        original = srv._registry
        try:
            srv._registry = registry
            result = srv.get_channel_participants("general")
            names = {p["name"] for p in result}
            assert names == {"alice", "bob"}
        finally:
            srv._registry = original

    def test_empty_channel(self, registry: ParticipantRegistry):
        """A channel with no members returns an empty list."""
        import claude_comms.mcp_server as srv

        original = srv._registry
        try:
            srv._registry = registry
            result = srv.get_channel_participants("empty-channel")
            assert result == []
        finally:
            srv._registry = original

    def test_participant_leaves_channel(self, registry: ParticipantRegistry):
        """After a participant leaves, they should not appear in the list."""
        import claude_comms.mcp_server as srv

        join_result = tool_comms_join(registry, name="alice", conversation="general")
        key = join_result["key"]
        registry.leave(key, "general")

        original = srv._registry
        try:
            srv._registry = registry
            result = srv.get_channel_participants("general")
            assert result == []
        finally:
            srv._registry = original


# ---------------------------------------------------------------------------
# Module-level getter guards
# ---------------------------------------------------------------------------


class TestGetterGuards:
    """Tests for _get_registry() and _get_store() RuntimeError guards."""

    def test_get_registry_raises_when_none(self):
        """_get_registry() should raise RuntimeError when uninitialised."""
        import claude_comms.mcp_server as srv

        original = srv._registry
        try:
            srv._registry = None
            with pytest.raises(RuntimeError, match="not initialised"):
                srv._get_registry()
        finally:
            srv._registry = original

    def test_get_store_raises_when_none(self):
        """_get_store() should raise RuntimeError when uninitialised."""
        import claude_comms.mcp_server as srv

        original = srv._store
        try:
            srv._store = None
            with pytest.raises(RuntimeError, match="not initialised"):
                srv._get_store()
        finally:
            srv._store = original

    def test_get_registry_returns_registry_when_set(
        self, registry: ParticipantRegistry
    ):
        """_get_registry() returns the registry when it has been initialised."""
        import claude_comms.mcp_server as srv

        original = srv._registry
        try:
            srv._registry = registry
            assert srv._get_registry() is registry
        finally:
            srv._registry = original

    def test_get_store_returns_store_when_set(self, store: MessageStore):
        """_get_store() returns the store when it has been initialised."""
        import claude_comms.mcp_server as srv

        original = srv._store
        try:
            srv._store = store
            assert srv._get_store() is store
        finally:
            srv._store = original


# ---------------------------------------------------------------------------
# create_server() tests
# ---------------------------------------------------------------------------


class TestCreateServer:
    """Tests for create_server() returning a properly configured FastMCP."""

    def test_returns_fastmcp_instance(self, tmp_config: dict[str, Any]):
        """create_server() should return a FastMCP instance."""
        from mcp.server.fastmcp import FastMCP

        import claude_comms.mcp_server as srv

        mcp = srv.create_server(config=tmp_config)
        assert isinstance(mcp, FastMCP)

    def test_initialises_shared_state(self, tmp_config: dict[str, Any]):
        """create_server() should set module-level _registry, _store, _deduplicator."""
        import claude_comms.mcp_server as srv

        srv.create_server(config=tmp_config)
        assert srv._registry is not None
        assert srv._store is not None
        assert srv._deduplicator is not None
        assert srv._publish_fn is not None
        assert srv._config is tmp_config

    def test_registers_all_tools(self, tmp_config: dict[str, Any]):
        """create_server() should register all 9 comms_* tools."""
        import claude_comms.mcp_server as srv

        mcp = srv.create_server(config=tmp_config)
        # FastMCP stores tools in _tool_manager._tools dict
        tool_names = set(mcp._tool_manager._tools.keys())
        expected = {
            "comms_join",
            "comms_leave",
            "comms_send",
            "comms_read",
            "comms_check",
            "comms_members",
            "comms_conversations",
            "comms_update_name",
            "comms_history",
        }
        assert expected.issubset(tool_names), f"Missing tools: {expected - tool_names}"

    def test_noop_publish_raises_connection_error(self, tmp_config: dict[str, Any]):
        """The placeholder _publish_fn should raise ConnectionError."""
        import claude_comms.mcp_server as srv

        srv.create_server(config=tmp_config)
        assert srv._publish_fn is not None
        import asyncio

        with pytest.raises(ConnectionError, match="MQTT broker unavailable"):
            asyncio.run(srv._publish_fn("topic", b"payload"))

    def test_uses_config_values(self, tmp_config: dict[str, Any]):
        """create_server() should use host/port from config."""
        import claude_comms.mcp_server as srv

        tmp_config["mcp"]["port"] = 9999
        mcp = srv.create_server(config=tmp_config)
        # The FastMCP instance stores settings
        assert mcp.settings.port == 9999

    def test_loads_default_config_when_none(self):
        """create_server(config=None) should call load_config()."""
        import claude_comms.mcp_server as srv

        with patch("claude_comms.mcp_server.load_config") as mock_load:
            mock_load.return_value = {
                "mcp": {"host": "127.0.0.1", "port": 9920},
                "logging": {"dir": "/tmp/test-logs"},
            }
            with patch("claude_comms.mcp_server.replay_jsonl_logs"):
                srv.create_server(config=None)
            mock_load.assert_called_once()
