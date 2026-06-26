"""Single-sourcing guards for cross-file DRY consolidations (DRY audit).

These pin that the de-duplicated constants/patterns route through their one
canonical home so a future divergence (e.g. changing the key charset/length,
or the system sentinel) cannot silently desync the producers from the
consumers.
"""

from __future__ import annotations

import pytest

from claude_comms import cli, mcp_server, mcp_tools, notifier, reactions
from claude_comms import message, participant


class TestSystemSenderKeySingleSource:
    def test_constant_value(self) -> None:
        assert message.SYSTEM_SENDER_KEY == "00000000"

    def test_notifier_uses_shared_constant(self) -> None:
        # notifier's "never cue a system message" rule must key off the same
        # sentinel the producers stamp.
        assert notifier._SYSTEM_KEY is message.SYSTEM_SENDER_KEY

    def test_producers_import_shared_constant(self) -> None:
        # The producers (mcp_tools / mcp_server / cli) must reference the one
        # constant, not a private re-typed literal.
        assert mcp_tools.SYSTEM_SENDER_KEY is message.SYSTEM_SENDER_KEY
        assert mcp_server.SYSTEM_SENDER_KEY is message.SYSTEM_SENDER_KEY
        assert cli.SYSTEM_SENDER_KEY is message.SYSTEM_SENDER_KEY


class TestKeyPatternSingleSource:
    def test_reactions_uses_canonical_pattern(self) -> None:
        assert reactions.KEY_PATTERN is participant.KEY_PATTERN

    def test_mcp_tools_uses_canonical_pattern(self) -> None:
        assert mcp_tools.KEY_PATTERN is participant.KEY_PATTERN

    @pytest.mark.parametrize("bad", ["", "ABCDEF12", "deadbeef0", "xyz", "0123456g"])
    def test_message_recipient_validation_rejects_bad_keys(self, bad: str) -> None:
        # Proves the message validators route through KEY_PATTERN (8 lowercase
        # hex). A bad key must be rejected on both recipients and mentions.
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            message.Message.create(
                sender_key="aaaa0001",
                sender_name="alice",
                sender_type="human",
                body="hi",
                conv="general",
                recipients=[bad],
            )
        with pytest.raises(ValidationError):
            message.Message.create(
                sender_key="aaaa0001",
                sender_name="alice",
                sender_type="human",
                body="hi",
                conv="general",
                mentions=[bad],
            )

    def test_message_accepts_valid_key(self) -> None:
        msg = message.Message.create(
            sender_key="aaaa0001",
            sender_name="alice",
            sender_type="human",
            body="hi",
            conv="general",
            recipients=["bbbb0002"],
        )
        assert msg.recipients == ["bbbb0002"]
