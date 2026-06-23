"""tool_comms_read unread-cursor mode + directed_at_me flag.

Manual `since` polling is fragile: an agent hand-rolls a timestamp and can skip
messages. `unread=True` instead reads from the SERVER-SIDE read cursor — exactly
what the participant hasn't seen — and advances it, so a poll loop never misses
a message regardless of clock/timestamp handling. Every returned message also
carries `directed_at_me` so agents detect @mentions/whispers without re-deriving.
"""

from __future__ import annotations

from typing import Any

from claude_comms.broker import MessageStore
from claude_comms.mcp_tools import ParticipantRegistry, tool_comms_read


def _msg(
    sender_key: str,
    ts: str,
    msg_id: str,
    *,
    body: str = "hi",
    recipients: list[str] | None = None,
    mentions: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": msg_id,
        "ts": ts,
        "sender": {"key": sender_key, "name": "s", "type": "claude"},
        "body": body,
        "recipients": recipients,
        "mentions": mentions,
        "reply_to": None,
        "conv": "general",
    }


def _setup() -> tuple[ParticipantRegistry, MessageStore, str, str]:
    reg = ParticipantRegistry()
    a = reg.join("a", "general").key
    b = reg.join("b", "general").key
    return reg, MessageStore(), a, b


def test_unread_reads_from_server_cursor_no_manual_since() -> None:
    reg, store, a, b = _setup()
    store.add("general", _msg(b, "2026-05-06T10:00:00-05:00", "m1"))
    store.add("general", _msg(b, "2026-05-06T10:01:00-05:00", "m2"))

    # First unread read returns everything unseen and advances the cursor.
    r1 = tool_comms_read(reg, store, key=a, conversation="general", unread=True)
    assert [m["id"] for m in r1["messages"]] == ["m1", "m2"]

    # A new message arrives; unread read returns ONLY it (cursor advanced) — no
    # manual `since` passed at any point.
    store.add("general", _msg(b, "2026-05-06T10:02:00-05:00", "m3"))
    r2 = tool_comms_read(reg, store, key=a, conversation="general", unread=True)
    assert [m["id"] for m in r2["messages"]] == ["m3"]

    # Nothing new -> empty.
    r3 = tool_comms_read(reg, store, key=a, conversation="general", unread=True)
    assert r3["messages"] == []


def test_unread_includes_mentions_and_whispers_to_me() -> None:
    reg, store, a, b = _setup()
    store.add("general", _msg(b, "2026-05-06T10:00:00-05:00", "broad", body="all"))
    store.add("general", _msg(b, "2026-05-06T10:01:00-05:00", "ment", mentions=[a]))
    store.add("general", _msg(b, "2026-05-06T10:02:00-05:00", "whisp", recipients=[a]))
    # a whisper to someone else must NOT appear for `a`
    store.add("general", _msg(b, "2026-05-06T10:03:00-05:00", "other", recipients=[b]))

    r = tool_comms_read(reg, store, key=a, conversation="general", unread=True)
    ids = [m["id"] for m in r["messages"]]
    assert ids == ["broad", "ment", "whisp"]  # "other" filtered by visibility


def test_directed_at_me_flag() -> None:
    reg, store, a, b = _setup()
    store.add("general", _msg(b, "2026-05-06T10:00:00-05:00", "broad", body="all"))
    store.add("general", _msg(b, "2026-05-06T10:01:00-05:00", "ment", mentions=[a]))
    store.add("general", _msg(b, "2026-05-06T10:02:00-05:00", "whisp", recipients=[a]))

    by_id = {
        m["id"]: m
        for m in tool_comms_read(reg, store, key=a, conversation="general", count=50)[
            "messages"
        ]
    }
    assert by_id["broad"]["directed_at_me"] is False
    assert by_id["ment"]["directed_at_me"] is True
    assert by_id["whisp"]["directed_at_me"] is True


def test_explicit_since_overrides_unread() -> None:
    reg, store, a, b = _setup()
    store.add("general", _msg(b, "2026-05-06T10:00:00-05:00", "m1"))
    store.add("general", _msg(b, "2026-05-06T10:01:00-05:00", "m2"))
    # explicit since wins even with unread=True
    r = tool_comms_read(
        reg,
        store,
        key=a,
        conversation="general",
        since="2026-05-06T10:00:30-05:00",
        unread=True,
    )
    assert [m["id"] for m in r["messages"]] == ["m2"]
