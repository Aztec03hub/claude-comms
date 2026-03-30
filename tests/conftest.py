"""Shared test fixtures for claude-comms tests.

Provides:
- ``registry``: Fresh :class:`ParticipantRegistry` per test
- ``store``: Fresh :class:`MessageStore` per test
- ``deduplicator``: Fresh :class:`MessageDeduplicator` per test
- ``tmp_config``: Temporary config dict with safe defaults
- ``sample_participant``: A pre-registered participant for convenience
- ``publish_spy``: An async publish callable that records calls
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from claude_comms.broker import MessageDeduplicator, MessageStore
from claude_comms.mcp_tools import ParticipantRegistry


# ---------------------------------------------------------------------------
# Core fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def registry() -> ParticipantRegistry:
    """Fresh participant registry."""
    return ParticipantRegistry()


@pytest.fixture
def store() -> MessageStore:
    """Fresh message store."""
    return MessageStore()


@pytest.fixture
def deduplicator() -> MessageDeduplicator:
    """Fresh message deduplicator."""
    return MessageDeduplicator()


@pytest.fixture
def tmp_config(tmp_path: Path) -> dict[str, Any]:
    """Temporary config dict pointing at tmp_path for logs/data.

    Safe defaults: broker on localhost, MCP on localhost:9920, auth disabled.
    """
    return {
        "identity": {
            "key": "aabbccdd",
            "name": "test-user",
            "type": "human",
        },
        "broker": {
            "mode": "host",
            "host": "127.0.0.1",
            "port": 1883,
            "ws_host": "127.0.0.1",
            "ws_port": 9001,
            "auth": {
                "enabled": False,
                "username": "",
                "password": "",
            },
        },
        "mcp": {
            "host": "127.0.0.1",
            "port": 9920,
            "auto_join": ["general"],
        },
        "web": {
            "enabled": False,
            "port": 9921,
        },
        "notifications": {
            "hook_enabled": False,
            "sound_enabled": False,
        },
        "logging": {
            "dir": str(tmp_path / "logs"),
            "format": "both",
            "max_messages_replay": 1000,
            "rotation": {"max_size_mb": 50, "max_files": 10},
        },
        "default_conversation": "general",
    }


# ---------------------------------------------------------------------------
# Convenience fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_participant(registry: ParticipantRegistry) -> dict[str, Any]:
    """A pre-registered participant in 'general'.

    Returns dict with ``key``, ``name``, ``type``, ``conversation``.
    """
    from claude_comms.mcp_tools import tool_comms_join

    result = tool_comms_join(registry, name="test-claude", conversation="general")
    assert "error" not in result
    return result


class PublishSpy:
    """Records async publish calls for assertion in tests."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, bytes]] = []

    async def __call__(self, topic: str, payload: bytes) -> None:
        self.calls.append((topic, payload))

    @property
    def call_count(self) -> int:
        return len(self.calls)

    @property
    def last_call(self) -> tuple[str, bytes] | None:
        return self.calls[-1] if self.calls else None


@pytest.fixture
def publish_spy() -> PublishSpy:
    """Async publish callable that records (topic, payload) tuples."""
    return PublishSpy()


class FailingPublish:
    """Async publish callable that always raises ConnectionError."""

    async def __call__(self, topic: str, payload: bytes) -> None:
        raise ConnectionError("Broker unavailable (test)")


@pytest.fixture
def failing_publish() -> FailingPublish:
    """Async publish callable that simulates broker failure."""
    return FailingPublish()
