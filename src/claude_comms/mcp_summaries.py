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
    """True when *result* is an ``_error()``-shaped dict.

    Both error envelopes register as truthy: the standard
    ``{"error": True, "message": ...}`` and the string-discriminator shape
    ``{"error": "<reason>", ...}`` used by the conversation-lifecycle tools.
    """
    return bool(result.get("error"))


def _err_msg(result: dict[str, Any]) -> str:
    """Best-effort human reason from either error envelope.

    Prefers the ``message`` field; falls back to the ``error`` discriminator
    string (e.g. ``"not_authorized"``); finally a generic fallback.
    """
    msg = result.get("message")
    if msg:
        return str(msg)
    err = result.get("error")
    if isinstance(err, str) and err:
        return err
    return "unknown error"


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
    sender: dict[str, Any] = msg.get("sender") or {}
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
    messages: list[dict[str, Any]] = result.get("messages") or []
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
    messages: list[dict[str, Any]] = result.get("messages") or []
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
    members: list[dict[str, Any]] = result.get("members") or []
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
    convs: list[dict[str, Any]] = result.get("conversations") or []

    thread_replies = 0
    for c in convs:
        thread_unread: dict[str, int] = c.get("thread_unread") or {}
        thread_replies += sum(thread_unread.values())

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


def _short_id(msg_id: str | None, length: int = 8) -> str:
    """First *length* chars of a message/root id; ``?`` when missing."""
    if not msg_id:
        return "?"
    return str(msg_id)[:length]


# --------------------------------------------------------------------------- #
# comms_join
# --------------------------------------------------------------------------- #
def summarize_join(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_join`` result dict.

    Success shape: ``{key, name, type, conversation, status:'joined'}``.
    """
    if _is_error(result):
        return f"⚠️ join failed: {_err_msg(result)}"
    conv = result.get("conversation", "?")
    name = result.get("name", "?")
    key = result.get("key", "?")
    return f"✅ joined #{conv} as {name} ({key})"


# --------------------------------------------------------------------------- #
# comms_leave
# --------------------------------------------------------------------------- #
def summarize_leave(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_leave`` result dict.

    Shape: ``{status:'left'|'not_a_member', conversation}``.
    """
    if _is_error(result):
        return f"⚠️ leave failed: {_err_msg(result)}"
    conv = result.get("conversation", "?")
    if result.get("status") == "not_a_member":
        return f"\U0001f44b not a member of #{conv} (nothing to leave)"
    return f"\U0001f44b left #{conv}"


# --------------------------------------------------------------------------- #
# comms_update_name
# --------------------------------------------------------------------------- #
def summarize_update_name(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_update_name`` result dict.

    Success shape: ``{key, name, status:'updated'}``.
    """
    if _is_error(result):
        return f"⚠️ name update failed: {_err_msg(result)}"
    name = result.get("name", "?")
    return f"✏️ display name set to {name}"


# --------------------------------------------------------------------------- #
# comms_conversations
# --------------------------------------------------------------------------- #
def summarize_conversations(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_conversations`` result dict.

    Shape: ``{conversations:[{conversation, unread_count, total_messages}]}``
    and, when ``all=True``, an additional ``all_conversations`` list whose
    entries carry ``{name, archived, ...}``.
    """
    if _is_error(result):
        return f"⚠️ conversations failed: {_err_msg(result)}"

    convs: list[dict[str, Any]] = result.get("conversations") or []
    all_convs: list[dict[str, Any]] | None = result.get("all_conversations")

    if all_convs is not None:
        total = len(all_convs)
        archived = sum(1 for c in all_convs if c.get("archived"))
        names = [c.get("name") or "?" for c in all_convs]
    else:
        total = len(convs)
        archived = 0
        names = [c.get("conversation") or "?" for c in convs]

    if total == 0:
        return "\U0001f5c2 no conversations"

    line = (
        f"\U0001f5c2 {total} {_plural(total, 'conversation')}: {_names_clause(names)}"
    )
    if archived:
        line += f" ({archived} archived)"
    return line


# --------------------------------------------------------------------------- #
# comms_conversation_create
# --------------------------------------------------------------------------- #
def summarize_conversation_create(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_conversation_create`` result dict.

    Success shape: ``{status:'created', conversation, topic}``.
    """
    if _is_error(result):
        return f"⚠️ create failed: {_err_msg(result)}"
    conv = result.get("conversation", "?")
    return f"➕ created #{conv}"


# --------------------------------------------------------------------------- #
# comms_conversation_update
# --------------------------------------------------------------------------- #
def summarize_conversation_update(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_conversation_update`` result dict.

    Success shape: ``{status:'updated', conversation, updated_fields:[...]}``.
    """
    if _is_error(result):
        return f"⚠️ update failed: {_err_msg(result)}"
    conv = result.get("conversation", "?")
    fields: list[str] = result.get("updated_fields") or []
    if fields:
        return f"✏️ updated #{conv} ({', '.join(fields)})"
    return f"✏️ updated #{conv}"


# --------------------------------------------------------------------------- #
# comms_conversation_delete
# --------------------------------------------------------------------------- #
def summarize_conversation_delete(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_conversation_delete`` result dict.

    Success uses ``{deleted: True, conversation_id}``. ``confirm=False``
    pre-flight returns ``{error:'confirm_required', message_count, member_count}``
    which is surfaced as a pre-flight prompt, not a failure.
    """
    if result.get("error") == "confirm_required":
        msgs = result.get("message_count", 0)
        members = result.get("member_count", 0)
        return (
            f"❓ confirm delete: {msgs} {_plural(msgs)}, "
            f"{members} {_plural(members, 'member')} (re-call confirm=True)"
        )
    if _is_error(result) or not result.get("deleted"):
        return f"⚠️ delete failed: {_err_msg(result)}"
    conv = result.get("conversation_id", "?")
    return f"\U0001f5d1 deleted #{conv}"


# --------------------------------------------------------------------------- #
# comms_conversation_archive
# --------------------------------------------------------------------------- #
def summarize_conversation_archive(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_conversation_archive`` result dict.

    Success uses ``{archived: True, conversation_id, evicted_keys, ...}``.
    ``confirm=False`` returns ``{error:'confirm_required', ...}`` (pre-flight,
    not a failure); ``already_archived`` is a benign no-op.
    """
    if result.get("error") == "confirm_required":
        msgs = result.get("message_count", 0)
        members = result.get("member_count", 0)
        return (
            f"❓ confirm archive: ejects {members} "
            f"{_plural(members, 'member')}, {msgs} {_plural(msgs)} "
            "(re-call confirm=True)"
        )
    if _is_error(result):
        return f"⚠️ archive failed: {_err_msg(result)}"
    conv = result.get("conversation_id", "?")
    if result.get("status") == "already_archived":
        return f"\U0001f4e6 #{conv} already archived"
    if not result.get("archived"):
        return f"⚠️ archive failed: {_err_msg(result)}"
    evicted = len(result.get("evicted_keys") or [])
    line = f"\U0001f4e6 archived #{conv}"
    if evicted:
        line += f" ({evicted} {_plural(evicted, 'member')} ejected)"
    return line


# --------------------------------------------------------------------------- #
# comms_conversation_unarchive
# --------------------------------------------------------------------------- #
def summarize_conversation_unarchive(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_conversation_unarchive`` result dict.

    Success uses ``{archived: False, conversation_id}``; ``already_live`` is a
    benign no-op.
    """
    if _is_error(result):
        return f"⚠️ unarchive failed: {_err_msg(result)}"
    conv = result.get("conversation_id", "?")
    if result.get("status") == "already_live":
        return f"\U0001f4e4 #{conv} already live"
    return f"\U0001f4e4 unarchived #{conv}"


# --------------------------------------------------------------------------- #
# comms_invite
# --------------------------------------------------------------------------- #
def summarize_invite(result: dict[str, Any], target_name: str = "") -> str:
    """Summarize a ``tool_comms_invite`` result dict.

    Success shape: ``{status:'invited'|'already_member'}``. The result carries
    no name or conversation, so the wrapper passes ``target_name`` through.
    """
    if _is_error(result):
        return f"⚠️ invite failed: {_err_msg(result)}"
    who = target_name or "participant"
    if result.get("status") == "already_member":
        return f"\U0001f4e8 {who} is already a member"
    return f"\U0001f4e8 invited {who}"


# --------------------------------------------------------------------------- #
# comms_kick
# --------------------------------------------------------------------------- #
def summarize_kick(result: dict[str, Any], target_name: str = "") -> str:
    """Summarize a ``tool_comms_kick`` result dict.

    Success shape: ``{status:'kicked', target_key, conversation}``. The result
    carries no display name, so the wrapper passes ``target_name`` through.
    """
    if _is_error(result):
        return f"\U0001f6aa kick failed: {_err_msg(result)}"
    conv = result.get("conversation", "?")
    who = target_name or result.get("target_key") or "participant"
    return f"\U0001f6aa kicked {who} from #{conv}"


# --------------------------------------------------------------------------- #
# comms_dm_open
# --------------------------------------------------------------------------- #
def summarize_dm_open(result: dict[str, Any], target_name: str = "") -> str:
    """Summarize a ``tool_comms_dm_open`` result dict.

    Success shape: ``{status:'opened'|'existed', conversation}``.
    """
    if _is_error(result):
        return f"⚠️ DM open failed: {_err_msg(result)}"
    conv = result.get("conversation", "?")
    who = target_name or "participant"
    verb = "DM exists with" if result.get("status") == "existed" else "DM with"
    return f"\U0001f4ac {verb} {who} (#{conv})"


# --------------------------------------------------------------------------- #
# comms_artifact_create
# --------------------------------------------------------------------------- #
def summarize_artifact_create(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_artifact_create`` result dict.

    Success shape: ``{status:'created', name, title, version:1}``.
    """
    if _is_error(result):
        return f"⚠️ artifact create failed: {_err_msg(result)}"
    name = result.get("name", "?")
    version = result.get("version", 1)
    return f"\U0001f4c4 created artifact '{name}' v{version}"


# --------------------------------------------------------------------------- #
# comms_artifact_update
# --------------------------------------------------------------------------- #
def summarize_artifact_update(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_artifact_update`` result dict.

    Success shape: ``{status:'updated', name, version, ...}``. Version
    conflicts come back as ``{error:True, latest_version, latest_author}``.
    """
    if result.get("latest_version") is not None and _is_error(result):
        latest = result.get("latest_version")
        author = result.get("latest_author") or "?"
        return f"⚠️ artifact conflict: current is v{latest} (by {author}), re-read"
    if _is_error(result):
        return f"⚠️ artifact update failed: {_err_msg(result)}"
    name = result.get("name", "?")
    version = result.get("version", "?")
    return f"\U0001f4c4 '{name}' → v{version}"


# --------------------------------------------------------------------------- #
# comms_artifact_get
# --------------------------------------------------------------------------- #
def summarize_artifact_get(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_artifact_get`` result dict.

    Shape: ``{name, title, type, version, latest_version, versions:[...], ...}``;
    each ``versions[i]`` carries an ``author`` Sender dict.
    """
    if _is_error(result):
        return f"⚠️ artifact get failed: {_err_msg(result)}"
    name = result.get("name", "?")
    version = result.get("version", "?")
    versions: list[dict[str, Any]] = result.get("versions") or []
    n_versions = len(versions)
    author = "?"
    if versions:
        last: dict[str, Any] = versions[-1].get("author") or {}
        author = last.get("name") or last.get("key") or "?"
    return (
        f"\U0001f4c4 '{name}' v{version} "
        f"({n_versions} {_plural(n_versions, 'version')}) by {author}"
    )


# --------------------------------------------------------------------------- #
# comms_artifact_list
# --------------------------------------------------------------------------- #
def summarize_artifact_list(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_artifact_list`` result dict.

    Shape: ``{conversation, artifacts:[{name, ...}], count}``.
    """
    if _is_error(result):
        return f"⚠️ artifact list failed: {_err_msg(result)}"
    artifacts: list[dict[str, Any]] = result.get("artifacts") or []
    count = result.get("count", len(artifacts))
    if count == 0:
        conv = result.get("conversation", "?")
        return f"\U0001f4c4 no artifacts in #{conv}"
    names = [a.get("name") or "?" for a in artifacts]
    return f"\U0001f4c4 {count} {_plural(count, 'artifact')}: {_names_clause(names)}"


# --------------------------------------------------------------------------- #
# comms_artifact_delete
# --------------------------------------------------------------------------- #
def summarize_artifact_delete(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_artifact_delete`` result dict.

    Success shape: ``{status:'deleted', name}``.
    """
    if _is_error(result):
        return f"⚠️ artifact delete failed: {_err_msg(result)}"
    name = result.get("name", "?")
    return f"\U0001f5d1 deleted artifact '{name}'"


# --------------------------------------------------------------------------- #
# comms_react
# --------------------------------------------------------------------------- #
def summarize_react(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_react`` result dict.

    Status values: ``applied`` (with ``op`` add/remove), ``no_op``,
    ``throttled``, ``persisted_publish_failed`` (uses ``id`` not ``message_id``).
    """
    if _is_error(result) and result.get("status") != "persisted_publish_failed":
        return f"⚠️ react failed: {_err_msg(result)}"

    status = result.get("status")
    emoji = result.get("emoji", "?")
    msg_id = _short_id(result.get("message_id") or result.get("id"))

    if status == "throttled":
        return "⚠️ react throttled (rate limit)"
    if status == "no_op":
        return f"{emoji} no change on {msg_id}"
    if status == "persisted_publish_failed":
        op = result.get("op", "add")
        verb = "unreacted to" if op == "remove" else "reacted to"
        return f"{emoji} {verb} {msg_id} (saved, broadcast failed)"

    # applied
    op = result.get("op", "add")
    verb = "unreacted to" if op == "remove" else "reacted to"
    return f"{emoji} {verb} {msg_id}"


# --------------------------------------------------------------------------- #
# comms_reactions_get
# --------------------------------------------------------------------------- #
def summarize_reactions_get(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_reactions_get`` result dict.

    Shape: ``{conversation, message_id, reactions:{emoji:[actor_key,...]}}``.
    """
    if _is_error(result):
        return f"⚠️ reactions failed: {_err_msg(result)}"
    msg_id = _short_id(result.get("message_id"))
    reactions: dict[str, list[Any]] = result.get("reactions") or {}
    total = sum(len(actors) for actors in reactions.values())
    if total == 0:
        return f"\U0001f937 no reactions on {msg_id}"
    parts = [f"{emoji}x{len(actors)}" for emoji, actors in reactions.items()]
    clause = " ".join(parts[:5])
    if len(parts) > 5:
        clause += f" (+{len(parts) - 5} more)"
    return f"{total} {_plural(total, 'reaction')} on {msg_id}: {clause}"


# --------------------------------------------------------------------------- #
# comms_status_set / comms_status_clear (ephemeral activity)
# --------------------------------------------------------------------------- #
def summarize_status_set(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_status_set`` result dict.

    Success shape: ``{status:'set', label, ...}``; ``throttled`` is benign.
    """
    if _is_error(result):
        return f"⚠️ status failed: {_err_msg(result)}"
    if result.get("status") == "throttled":
        return "⚠️ status throttled (>1 update / 2s)"
    label = result.get("label", "?")
    return f"\U0001f7e2 status: {label}"


def summarize_status_clear(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_status_clear`` result dict.

    Success shape: ``{status:'cleared', count}``.
    """
    if _is_error(result):
        return f"⚠️ status clear failed: {_err_msg(result)}"
    return "⚪ status cleared"


# --------------------------------------------------------------------------- #
# comms_profile_status_set / comms_profile_status_clear (durable ornament)
# --------------------------------------------------------------------------- #
def summarize_profile_status_set(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_profile_status_set`` result dict.

    Success shape: ``{status:'set'|'cleared', emoji, text, ...}``; an all-None
    payload collapses to a clear.
    """
    if _is_error(result):
        return f"⚠️ profile status failed: {_err_msg(result)}"
    if result.get("status") == "cleared":
        return "⚪ profile status cleared"
    emoji = result.get("emoji")
    text = result.get("text")
    label = " ".join(p for p in (emoji, text) if p) or "(set)"
    return f"\U0001f7e2 profile status: {label}"


def summarize_profile_status_clear(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_profile_status_clear`` result dict.

    Success shape: ``{status:'cleared', ...}``.
    """
    if _is_error(result):
        return f"⚠️ profile status clear failed: {_err_msg(result)}"
    return "⚪ profile status cleared"


# --------------------------------------------------------------------------- #
# comms_get_channel_role
# --------------------------------------------------------------------------- #
def summarize_get_channel_role(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_get_channel_role`` result dict.

    Shape: ``{role, participant_key, conversation}``.
    """
    if _is_error(result):
        return f"⚠️ role lookup failed: {_err_msg(result)}"
    conv = result.get("conversation", "?")
    role = result.get("role", "member")
    return f"\U0001f3ad role in #{conv}: {role}"


# --------------------------------------------------------------------------- #
# comms_thread_read
# --------------------------------------------------------------------------- #
def summarize_thread_read(result: dict[str, Any]) -> str:
    """Summarize a ``tool_comms_thread_read`` result dict.

    Shape: ``{conversation, root, replies:[...], count, has_more}``; ``root``
    and each reply are message dicts (``sender``, ``body``, ``ts``, ``id``).
    """
    if _is_error(result):
        return f"⚠️ thread read failed: {_err_msg(result)}"

    root: dict[str, Any] = result.get("root") or {}
    root_id = _short_id(root.get("id"))
    replies: list[dict[str, Any]] = result.get("replies") or []
    count = result.get("count", len(replies))
    has_more = result.get("has_more", False)

    if count == 0:
        return f"\U0001f9f5 no replies under {root_id}"

    line1 = f"\U0001f9f5 {count} {_plural(count, 'reply')} under {root_id}"
    last = replies[-1]
    line2 = f'last: {_sender_name(last)}: "{_truncate(last.get("body", ""))}"'
    if has_more:
        line2 += " (+more)"
    return f"{line1}\n{line2}"
