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
    summarize_artifact_create,
    summarize_artifact_delete,
    summarize_artifact_get,
    summarize_artifact_list,
    summarize_artifact_update,
    summarize_check,
    summarize_conversation_archive,
    summarize_conversation_create,
    summarize_conversation_delete,
    summarize_conversation_unarchive,
    summarize_conversation_update,
    summarize_conversations,
    summarize_dm_open,
    summarize_get_channel_role,
    summarize_history,
    summarize_invite,
    summarize_join,
    summarize_kick,
    summarize_leave,
    summarize_members,
    summarize_profile_status_clear,
    summarize_profile_status_set,
    summarize_react,
    summarize_reactions_get,
    summarize_read,
    summarize_send,
    summarize_status_clear,
    summarize_status_set,
    summarize_thread_read,
    summarize_update_name,
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
# summarize_join
# --------------------------------------------------------------------------- #
class TestSummarizeJoin:
    def test_ok(self):
        out = summarize_join(
            {
                "key": "aabbccdd",
                "name": "Ada",
                "type": "claude",
                "conversation": "backend",
                "status": "joined",
            }
        )
        assert out == "✅ joined #backend as Ada (aabbccdd)"

    def test_error_loud(self):
        out = summarize_join({"error": True, "message": "Invalid key format"})
        assert out.startswith("⚠️ join failed:")
        assert "Invalid key format" in out


# --------------------------------------------------------------------------- #
# summarize_leave
# --------------------------------------------------------------------------- #
class TestSummarizeLeave:
    def test_left(self):
        out = summarize_leave({"status": "left", "conversation": "backend"})
        assert out == "\U0001f44b left #backend"

    def test_not_a_member(self):
        out = summarize_leave({"status": "not_a_member", "conversation": "backend"})
        assert "not a member of #backend" in out

    def test_error_loud(self):
        out = summarize_leave({"error": True, "message": "boom"})
        assert out.startswith("⚠️ leave failed:")


# --------------------------------------------------------------------------- #
# summarize_update_name
# --------------------------------------------------------------------------- #
class TestSummarizeUpdateName:
    def test_ok(self):
        out = summarize_update_name(
            {"key": "aabbccdd", "name": "NewName", "status": "updated"}
        )
        assert out == "✏️ display name set to NewName"

    def test_error_loud(self):
        out = summarize_update_name({"error": True, "message": "Invalid name"})
        assert out.startswith("⚠️ name update failed:")


# --------------------------------------------------------------------------- #
# summarize_conversations
# --------------------------------------------------------------------------- #
class TestSummarizeConversations:
    def test_joined_list(self):
        result = {
            "conversations": [
                {"conversation": "backend", "unread_count": 0, "total_messages": 5},
                {"conversation": "general", "unread_count": 2, "total_messages": 9},
            ]
        }
        out = summarize_conversations(result)
        assert "2 conversations: backend, general" in out
        assert "\U0001f5c2" in out

    def test_all_with_archived(self):
        result = {
            "conversations": [],
            "all_conversations": [
                {"name": "backend", "archived": False},
                {"name": "general", "archived": False},
                {"name": "old-proj", "archived": True},
            ],
        }
        out = summarize_conversations(result)
        assert "3 conversations: backend, general, old-proj" in out
        assert "(1 archived)" in out

    def test_overflow(self):
        result = {
            "conversations": [{"conversation": n} for n in ["a", "b", "c", "d", "e"]]
        }
        out = summarize_conversations(result)
        assert "5 conversations" in out
        assert "+2 more" in out

    def test_empty(self):
        out = summarize_conversations({"conversations": []})
        assert out == "\U0001f5c2 no conversations"

    def test_error_loud(self):
        out = summarize_conversations({"error": True, "message": "bad"})
        assert out.startswith("⚠️ conversations failed:")


# --------------------------------------------------------------------------- #
# summarize_conversation_create
# --------------------------------------------------------------------------- #
class TestSummarizeConversationCreate:
    def test_ok(self):
        out = summarize_conversation_create(
            {"status": "created", "conversation": "backend", "topic": "x"}
        )
        assert out == "➕ created #backend"

    def test_error_loud(self):
        out = summarize_conversation_create(
            {"error": True, "message": "already exists"}
        )
        assert out.startswith("⚠️ create failed:")


# --------------------------------------------------------------------------- #
# summarize_conversation_update
# --------------------------------------------------------------------------- #
class TestSummarizeConversationUpdate:
    def test_ok_with_fields(self):
        out = summarize_conversation_update(
            {
                "status": "updated",
                "conversation": "backend",
                "updated_fields": ["topic", "visibility"],
            }
        )
        assert out == "✏️ updated #backend (topic, visibility)"

    def test_ok_no_fields(self):
        out = summarize_conversation_update(
            {"status": "updated", "conversation": "backend", "updated_fields": []}
        )
        assert out == "✏️ updated #backend"

    def test_error_loud(self):
        out = summarize_conversation_update(
            {"error": True, "message": "No update fields provided."}
        )
        assert out.startswith("⚠️ update failed:")


# --------------------------------------------------------------------------- #
# summarize_conversation_delete
# --------------------------------------------------------------------------- #
class TestSummarizeConversationDelete:
    def test_deleted(self):
        out = summarize_conversation_delete(
            {"deleted": True, "conversation_id": "backend"}
        )
        assert out == "\U0001f5d1 deleted #backend"

    def test_confirm_required(self):
        out = summarize_conversation_delete(
            {"error": "confirm_required", "message_count": 12, "member_count": 3}
        )
        assert out.startswith("❓ confirm delete:")
        assert "12 msgs" in out
        assert "3 members" in out
        assert "confirm=True" in out

    def test_not_authorized_loud(self):
        out = summarize_conversation_delete(
            {"error": True, "message": "Only the creator may delete"}
        )
        assert out.startswith("⚠️ delete failed:")

    def test_reserved_loud(self):
        out = summarize_conversation_delete(
            {"error": True, "message": "reserved", "reason": "reserved"}
        )
        assert out.startswith("⚠️ delete failed:")


# --------------------------------------------------------------------------- #
# summarize_conversation_archive
# --------------------------------------------------------------------------- #
class TestSummarizeConversationArchive:
    def test_archived(self):
        out = summarize_conversation_archive(
            {
                "archived": True,
                "conversation_id": "backend",
                "evicted_keys": ["aa", "bb"],
                "message_count": 5,
            }
        )
        assert out.startswith("\U0001f4e6 archived #backend")
        assert "2 members ejected" in out

    def test_already_archived(self):
        out = summarize_conversation_archive(
            {
                "archived": True,
                "conversation_id": "backend",
                "status": "already_archived",
            }
        )
        assert "already archived" in out

    def test_confirm_required(self):
        out = summarize_conversation_archive(
            {
                "error": "confirm_required",
                "conversation_id": "backend",
                "message_count": 5,
                "member_count": 2,
            }
        )
        assert out.startswith("❓ confirm archive:")
        assert "confirm=True" in out

    def test_not_authorized_loud(self):
        out = summarize_conversation_archive(
            {
                "error": "not_authorized",
                "conversation_id": "backend",
                "message": "Only the creator can archive it.",
            }
        )
        assert out.startswith("⚠️ archive failed:")
        assert "creator" in out


# --------------------------------------------------------------------------- #
# summarize_conversation_unarchive
# --------------------------------------------------------------------------- #
class TestSummarizeConversationUnarchive:
    def test_unarchived(self):
        out = summarize_conversation_unarchive(
            {"archived": False, "conversation_id": "backend"}
        )
        assert out == "\U0001f4e4 unarchived #backend"

    def test_already_live(self):
        out = summarize_conversation_unarchive(
            {"archived": False, "conversation_id": "backend", "status": "already_live"}
        )
        assert "already live" in out

    def test_error_loud(self):
        out = summarize_conversation_unarchive(
            {"error": "not_authorized", "conversation_id": "backend", "message": "no"}
        )
        assert out.startswith("⚠️ unarchive failed:")


# --------------------------------------------------------------------------- #
# summarize_invite
# --------------------------------------------------------------------------- #
class TestSummarizeInvite:
    def test_invited(self):
        out = summarize_invite({"status": "invited"}, target_name="Ada")
        assert out == "\U0001f4e8 invited Ada"

    def test_already_member(self):
        out = summarize_invite({"status": "already_member"}, target_name="Ada")
        assert "already a member" in out

    def test_error_loud(self):
        out = summarize_invite({"error": True, "message": "Unknown participant"})
        assert out.startswith("⚠️ invite failed:")


# --------------------------------------------------------------------------- #
# summarize_kick
# --------------------------------------------------------------------------- #
class TestSummarizeKick:
    def test_kicked(self):
        out = summarize_kick(
            {"status": "kicked", "target_key": "aabbccdd", "conversation": "backend"},
            target_name="Ada",
        )
        assert out == "\U0001f6aa kicked Ada from #backend"

    def test_kicked_no_name_falls_back_to_key(self):
        out = summarize_kick(
            {"status": "kicked", "target_key": "aabbccdd", "conversation": "backend"}
        )
        assert "aabbccdd" in out

    def test_error_loud(self):
        out = summarize_kick({"error": True, "message": "Only owners or admins"})
        assert out.startswith("\U0001f6aa kick failed:")


# --------------------------------------------------------------------------- #
# summarize_dm_open
# --------------------------------------------------------------------------- #
class TestSummarizeDmOpen:
    def test_opened(self):
        out = summarize_dm_open(
            {"status": "opened", "conversation": "dm-aa-bb"}, target_name="Ada"
        )
        assert out == "\U0001f4ac DM with Ada (#dm-aa-bb)"

    def test_existed(self):
        out = summarize_dm_open(
            {"status": "existed", "conversation": "dm-aa-bb"}, target_name="Ada"
        )
        assert "DM exists with Ada" in out

    def test_error_loud(self):
        out = summarize_dm_open({"error": True, "message": "Cannot DM yourself."})
        assert out.startswith("⚠️ DM open failed:")


# --------------------------------------------------------------------------- #
# summarize_artifact_create
# --------------------------------------------------------------------------- #
class TestSummarizeArtifactCreate:
    def test_ok(self):
        out = summarize_artifact_create(
            {"status": "created", "name": "backend-plan", "title": "Plan", "version": 1}
        )
        assert out == "\U0001f4c4 created artifact 'backend-plan' v1"

    def test_error_loud(self):
        out = summarize_artifact_create({"error": True, "message": "already exists"})
        assert out.startswith("⚠️ artifact create failed:")


# --------------------------------------------------------------------------- #
# summarize_artifact_update
# --------------------------------------------------------------------------- #
class TestSummarizeArtifactUpdate:
    def test_ok(self):
        out = summarize_artifact_update(
            {
                "status": "updated",
                "name": "backend-plan",
                "version": 3,
                "author": {"key": "aa", "name": "Ada", "type": "claude"},
            }
        )
        assert out == "\U0001f4c4 'backend-plan' → v3"

    def test_conflict(self):
        out = summarize_artifact_update(
            {
                "error": True,
                "message": "Version conflict",
                "latest_version": 4,
                "latest_author": "Lin",
            }
        )
        assert out.startswith("⚠️ artifact conflict:")
        assert "v4" in out
        assert "Lin" in out

    def test_error_loud(self):
        out = summarize_artifact_update({"error": True, "message": "not found"})
        assert out.startswith("⚠️ artifact update failed:")


# --------------------------------------------------------------------------- #
# summarize_artifact_get
# --------------------------------------------------------------------------- #
class TestSummarizeArtifactGet:
    def test_ok(self):
        out = summarize_artifact_get(
            {
                "name": "backend-plan",
                "title": "Plan",
                "type": "plan",
                "version": 2,
                "latest_version": 2,
                "versions": [
                    {"version": 1, "author": {"name": "Ada"}},
                    {"version": 2, "author": {"name": "Lin"}},
                ],
            }
        )
        assert out == "\U0001f4c4 'backend-plan' v2 (2 versions) by Lin"

    def test_single_version(self):
        out = summarize_artifact_get(
            {
                "name": "doc",
                "version": 1,
                "versions": [{"version": 1, "author": {"name": "Ada"}}],
            }
        )
        assert "1 version)" in out
        assert "by Ada" in out

    def test_error_loud(self):
        out = summarize_artifact_get({"error": True, "message": "not found"})
        assert out.startswith("⚠️ artifact get failed:")


# --------------------------------------------------------------------------- #
# summarize_artifact_list
# --------------------------------------------------------------------------- #
class TestSummarizeArtifactList:
    def test_ok(self):
        out = summarize_artifact_list(
            {
                "conversation": "backend",
                "artifacts": [{"name": "plan"}, {"name": "doc"}],
                "count": 2,
            }
        )
        assert out == "\U0001f4c4 2 artifacts: plan, doc"

    def test_empty(self):
        out = summarize_artifact_list(
            {"conversation": "backend", "artifacts": [], "count": 0}
        )
        assert out == "\U0001f4c4 no artifacts in #backend"

    def test_overflow(self):
        out = summarize_artifact_list(
            {
                "conversation": "backend",
                "artifacts": [{"name": n} for n in ["a", "b", "c", "d"]],
                "count": 4,
            }
        )
        assert "4 artifacts" in out
        assert "+1 more" in out

    def test_error_loud(self):
        out = summarize_artifact_list({"error": True, "message": "bad"})
        assert out.startswith("⚠️ artifact list failed:")


# --------------------------------------------------------------------------- #
# summarize_artifact_delete
# --------------------------------------------------------------------------- #
class TestSummarizeArtifactDelete:
    def test_ok(self):
        out = summarize_artifact_delete({"status": "deleted", "name": "backend-plan"})
        assert out == "\U0001f5d1 deleted artifact 'backend-plan'"

    def test_error_loud(self):
        out = summarize_artifact_delete({"error": True, "message": "not found"})
        assert out.startswith("⚠️ artifact delete failed:")


# --------------------------------------------------------------------------- #
# summarize_react
# --------------------------------------------------------------------------- #
class TestSummarizeReact:
    def test_applied_add(self):
        out = summarize_react(
            {
                "status": "applied",
                "message_id": "msg-12345678abc",
                "emoji": "👍",
                "op": "add",
                "actor_key": "aa",
                "ts": "x",
            }
        )
        assert out == "👍 reacted to msg-1234"

    def test_applied_remove(self):
        out = summarize_react(
            {
                "status": "applied",
                "message_id": "msg-12345678abc",
                "emoji": "👍",
                "op": "remove",
            }
        )
        assert out.startswith("👍 unreacted to")

    def test_no_op(self):
        out = summarize_react(
            {"status": "no_op", "message_id": "msg-12345678", "emoji": "❤️"}
        )
        assert "no change" in out
        assert "❤️" in out

    def test_throttled(self):
        out = summarize_react({"status": "throttled", "limit_per_minute": 30})
        assert out.startswith("⚠️ react throttled")

    def test_persisted_publish_failed_not_loud(self):
        out = summarize_react(
            {
                "status": "persisted_publish_failed",
                "id": "msg-12345678",
                "emoji": "👍",
                "op": "add",
                "error": "boom",
            }
        )
        assert "broadcast failed" in out
        assert "👍" in out

    def test_error_loud(self):
        out = summarize_react({"error": True, "message": "message_id required"})
        assert out.startswith("⚠️ react failed:")


# --------------------------------------------------------------------------- #
# summarize_reactions_get
# --------------------------------------------------------------------------- #
class TestSummarizeReactionsGet:
    def test_ok(self):
        out = summarize_reactions_get(
            {
                "conversation": "backend",
                "message_id": "msg-12345678",
                "reactions": {"👍": ["a", "b"], "❤️": ["c"]},
            }
        )
        assert out.startswith("3 reactions on msg-1234:")
        assert "👍x2" in out
        assert "❤️x1" in out

    def test_empty(self):
        out = summarize_reactions_get(
            {"conversation": "backend", "message_id": "msg-12345678", "reactions": {}}
        )
        assert out == "\U0001f937 no reactions on msg-1234"

    def test_overflow(self):
        reactions = {e: ["a"] for e in ["a", "b", "c", "d", "e", "f", "g"]}
        out = summarize_reactions_get(
            {"message_id": "msg-12345678", "reactions": reactions}
        )
        assert "(+2 more)" in out

    def test_error_loud(self):
        out = summarize_reactions_get({"error": True, "message": "not a member"})
        assert out.startswith("⚠️ reactions failed:")


# --------------------------------------------------------------------------- #
# summarize_status_set / clear
# --------------------------------------------------------------------------- #
class TestSummarizeStatus:
    def test_set(self):
        out = summarize_status_set({"status": "set", "key": "aa", "label": "thinking"})
        assert out == "\U0001f7e2 status: thinking"

    def test_throttled(self):
        out = summarize_status_set(
            {"status": "throttled", "key": "aa", "label": "x", "throttle_seconds": 2}
        )
        assert out.startswith("⚠️ status throttled")

    def test_set_error_loud(self):
        out = summarize_status_set({"error": True, "message": "Not a member"})
        assert out.startswith("⚠️ status failed:")

    def test_clear(self):
        out = summarize_status_clear({"status": "cleared", "key": "aa", "count": 1})
        assert out == "⚪ status cleared"

    def test_clear_error_loud(self):
        out = summarize_status_clear({"error": True, "message": "bad conv"})
        assert out.startswith("⚠️ status clear failed:")


# --------------------------------------------------------------------------- #
# summarize_profile_status_set / clear
# --------------------------------------------------------------------------- #
class TestSummarizeProfileStatus:
    def test_set(self):
        out = summarize_profile_status_set(
            {"status": "set", "key": "aa", "emoji": "🚀", "text": "shipping"}
        )
        assert out == "\U0001f7e2 profile status: 🚀 shipping"

    def test_set_collapses_to_clear(self):
        out = summarize_profile_status_set(
            {"status": "cleared", "key": "aa", "emoji": None, "text": None}
        )
        assert out == "⚪ profile status cleared"

    def test_set_error_loud(self):
        out = summarize_profile_status_set(
            {"error": True, "message": "Daemon config missing identity.key."}
        )
        assert out.startswith("⚠️ profile status failed:")

    def test_clear(self):
        out = summarize_profile_status_clear({"status": "cleared", "key": "aa"})
        assert out == "⚪ profile status cleared"

    def test_clear_error_loud(self):
        out = summarize_profile_status_clear({"error": True, "message": "no key"})
        assert out.startswith("⚠️ profile status clear failed:")


# --------------------------------------------------------------------------- #
# summarize_get_channel_role
# --------------------------------------------------------------------------- #
class TestSummarizeGetChannelRole:
    def test_ok(self):
        out = summarize_get_channel_role(
            {"role": "admin", "participant_key": "aa", "conversation": "backend"}
        )
        assert out == "\U0001f3ad role in #backend: admin"

    def test_default_member(self):
        out = summarize_get_channel_role(
            {"role": "member", "participant_key": "aa", "conversation": "backend"}
        )
        assert "role in #backend: member" in out

    def test_error_loud(self):
        out = summarize_get_channel_role({"error": True, "message": "not a member"})
        assert out.startswith("⚠️ role lookup failed:")


# --------------------------------------------------------------------------- #
# summarize_thread_read
# --------------------------------------------------------------------------- #
class TestSummarizeThreadRead:
    def test_ok(self):
        result = {
            "conversation": "backend",
            "root": {"id": "root-1234abcd", "sender": {"name": "Ada"}, "body": "q"},
            "replies": [
                _msg("Lin", "first"),
                _msg("Sam", "looks good to me"),
            ],
            "count": 2,
            "has_more": False,
        }
        out = summarize_thread_read(result)
        assert "2 replies under root-123" in out
        assert 'last: Sam: "looks good to me"' in out

    def test_empty(self):
        result = {
            "conversation": "backend",
            "root": {"id": "root-1234abcd"},
            "replies": [],
            "count": 0,
            "has_more": False,
        }
        out = summarize_thread_read(result)
        assert out == "\U0001f9f5 no replies under root-123"

    def test_has_more(self):
        result = {
            "conversation": "backend",
            "root": {"id": "root-1234abcd"},
            "replies": [_msg("Lin", "x")],
            "count": 1,
            "has_more": True,
        }
        out = summarize_thread_read(result)
        assert "1 reply under root-123" in out
        assert "(+more)" in out

    def test_error_loud(self):
        out = summarize_thread_read({"error": True, "message": "Root not found"})
        assert out.startswith("⚠️ thread read failed:")


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

    def _assert_concise_shape(self, res: CallToolResult) -> dict[str, Any]:
        """Shared assertions: text-only CallToolResult, no structuredContent,
        ctrl+o affordance, full JSON after the separator. Returns parsed JSON."""
        assert isinstance(res, CallToolResult)
        assert res.structuredContent is None
        assert len(res.content) == 1
        block = res.content[0]
        assert isinstance(block, TextContent)
        text = block.text
        assert "(ctrl+o for full)" in text
        assert "\n---\n" in text
        _, _, json_part = text.partition("\n---\n")
        return json.loads(json_part)

    def test_join_wrapper_shape(self, tmp_config: dict[str, Any]):
        import claude_comms.mcp_server as srv

        mcp = srv.create_server(config=tmp_config)
        res = self._call(
            mcp, "comms_join", {"name": "joiner", "conversation": "general"}
        )
        parsed = self._assert_concise_shape(res)
        # Summary line present (the human surface).
        summary = res.content[0].text.split("\n", 1)[0]
        assert summary.startswith("✅ joined #general as joiner")
        # Full JSON still carries the key + status for the model.
        assert parsed["status"] == "joined"
        assert "key" in parsed
        assert parsed["name"] == "joiner"

    def test_artifact_create_wrapper_shape(
        self, tmp_config: dict[str, Any], tmp_path: Any
    ):
        import claude_comms.mcp_server as srv

        # Isolate the artifact store under tmp_path; the default config points
        # at the real ~/.claude-comms/artifacts which would leak state across
        # runs (and pollute the user's home).
        cfg = dict(tmp_config)
        cfg["artifacts"] = {"data_dir": str(tmp_path / "artifacts")}
        mcp = srv.create_server(config=cfg)

        # comms_artifact_create publishes on success; swap the broker-required
        # _noop_publish for a swallowing stub so the success path completes
        # without a live MQTT daemon.
        async def _stub_publish(topic: str, payload: bytes, retain: bool = False):
            return None

        srv._publish_fn = _stub_publish

        p = srv._registry.join("art-creator", "general")
        res = self._call(
            mcp,
            "comms_artifact_create",
            {
                "key": p.key,
                "conversation": "general",
                "name": "shape-plan",
                "title": "Plan A",
                "type": "plan",
                "content": "# hello",
            },
        )
        parsed = self._assert_concise_shape(res)
        summary = res.content[0].text.split("\n", 1)[0]
        assert summary == "\U0001f4c4 created artifact 'shape-plan' v1"
        assert parsed["status"] == "created"
        assert parsed["version"] == 1

    def test_kick_wrapper_shape_error_stays_loud(self, tmp_config: dict[str, Any]):
        # A non-owner kick is an authorization failure; the wrapper must still
        # return a CallToolResult with a LOUD summary and the full JSON, no
        # structuredContent. This exercises the error-envelope path end-to-end.
        import claude_comms.mcp_server as srv

        mcp = srv.create_server(config=tmp_config)
        caller = srv._registry.join("kicker", "general")
        target = srv._registry.join("kick-target", "general")
        res = self._call(
            mcp,
            "comms_kick",
            {
                "key": caller.key,
                "conversation": "general",
                "target_key": target.key,
            },
        )
        parsed = self._assert_concise_shape(res)
        summary = res.content[0].text.split("\n", 1)[0]
        # Loud failure marker for the human.
        assert summary.startswith("\U0001f6aa kick failed:")
        # Full error envelope preserved for the model.
        assert parsed.get("error")
