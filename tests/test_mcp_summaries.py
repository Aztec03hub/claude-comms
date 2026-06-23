"""Tests for concise MCP tool-output summaries.

Covers each pure ``summarize_*`` function in
:mod:`claude_comms.mcp_summaries` against realistic result dicts (empty,
single, many, whisper, mention, error, zero-unread), plus an end-to-end test
asserting the wrapper return shape: a text-only ``CallToolResult`` that carries
both the summary AND the full JSON, with NO ``structuredContent``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from mcp.types import CallToolResult, TextContent

from claude_comms.mcp_summaries import (
    summarize_check,
    summarize_history,
    summarize_members,
    summarize_read,
    summarize_send,
)


def _msg(
    name: str,
    body: str,
    *,
    ts: str = "2026-06-23T10:00:00.000-05:00",
    directed: bool = False,
    key: str = "aabbccdd",
) -> dict[str, Any]:
    """Build a realistic message dict like the store returns."""
    m: dict[str, Any] = {
        "id": "msg-0001",
        "ts": ts,
        "sender": {"key": key, "name": name, "type": "claude"},
        "body": body,
        "conv": "backend",
    }
    if directed:
        m["directed_at_me"] = True
    return m


# --------------------------------------------------------------------------- #
# summarize_read
# --------------------------------------------------------------------------- #
class TestSummarizeRead:
    def test_empty(self):
        result = {
            "conversation": "backend",
            "messages": [],
            "count": 0,
            "has_more": False,
        }
        out = summarize_read(result)
        assert out == "\U0001f4ed no new messages in #backend"
        assert "\n" not in out  # single line for the empty case

    def test_single(self):
        result = {
            "conversation": "general",
            "messages": [_msg("Ada", "hello there")],
            "count": 1,
            "has_more": False,
        }
        out = summarize_read(result)
        assert "1 msg in #general" in out
        assert "from Ada" in out
        assert 'last: Ada: "hello there"' in out

    def test_many_with_directed(self):
        msgs = [
            _msg("Ada", "a"),
            _msg("Lin", "b"),
            _msg("Sam", "pushed the cursor fix, can you re-run e2e?", directed=True),
        ]
        result = {
            "conversation": "backend",
            "messages": msgs,
            "count": 3,
            "has_more": False,
        }
        out = summarize_read(result)
        assert "3 msgs in #backend" in out
        assert "(1 for you)" in out
        assert "from Ada, Lin, Sam" in out
        assert "Sam:" in out

    def test_sender_overflow_and_has_more(self):
        msgs = [_msg(n, "x") for n in ["Ada", "Lin", "Sam", "Bo"]]
        result = {
            "conversation": "backend",
            "messages": msgs,
            "count": 4,
            "has_more": True,
        }
        out = summarize_read(result)
        assert "+1 more" in out  # 4 unique senders, cap 3
        assert "(+more older)" in out

    def test_no_directed_drops_clause(self):
        result = {
            "conversation": "g",
            "messages": [_msg("Ada", "x")],
            "count": 1,
            "has_more": False,
        }
        out = summarize_read(result)
        assert "for you" not in out

    def test_error_loud(self):
        out = summarize_read({"error": True, "message": "Unknown participant"})
        assert out.startswith("⚠️ read failed:")
        assert "Unknown participant" in out

    def test_body_truncation(self):
        long = "x" * 200
        result = {
            "conversation": "g",
            "messages": [_msg("Ada", long)],
            "count": 1,
            "has_more": False,
        }
        out = summarize_read(result)
        assert "…" in out
        # last line should not contain the entire 200-char body
        assert long not in out


# --------------------------------------------------------------------------- #
# summarize_history
# --------------------------------------------------------------------------- #
class TestSummarizeHistory:
    def test_empty_with_query(self):
        result = {
            "conversation": "general",
            "query": "deploy",
            "messages": [],
            "count": 0,
            "has_more": False,
        }
        out = summarize_history(result)
        assert out == '\U0001f5d2️ no matches for "deploy" in #general'

    def test_empty_no_query(self):
        result = {
            "conversation": "general",
            "query": None,
            "messages": [],
            "count": 0,
            "has_more": False,
        }
        out = summarize_history(result)
        assert out == "\U0001f5d2️ no messages in #general"

    def test_many_with_query_and_more(self):
        msgs = [
            _msg("Ada", "deploy a", ts="2026-06-21T09:14:00.000-05:00"),
            _msg("Lin", "deploy b", ts="2026-06-23T11:02:00.000-05:00"),
        ]
        result = {
            "conversation": "general",
            "query": "deploy",
            "messages": msgs,
            "count": 50,
            "has_more": True,
        }
        out = summarize_history(result)
        assert "50 msgs in #general" in out
        assert 'matching "deploy"' in out
        assert "06-21 09:14..06-23 11:02" in out
        assert "2 participants" in out
        assert "(+older)" in out

    def test_no_query_drops_clause(self):
        msgs = [_msg("Ada", "x")]
        result = {
            "conversation": "g",
            "query": None,
            "messages": msgs,
            "count": 1,
            "has_more": False,
        }
        out = summarize_history(result)
        assert "matching" not in out
        assert "1 msg in #g" in out
        assert "1 participant" in out

    def test_error_loud(self):
        out = summarize_history({"error": True, "message": "boom"})
        assert out.startswith("⚠️ history failed:")


# --------------------------------------------------------------------------- #
# summarize_members
# --------------------------------------------------------------------------- #
def _member(name: str, online: bool, key: str = "00000000") -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "type": "claude",
        "online": online,
        "status": "online" if online else "offline",
    }


class TestSummarizeMembers:
    def test_empty(self):
        out = summarize_members({"conversation": "backend", "members": [], "count": 0})
        assert out == "\U0001f465 #backend has no members"

    def test_small_lists_all(self):
        members = [
            _member("Ada", True),
            _member("Lin", False),
        ]
        out = summarize_members(
            {"conversation": "backend", "members": members, "count": 2}
        )
        assert "1 online / 2 total in #backend" in out
        assert "Ada, Lin" in out
        assert "more" not in out

    def test_many_overflow_online_first(self):
        members = [
            _member("Off1", False),
            _member("Ada", True),
            _member("Lin", True),
            _member("Off2", False),
            _member("Off3", False),
        ]
        out = summarize_members(
            {"conversation": "backend", "members": members, "count": 5}
        )
        assert "2 online / 5 total" in out
        # online members listed first, cap 2
        assert "Ada, Lin" in out
        assert "+3 more" in out

    def test_error_loud(self):
        out = summarize_members({"error": True, "message": "bad conv"})
        assert out.startswith("⚠️ members failed:")


# --------------------------------------------------------------------------- #
# summarize_check
# --------------------------------------------------------------------------- #
class TestSummarizeCheck:
    def test_zero_all_caught_up(self):
        out = summarize_check({"total_unread": 0, "conversations": []})
        assert out == "\U0001f514 all caught up (0 unread)"

    def test_many_with_top(self):
        convs = [
            {"conversation": "backend", "unread_count": 5, "latest": None},
            {"conversation": "general", "unread_count": 4, "latest": None},
        ]
        out = summarize_check({"total_unread": 9, "conversations": convs})
        assert "9 unread across 2 convs" in out
        assert "(top: #backend 5)" in out

    def test_thread_replies(self):
        convs = [
            {
                "conversation": "backend",
                "unread_count": 5,
                "latest": None,
                "thread_unread": {"root-1": 2},
            },
        ]
        out = summarize_check({"total_unread": 5, "conversations": convs})
        assert "2 thread replies" in out

    def test_single_thread_reply_singular(self):
        convs = [
            {
                "conversation": "backend",
                "unread_count": 1,
                "latest": None,
                "thread_unread": {"root-1": 1},
            },
        ]
        out = summarize_check({"total_unread": 1, "conversations": convs})
        assert "1 thread reply" in out
        assert "1 unread across 1 conv," in out  # singular conv
        assert "1 convs" not in out

    def test_only_thread_unread_not_caught_up(self):
        # total_unread 0 but thread replies exist -> not "all caught up"
        convs = [
            {
                "conversation": "backend",
                "unread_count": 0,
                "latest": None,
                "thread_unread": {"root-1": 3},
            },
        ]
        out = summarize_check({"total_unread": 0, "conversations": convs})
        assert "all caught up" not in out
        assert "3 thread replies" in out

    def test_error_loud(self):
        out = summarize_check({"error": True, "message": "nope"})
        assert out.startswith("⚠️ check failed:")


# --------------------------------------------------------------------------- #
# summarize_send
# --------------------------------------------------------------------------- #
class TestSummarizeSend:
    def _ok(self, **over: Any) -> dict[str, Any]:
        base = {
            "status": "sent",
            "id": "msg-9",
            "conversation": "general",
            "recipients": [],
            "mentions": [],
            "recipient_names": None,
            "mention_names": None,
            "reply_to": None,
        }
        base.update(over)
        return base

    def test_plain(self):
        assert summarize_send(self._ok()) == "✅ sent to #general"

    def test_mentions(self):
        out = summarize_send(
            self._ok(conversation="backend", mention_names=["Ada", "Lin"])
        )
        assert out == "✅ sent to #backend · @Ada, Lin"

    def test_whisper_and_reply(self):
        out = summarize_send(
            self._ok(
                conversation="backend",
                recipient_names=["Sam"],
                reply_to="msg-1",
            )
        )
        assert out == "✅ sent to #backend as reply · whisper to Sam"

    def test_whisper_and_mention(self):
        out = summarize_send(
            self._ok(
                conversation="backend",
                recipient_names=["Sam"],
                mention_names=["Ada"],
            )
        )
        assert "whisper to Sam" in out
        assert "@Ada" in out

    def test_error_dict_loud(self):
        out = summarize_send(
            {"error": True, "message": "Message body cannot be empty."}
        )
        assert out == "⚠️ send failed: Message body cannot be empty."

    def test_archived_error_loud(self):
        out = summarize_send(
            {"error": "conversation_archived", "message": "Conversation is archived."}
        )
        assert out.startswith("⚠️ send failed:")
        assert "archived" in out.lower()

    def test_unexpected_status_loud(self):
        out = summarize_send({"status": "queued", "conversation": "g"})
        assert out.startswith("⚠️ send failed:")


# --------------------------------------------------------------------------- #
# Wrapper return shape (end-to-end through FastMCP)
# --------------------------------------------------------------------------- #
class TestWrapperReturnShape:
    """Assert the live tool wrappers return a text-only CallToolResult with
    both the summary and the full JSON, and NO structuredContent."""

    def _call(self, mcp, name: str, args: dict[str, Any]) -> CallToolResult:
        # Mirror FastMCP's call path: the tool manager converts the return value
        # exactly as the lowlevel call handler would. convert_result=True yields
        # the CallToolResult our wrapper returns, untouched.
        return asyncio.run(
            mcp._tool_manager.call_tool(name, args, context=None, convert_result=True)
        )

    def test_read_wrapper_shape(self, tmp_config: dict[str, Any]):
        import claude_comms.mcp_server as srv

        mcp = srv.create_server(config=tmp_config)
        # Register a participant so the tool returns a real (non-error) dict.
        p = srv._registry.join("shape-test", "general")

        res = self._call(mcp, "comms_read", {"key": p.key, "conversation": "general"})

        # 1. It is a CallToolResult.
        assert isinstance(res, CallToolResult)
        # 2. No structuredContent (this is what kills the noisy JSON blob).
        assert res.structuredContent is None
        # 3. A single text content block.
        assert len(res.content) == 1
        block = res.content[0]
        assert isinstance(block, TextContent)
        text = block.text
        # 4. Summary present (empty conversation -> the no-new-messages line).
        assert "no new messages in #general" in text
        # 5. The ctrl+o affordance and separator are present.
        assert "(ctrl+o for full)" in text
        assert "\n---\n" in text
        # 6. The full JSON payload is present and round-trips with every field.
        _, _, json_part = text.partition("\n---\n")
        parsed = json.loads(json_part)
        assert parsed["conversation"] == "general"
        assert "messages" in parsed
        assert "count" in parsed
        assert "has_more" in parsed

    def test_check_wrapper_preserves_full_payload(self, tmp_config: dict[str, Any]):
        import claude_comms.mcp_server as srv

        mcp = srv.create_server(config=tmp_config)
        p = srv._registry.join("shape-test-2", "general")

        res = self._call(mcp, "comms_check", {"key": p.key})
        assert isinstance(res, CallToolResult)
        assert res.structuredContent is None
        text = res.content[0].text
        _, _, json_part = text.partition("\n---\n")
        parsed = json.loads(json_part)
        # The model must still get total_unread + conversations.
        assert "total_unread" in parsed
        assert "conversations" in parsed
