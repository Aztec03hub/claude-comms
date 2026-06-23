"""Timestamp comparison correctness for `_ts_after` / `_parse_ts`.

These helpers must order ISO-8601 timestamps by real-world instant across
mixed UTC (`...Z`) and offset (`...-05:00`) notations on ALL Python versions
(3.10+). Python <3.11's `datetime.fromisoformat` cannot parse the `Z` suffix,
so a naive parse-or-string-compare fallback would lexically (and wrongly) sort
`2026-06-23T07:51:00Z` AFTER `2026-06-23T03:32:54-05:00` even though the former
(02:51 CST) is earlier in real time. That bug makes `comms_read(since=...)`
return already-seen messages and can corrupt the unread-cursor path, since
`unread=True` and `comms_check` compare a cursor against message timestamps via
the same `_ts_after`.
"""

from __future__ import annotations

from typing import Any

from claude_comms.broker import MessageStore
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    _parse_ts,
    _ts_after,
    tool_comms_read,
)


# ---------------------------------------------------------------------------
# _ts_after — the exact bug case
# ---------------------------------------------------------------------------


def test_utc_z_before_offset_is_not_after() -> None:
    # 07:51Z == 02:51 CST, which is BEFORE 03:32 CST (== 08:32Z).
    # A naive string compare returns True ("Z" > "-"); the fix returns False.
    assert _ts_after("2026-06-23T07:51:00.091Z", "2026-06-23T03:32:54-05:00") is False


def test_offset_after_utc_z_is_after() -> None:
    # 09:00-05:00 == 14:00Z, strictly after 07:51Z.
    assert _ts_after("2026-06-23T09:00:00-05:00", "2026-06-23T07:51:00.091Z") is True


# ---------------------------------------------------------------------------
# Same-notation ordering still works
# ---------------------------------------------------------------------------


def test_z_vs_z_orders_correctly() -> None:
    assert _ts_after("2026-06-23T08:00:00Z", "2026-06-23T07:00:00Z") is True
    assert _ts_after("2026-06-23T07:00:00Z", "2026-06-23T08:00:00Z") is False


def test_offset_vs_offset_orders_correctly() -> None:
    assert _ts_after("2026-06-23T08:00:00-05:00", "2026-06-23T07:00:00-05:00") is True
    assert _ts_after("2026-06-23T07:00:00-05:00", "2026-06-23T08:00:00-05:00") is False


def test_equal_instants_different_notation_not_after_either_way() -> None:
    # 07:00:00Z == 02:00:00-05:00 — the same instant, so neither is "after".
    a = "2026-06-23T07:00:00Z"
    b = "2026-06-23T02:00:00-05:00"
    assert _ts_after(a, b) is False
    assert _ts_after(b, a) is False


# ---------------------------------------------------------------------------
# Naive timestamps + malformed input
# ---------------------------------------------------------------------------


def test_naive_timestamp_treated_as_utc() -> None:
    # A naive value (no tz) is assumed UTC, so it compares against offset/Z.
    parsed = _parse_ts("2026-06-23T07:00:00")
    assert parsed is not None
    assert parsed.tzinfo is not None
    # 07:00 (naive->UTC) == 02:00-05:00 instant: not after.
    assert _ts_after("2026-06-23T07:00:00", "2026-06-23T02:00:00-05:00") is False
    # 07:00 (naive->UTC) is after 06:00Z.
    assert _ts_after("2026-06-23T07:00:00", "2026-06-23T06:00:00Z") is True


def test_malformed_input_falls_back_without_raising() -> None:
    assert _parse_ts("not-a-timestamp") is None
    # Falls back to string comparison; must not raise.
    assert _ts_after("zzz", "aaa") is True
    assert _ts_after("aaa", "zzz") is False


# ---------------------------------------------------------------------------
# Higher-level: tool_comms_read(since=<UTC Z>) over -05:00 messages
# ---------------------------------------------------------------------------


def _msg(sender_key: str, ts: str, msg_id: str) -> dict[str, Any]:
    return {
        "id": msg_id,
        "ts": ts,
        "sender": {"key": sender_key, "name": "s", "type": "claude"},
        "body": "hi",
        "recipients": None,
        "mentions": None,
        "reply_to": None,
        "conv": "general",
    }


def test_read_since_utc_z_over_offset_messages_returns_only_newer() -> None:
    reg = ParticipantRegistry()
    a = reg.join("a", "general").key
    b = reg.join("b", "general").key
    store = MessageStore()

    # All message timestamps carry a -05:00 offset.
    store.add("general", _msg(b, "2026-06-23T02:00:00-05:00", "early"))  # 07:00Z
    store.add("general", _msg(b, "2026-06-23T03:32:54-05:00", "mid"))  # 08:32:54Z
    store.add("general", _msg(b, "2026-06-23T09:00:00-05:00", "late"))  # 14:00Z

    # since is a UTC `Z` string at 08:00Z (== 03:00 CST). Only "mid" and "late"
    # are genuinely newer. The pre-fix string compare would have wrongly
    # dropped "mid"/"late" (since "Z" < "-05:00" lexically) or returned "early".
    r = tool_comms_read(
        reg,
        store,
        key=a,
        conversation="general",
        since="2026-06-23T08:00:00Z",
    )
    assert [m["id"] for m in r["messages"]] == ["mid", "late"]
