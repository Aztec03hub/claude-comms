"""Tests for REST API backing functions and overnight feature additions.

Covers:
1. Message history REST API — get_channel_messages()
2. Identity REST API — GET /api/identity
3. Participants REST API — get_channel_participants()
4. MCP presence publishing on join — comms_join presence payloads
5. Client type display in presence — participant "client" field

NOTE (Identity API): The GET /api/identity handler (_api_identity) is defined
as a closure inside cli._run() capturing the ``config`` dict from the daemon
startup context. There is no standalone build_identity_route(config) helper
(unlike build_capabilities_route), making it genuinely infeasible to mount the
handler in a Starlette TestClient without modifying cli.py. The four tautological
tests that previously existed here were asserting dict.get() on literals they
constructed themselves — they exercised no production code.
TODO: extract a build_identity_route(config) from cli._run() (same pattern as
build_capabilities_route) and replace this comment with a TestClient integration
test that hits GET /api/identity and verifies key/name/type in the JSON response.
Real identity contract is covered by the e2e daemon fixture and scenario tests.
"""

from __future__ import annotations

import json

import pytest

from claude_comms.broker import MessageDeduplicator, MessageStore
from claude_comms.mcp_tools import ParticipantRegistry, tool_comms_join


# =========================================================================
# 1. Message history REST API — get_channel_messages()
# =========================================================================


class TestGetChannelMessages:
    """Tests for mcp_server.get_channel_messages()."""

    def test_returns_empty_when_store_is_none(self):
        """When the store hasn't been initialised, return []."""
        import claude_comms.mcp_server as mod

        original = mod._store
        try:
            mod._store = None
            from claude_comms.mcp_server import get_channel_messages

            result = get_channel_messages("general", 50)
            assert result == []
        finally:
            mod._store = original

    def test_returns_messages_from_store(self):
        """When store has messages, return them."""
        import claude_comms.mcp_server as mod

        store = MessageStore()
        msg1 = {
            "id": "aaa",
            "conv": "general",
            "body": "hello",
            "ts": "2026-01-01T00:00:00Z",
        }
        msg2 = {
            "id": "bbb",
            "conv": "general",
            "body": "world",
            "ts": "2026-01-01T00:01:00Z",
        }
        store.add("general", msg1)
        store.add("general", msg2)

        original = mod._store
        try:
            mod._store = store
            from claude_comms.mcp_server import get_channel_messages

            result = get_channel_messages("general", 50)
            assert len(result) == 2
            assert result[0]["body"] == "hello"
            assert result[1]["body"] == "world"
        finally:
            mod._store = original

    def test_respects_count_limit(self):
        """Count parameter caps the number of returned messages."""
        import claude_comms.mcp_server as mod

        store = MessageStore()
        for i in range(10):
            store.add(
                "general", {"id": f"msg-{i}", "conv": "general", "body": f"msg {i}"}
            )

        original = mod._store
        try:
            mod._store = store
            from claude_comms.mcp_server import get_channel_messages

            result = get_channel_messages("general", 3)
            assert len(result) == 3
            # Should return the most recent 3
            assert result[-1]["body"] == "msg 9"
        finally:
            mod._store = original

    def test_returns_empty_for_unknown_channel(self):
        """Querying a channel with no messages returns []."""
        import claude_comms.mcp_server as mod

        store = MessageStore()
        store.add("general", {"id": "aaa", "conv": "general", "body": "hello"})

        original = mod._store
        try:
            mod._store = store
            from claude_comms.mcp_server import get_channel_messages

            result = get_channel_messages("nonexistent", 50)
            assert result == []
        finally:
            mod._store = original


# =========================================================================
# 2. Identity REST API — see module docstring for why tests were deleted
# =========================================================================

# =========================================================================
# 3. Participants REST API — get_channel_participants()
# =========================================================================


class TestGetChannelParticipants:
    """Tests for mcp_server.get_channel_participants()."""

    def test_returns_empty_when_registry_is_none(self):
        """When the registry hasn't been initialised, return []."""
        import claude_comms.mcp_server as mod

        original = mod._registry
        try:
            mod._registry = None
            from claude_comms.mcp_server import get_channel_participants

            result = get_channel_participants("general")
            assert result == []
        finally:
            mod._registry = original

    @pytest.mark.asyncio
    async def test_returns_participants_with_client_field(self):
        """Participants should include 'client' field (canonical test; absorbs
        the isinstance(str) check from the deleted test_client_field_is_string)."""
        import claude_comms.mcp_server as mod

        registry = ParticipantRegistry()
        await tool_comms_join(registry, name="alice", conversation="general")

        original = mod._registry
        try:
            mod._registry = registry
            from claude_comms.mcp_server import get_channel_participants

            result = get_channel_participants("general")
            assert len(result) == 1
            p = result[0]
            assert p["name"] == "alice"
            # Claude-typed join synthesizes an `mcp` ConnectionInfo via
            # _ensure_mcp_connection so the participant has client=mcp and
            # status=online even before any explicit MQTT presence.
            assert p["client"] == "mcp"
            assert isinstance(p["client"], str) and len(p["client"]) > 0
            assert p["status"] == "online"
            assert "connections" in p
            assert "online" in p
            assert "key" in p
            assert "type" in p
        finally:
            mod._registry = original

    @pytest.mark.asyncio
    async def test_returns_multiple_participants(self):
        """Multiple participants in the same channel are all returned."""
        import claude_comms.mcp_server as mod

        registry = ParticipantRegistry()
        await tool_comms_join(registry, name="alice", conversation="general")
        await tool_comms_join(registry, name="bob", conversation="general")

        original = mod._registry
        try:
            mod._registry = registry
            from claude_comms.mcp_server import get_channel_participants

            result = get_channel_participants("general")
            assert len(result) == 2
            names = {p["name"] for p in result}
            assert names == {"alice", "bob"}
        finally:
            mod._registry = original

    @pytest.mark.asyncio
    async def test_returns_empty_for_empty_channel(self):
        """Channel with no participants returns []."""
        import claude_comms.mcp_server as mod

        registry = ParticipantRegistry()
        await tool_comms_join(registry, name="alice", conversation="general")

        original = mod._registry
        try:
            mod._registry = registry
            from claude_comms.mcp_server import get_channel_participants

            result = get_channel_participants("other-channel")
            assert result == []
        finally:
            mod._registry = original


# TestBrokerRetryLoop (3 tests) — DELETED (P2 #2).
# The class reimplemented the retry loop inline in each test; the real
# cli._run_broker_with_retry function was never imported or invoked. Deleting
# so we don't maintain a test that validates Python while-loop semantics.
# TODO: add one test that imports _run_broker_with_retry from cli and drives
# it directly, or gate it as integration-only behind a real MQTT broker stub.

# =========================================================================
# 4. MCP presence publishing on join
# =========================================================================


class TestPresencePublishingOnJoin:
    """Tests for the presence publish that happens inside comms_join().

    The mcp_server.comms_join wrapper publishes presence to MQTT when a
    participant joins. We test the logic by examining the payload format.
    """

    @pytest.mark.asyncio
    async def test_presence_payload_format(self):
        """Presence payload contains expected fields."""
        registry = ParticipantRegistry()
        result = await tool_comms_join(registry, name="agent-x", conversation="general")

        assert "error" not in result
        assert result["status"] == "joined"

        # Simulate what comms_join does for presence
        presence_payload = json.dumps(
            {
                "key": result["key"],
                "name": result["name"],
                "type": result["type"],
                "status": "online",
                "client": "mcp",
                "ts": "2026-01-01T00:00:00Z",  # placeholder for test
            }
        )
        data = json.loads(presence_payload)

        assert data["key"] == result["key"]
        assert data["name"] == "agent-x"
        assert data["status"] == "online"
        assert data["client"] == "mcp"
        assert "ts" in data

    # test_presence_topics — DELETED (P2 #3).
    # Built two f-strings then asserted each one equaled itself; no production
    # presence-publish code was called.

    # test_presence_publish_called_on_join — DELETED (P2 #3).
    # Manually called mock_publish() inside the test body then asserted
    # publish_calls length. Counted the test's own direct calls to the spy,
    # not any calls made by production code. Validated PublishSpy, not the
    # MCP presence-publish path.


# =========================================================================
# 5. Client type display in presence (canonical test kept here; duplicates
#    that were in TestClientTypeInPresence deleted per P3.c)
# =========================================================================

# Canonical client-field test lives in TestGetChannelParticipants above
# (test_returns_participants_with_client_field). The two duplicates that
# were in TestClientTypeInPresence have been removed:
#   - test_participant_response_includes_client_mcp (P3.c — identical to
#     TestGetChannelParticipants.test_returns_participants_with_client_field)
#   - test_client_field_is_string (P3.c — isinstance(str) check folded into
#     the canonical test above)
#   - test_presence_payload_client_field (P2 #4 — serialized a literal dict
#     and deserialized it; no production code ran)
#   - test_system_topic_includes_client_suffix (P2 #4 — asserted an f-string
#     containing "-mcp" ends with "-mcp")


# =========================================================================
# Integration: MessageStore + get_channel_messages pipeline
# =========================================================================


class TestMessageStoreIntegration:
    """Integration tests combining MessageStore with API functions."""

    def test_add_then_retrieve_via_api(self):
        """Messages added to store are retrievable via get_channel_messages."""
        import claude_comms.mcp_server as mod

        store = MessageStore()
        dedup = MessageDeduplicator()

        # Simulate MQTT subscriber adding messages
        msg = {
            "id": "integration-001",
            "conv": "test-channel",
            "body": "integration test message",
            "ts": "2026-03-30T10:00:00Z",
            "sender": {"key": "aabbccdd", "name": "tester", "type": "human"},
        }
        if not dedup.is_duplicate(msg["id"]):
            store.add(msg["conv"], msg)

        original = mod._store
        try:
            mod._store = store
            from claude_comms.mcp_server import get_channel_messages

            result = get_channel_messages("test-channel", 50)
            assert len(result) == 1
            assert result[0]["id"] == "integration-001"
            assert result[0]["body"] == "integration test message"
        finally:
            mod._store = original

    def test_dedup_prevents_duplicates_in_api(self):
        """Duplicate messages are not added to the store."""
        import claude_comms.mcp_server as mod

        store = MessageStore()
        dedup = MessageDeduplicator()

        msg = {
            "id": "dedup-001",
            "conv": "general",
            "body": "only once",
            "ts": "2026-03-30T10:00:00Z",
        }

        # Add twice via dedup check
        for _ in range(3):
            if not dedup.is_duplicate(msg["id"]):
                store.add(msg["conv"], msg)

        original = mod._store
        try:
            mod._store = store
            from claude_comms.mcp_server import get_channel_messages

            result = get_channel_messages("general", 50)
            assert len(result) == 1
        finally:
            mod._store = original

    def test_multiple_channels_isolated(self):
        """Messages in different channels don't leak across."""
        import claude_comms.mcp_server as mod

        store = MessageStore()
        store.add("alpha", {"id": "a1", "conv": "alpha", "body": "in alpha"})
        store.add("beta", {"id": "b1", "conv": "beta", "body": "in beta"})

        original = mod._store
        try:
            mod._store = store
            from claude_comms.mcp_server import get_channel_messages

            alpha_msgs = get_channel_messages("alpha", 50)
            beta_msgs = get_channel_messages("beta", 50)

            assert len(alpha_msgs) == 1
            assert alpha_msgs[0]["body"] == "in alpha"
            assert len(beta_msgs) == 1
            assert beta_msgs[0]["body"] == "in beta"
        finally:
            mod._store = original
