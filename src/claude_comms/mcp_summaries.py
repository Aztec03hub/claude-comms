"""Concise, human-readable summaries for the chatty MCP tools.

Each ``summarize_*`` function takes the *exact* result dict returned by the
corresponding ``tool_comms_*`` function in :mod:`claude_comms.mcp_tools` and
returns a short (<= 3 line) human-facing summary string. These are pure
``dict -> str`` functions so they are trivially unit-testable.

The summaries are rendered first in the Claude Code window (where the
transcript collapses tool output to the leading lines), while the full JSON
payload still travels to the model. See
``.worklogs/harness-fixes/concise-tool-output-design.md`` for the design.

House style: no em dashes; use commas / parens. A leading emoji tags each
line for scannability.
"""

from __future__ import annotations

from typing import Any


def _is_error(result: dict[str, Any]) -> bool:
    """True when *result* is an ``_error()``-shaped dict."""
    return bool(result.get("error"))


_IRREGULAR_PLURALS = {"reply": "replies"}


def _plural(n: int, word: str = "msg") -> str:
    """``word`` pluralized for count *n*.

    Handles a small set of irregular plurals (e.g. reply -> replies);
    everything else gets a naive 's' suffix.
    """
    if n == 1:
        return word
    return _IRREGULAR_PLURALS.get(word, f"{word}s")


def _sender_name(msg: dict[str, Any]) -> str:
    """Best-effort sender display name from a message dict."""
    sender = msg.get("sender") or {}
    return sender.get("name") or sender.get("key") or "?"


def _truncate(text: str, limit: int = 60) -> str:
    """Single-line truncation of *text* to ~``limit`` chars."""
    flat = " ".join((text or "").split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1].rstrip() + "…"


def _names_clause(names: list[str], cap: int = 3) -> str:
    """Render ``names`` as ``A, B, C`` with a ``, +N more`` overflow."""
    if not names:
        return ""
    shown = names[:cap]
    clause = ", ".join(shown)
    extra = len(names) - len(shown)
    if extra > 0:
        clause += f", +{extra} more"
    return clause


def _ts_short(ts: str | None) -> str:
    """Format an ISO timestamp to a short ``MM-DD HH:MM``; passthrough on fail."""
    if not ts:
        return "?"
    # Expect ISO 8601 like 2026-03-13T14:05:00.000-05:00
    try:
        date_part, _, time_part = ts.partition("T")
        mm_dd = "-".join(date_part.split("-")[1:3])  # MM-DD
        hh_mm = ":".join(time_part.split(":")[:2])  # HH:MM
        if mm_dd and hh_mm:
            return f"{mm_dd} {hh_mm}"
    except Exception:
        pass
    return ts


# --------------------------------------------------------------------------- #
# comms_read
# --------------------------------------------------------------------------- #
def summarize_read(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_read`` result dict.

    Shape: ``{conversation, messages[], count, has_more}``. Each message may
    carry ``directed_at_me``.
    """
    if _is_error(result):
        return f"⚠️ read failed: {result.get('message', 'unknown error')}"

    conv = result.get("conversation", "?")
    messages = result.get("messages") or []
    count = result.get("count", len(messages))
    has_more = result.get("has_more", False)

    if count == 0:
        return f"\U0001f4ed no new messages in #{conv}"

    directed = sum(1 for m in messages if m.get("directed_at_me"))

    # Unique sender names in chronological order, first 3.
    seen: list[str] = []
    for m in messages:
        name = _sender_name(m)
        if name not in seen:
            seen.append(name)
    senders_clause = _names_clause(seen)

    line1 = f"\U0001f4e8 {count} {_plural(count)} in #{conv}"
    if directed:
        line1 += f" ({directed} for you)"
    if senders_clause:
        line1 += f" from {senders_clause}"

    latest = messages[-1]
    last_clause = f'last: {_sender_name(latest)}: "{_truncate(latest.get("body", ""))}"'
    if has_more:
        last_clause += " (+more older)"

    return f"{line1}\n{last_clause}"


# --------------------------------------------------------------------------- #
# comms_history
# --------------------------------------------------------------------------- #
def summarize_history(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_history`` result dict.

    Shape: ``{conversation, query, messages[], count, has_more}``.
    """
    if _is_error(result):
        return f"⚠️ history failed: {result.get('message', 'unknown error')}"

    conv = result.get("conversation", "?")
    query = result.get("query")
    messages = result.get("messages") or []
    count = result.get("count", len(messages))
    has_more = result.get("has_more", False)

    if count == 0:
        if query:
            return f'\U0001f5d2️ no matches for "{query}" in #{conv}'
        return f"\U0001f5d2️ no messages in #{conv}"

    oldest = _ts_short(messages[0].get("ts"))
    newest = _ts_short(messages[-1].get("ts"))
    participants = len({_sender_name(m) for m in messages})

    line = f"\U0001f5d2️ {count} {_plural(count)} in #{conv}"
    if query:
        line += f' matching "{query}"'
    line += (
        f", {oldest}..{newest}, {participants} {_plural(participants, 'participant')}"
    )
    if has_more:
        line += " (+older)"
    return line


# --------------------------------------------------------------------------- #
# comms_members
# --------------------------------------------------------------------------- #
def summarize_members(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_members`` result dict.

    Shape: ``{conversation, members[], count}``; each member has
    ``name`` and ``online``.
    """
    if _is_error(result):
        return f"⚠️ members failed: {result.get('message', 'unknown error')}"

    conv = result.get("conversation", "?")
    members = result.get("members") or []
    total = result.get("count", len(members))

    if total == 0:
        return f"\U0001f465 #{conv} has no members"

    online = sum(1 for m in members if m.get("online"))
    # Online first, then offline, for the name preview.
    ordered = sorted(members, key=lambda m: not m.get("online"))
    names = [m.get("name") or m.get("key") or "?" for m in ordered]

    if total <= 3:
        names_clause = ", ".join(names)
    else:
        names_clause = _names_clause(names, cap=2)

    return f"\U0001f465 {online} online / {total} total in #{conv}: {names_clause}"


# --------------------------------------------------------------------------- #
# comms_check
# --------------------------------------------------------------------------- #
def summarize_check(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_check`` result dict.

    Shape: ``{total_unread, conversations[]}`` where each conv has
    ``{conversation, unread_count, latest, thread_unread?}``.
    """
    if _is_error(result):
        return f"⚠️ check failed: {result.get('message', 'unknown error')}"

    total_unread = result.get("total_unread", 0)
    convs = result.get("conversations") or []

    thread_replies = 0
    for c in convs:
        thread_replies += sum((c.get("thread_unread") or {}).values())

    if total_unread == 0 and thread_replies == 0:
        return "\U0001f514 all caught up (0 unread)"

    convs_with_unread = [c for c in convs if c.get("unread_count", 0) > 0]
    n_convs = len(convs_with_unread)

    line = (
        f"\U0001f514 {total_unread} unread across {n_convs} {_plural(n_convs, 'conv')}"
    )
    if thread_replies:
        line += f", {thread_replies} thread {_plural(thread_replies, 'reply')}"

    if convs_with_unread:
        top = max(convs_with_unread, key=lambda c: c.get("unread_count", 0))
        line += f" (top: #{top.get('conversation', '?')} {top.get('unread_count', 0)})"
    return line


# --------------------------------------------------------------------------- #
# comms_send
# --------------------------------------------------------------------------- #
def summarize_send(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_send`` result dict.

    Success shape: ``{status:'sent', id, conversation, recipients, mentions,
    recipient_names, mention_names, reply_to}``. Errors stay LOUD.
    """
    # Errors come in two shapes: the _error() dict {error:True,message} or the
    # archived-guard dict {error:'conversation_archived', message?}. Either way,
    # surface loudly and never collapse them away. Any non-"sent" status is also
    # treated as a failure.
    if result.get("error") or result.get("status") != "sent":
        msg = result.get("message") or result.get("error") or "unknown error"
        return f"⚠️ send failed: {msg}"

    conv = result.get("conversation", "?")
    line = f"✅ sent to #{conv}"

    if result.get("reply_to"):
        line += " as reply"

    recipient_names = result.get("recipient_names")
    if recipient_names:
        line += f" · whisper to {_names_clause(recipient_names)}"

    mention_names = result.get("mention_names")
    if mention_names:
        line += f" · @{_names_clause(mention_names)}"

    return line
