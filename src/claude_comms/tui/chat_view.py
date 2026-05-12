"""Chat view widget — scrollable message display with Rich formatting.

Renders messages as Rich Panels with sender-colored borders, timestamps
in "Today at 2:36 PM" format, and syntax-highlighted code blocks.
System messages (join/leave) appear as centered dim text with a distinct style.

Mention rendering (Phase E of mentions-vs-whisper-separation plan):
``MessageBubble`` classifies each ``@<name>`` token in the post-strip body
into one of four segment types — ``plain``, ``mention-self``,
``mention-other``, or ``mention-legacy`` — using the same algorithm as
the web side (`MessageBubble.svelte:parseBody`). Bold + amber highlights
self-mentions, dim renders other-mentions, and a quiet ember tone covers
the legacy/whisper/unkeyed-mention bucket. A ``▎`` left-margin glyph
plus a thicker amber border accents bubbles where the viewer is
mentioned. Whisper bubbles get a distinct minimal-border + ``[whisper]``
prefix style.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Callable

from rich import box
from rich.panel import Panel
from rich.syntax import Syntax
from rich.text import Text
from textual.reactive import reactive
from textual.widgets import Static
from textual.containers import VerticalScroll

if TYPE_CHECKING:
    from claude_comms.message import Message

# Carbon Ember sender color palette — cycled per participant key
SENDER_COLORS = [
    "#d97706",  # ember/amber (primary accent)
    "#fbbf24",  # gold
    "#2dd4bf",  # teal
    "#fb7185",  # rose
    "#34d399",  # emerald
    "#60a5fa",  # sky blue
    "#a78bfa",  # violet
    "#f472b6",  # pink
    "#f59e0b",  # bright amber
    "#38bdf8",  # light blue
    "#c084fc",  # purple
    "#4ade80",  # green
]

# Mention-segment style tokens (Phase E parity with web's CSS tokens).
# Loud self-mention — bold + saturated amber. Mirrors web's
# `--mention-self-bg/-fg`.
MENTION_SELF_STYLE = "bold #fbbf24"
# Quiet other-mention — softer amber (regular weight, ember-500). Mirrors
# web's `--mention-other-bg/-fg`. Same color family as self-mention but
# at lower saturation; differentiation is weight + alpha, not hue.
MENTION_OTHER_STYLE = "#f59e0b"
# Legacy mention — quiet ember tone (chip-but-not-loud). Mirrors web's
# legacy `.mention` chip (used for whispers, sender-self downgrade, and
# pre-cutover messages with no `mentions` field).
MENTION_LEGACY_STYLE = "#d97706"

# Self-mention bubble accent — amber border, drives the "▎" left-margin
# semantic equivalent of web's `.has-self-mention` 3px amber border.
SELF_MENTION_ACCENT_COLOR = "#fbbf24"

# Whisper bubble styling tokens
WHISPER_BORDER_COLOR = "#6a6a6a"
WHISPER_LABEL_STYLE = "italic #8a8a8a"

# Pattern matching the same ``[@name1, @name2] `` server-prefix that
# `mention.MENTION_PATTERN` matches and that web's `parseMentions` strips
# before tokenizing. Single source of truth for the strip behavior here.
_BRACKET_PREFIX_RE = re.compile(r"^\[(@[\w-]+(?:\s*,\s*@[\w-]+)*)\]\s*")

# Pattern for splitting body text into mention vs plain runs. Mirrors
# web `parseMentions` body-tokenizer: an ``@<name>`` only matches at the
# start, after whitespace, or after another ``@`` so that ``email@host``
# is not picked up.
_MENTION_TOKEN_RE = re.compile(r"(?:^|(?<=[\s@]))@[\w-]+")


def _color_for_key(sender_key: str) -> str:
    """Return a deterministic color from the palette for a sender key."""
    idx = int(hashlib.md5(sender_key.encode()).hexdigest()[:8], 16)
    return SENDER_COLORS[idx % len(SENDER_COLORS)]


def _format_timestamp(iso_ts: str) -> str:
    """Format an ISO 8601 timestamp as 'Today at 2:36 PM' or date string.

    Falls back to the raw string on parse errors.
    """
    try:
        dt = datetime.fromisoformat(iso_ts)
    except (ValueError, TypeError):
        return iso_ts

    now = datetime.now(timezone.utc).astimezone()
    local_dt = dt.astimezone()

    if local_dt.date() == now.date():
        prefix = "Today"
    else:
        prefix = local_dt.strftime("%b %d")

    time_str = local_dt.strftime("%-I:%M %p")
    return f"{prefix} at {time_str}"


def _extract_code_blocks(body: str) -> list[tuple[str, str | None, str]]:
    """Split message body into segments of (type, lang, content).

    Returns a list of tuples:
      - ("text", None, "plain text content")
      - ("code", "python", "code content")  (lang may be empty string)
    """
    parts: list[tuple[str, str | None, str]] = []
    pattern = re.compile(r"```(\w*)\n(.*?)```", re.DOTALL)
    last_end = 0

    for match in pattern.finditer(body):
        # Text before this code block
        before = body[last_end : match.start()]
        if before.strip():
            parts.append(("text", None, before.strip()))
        lang = match.group(1) or "text"
        code = match.group(2).rstrip("\n")
        parts.append(("code", lang, code))
        last_end = match.end()

    # Remaining text after last code block
    remaining = body[last_end:]
    if remaining.strip():
        parts.append(("text", None, remaining.strip()))

    # If nothing was parsed, treat whole body as text
    if not parts:
        parts.append(("text", None, body))

    return parts


def classify_mention_segments(
    body: str,
    *,
    mentions: list[str] | None,
    recipients: list[str] | None,
    name_to_key: dict[str, str] | None,
    viewer_key: str | None,
    sender_key: str | None,
) -> list[tuple[str, str]]:
    """Split *body* into a sequence of styled segments.

    Returns a list of ``(kind, text)`` tuples where ``kind`` is one of
    ``"plain"``, ``"mention-self"``, ``"mention-other"``, or
    ``"mention-legacy"``.

    Algorithm parity with web's
    ``MessageBubble.svelte:parseBody`` (Phase D):

    1. Strip the leading ``[@name1, @name2] `` server prefix (mirrors
       web's ``parseMentions`` strip in ``utils.js``).
    2. Tokenize the post-strip body for ``@<name>`` patterns using the
       same precedence rules as web (start / whitespace / another ``@``).
    3. For each ``@<name>`` token, look up the participant key via
       ``name_to_key`` (case-insensitive). If unresolved, emit ``plain``.
    4. With a resolved key, classify against four cases:

       * ``mentions`` empty/null OR ``recipients`` non-empty (whisper-gate)
         → ``mention-legacy`` (quiet ember chip).
       * key ∈ ``mentions`` AND key === viewer_key AND viewer ≠ sender
         → ``mention-self`` (loud, bold-amber).
       * key ∈ ``mentions`` AND key === viewer_key AND viewer === sender
         → ``mention-legacy`` (sender-self downgrade — don't loudly
         self-notify on your own bubble).
       * key ∈ ``mentions`` AND key ≠ viewer_key
         → ``mention-other`` (quiet grey).
       * key ∉ ``mentions``
         → ``mention-legacy`` (legacy / unkeyed slot).

    Parameters
    ----------
    body :
        The raw message body, including any server-injected
        ``[@name1, @name2] `` prefix.
    mentions :
        Wire-format ``Message.mentions`` value (list of 8-hex keys, or
        ``None``).
    recipients :
        Wire-format ``Message.recipients`` value (list of 8-hex keys, or
        ``None``). Drives the whisper-gate.
    name_to_key :
        Case-insensitive name → key mapping (callers should pass the
        live participant snapshot).
    viewer_key :
        The viewer's own 8-hex participant key (the running TUI session).
    sender_key :
        ``Message.sender.key``, used for the sender-self special case.
    """
    # Step 1: prefix strip (single source of truth — mirrors web).
    stripped = _BRACKET_PREFIX_RE.sub("", body)

    # Build a case-insensitive name→key lookup.
    nk: dict[str, str] = {}
    if name_to_key:
        for name, key in name_to_key.items():
            if isinstance(name, str) and isinstance(key, str):
                nk[name.lower()] = key

    # Whisper-gate (per §6.3 R2-C1 + §10 Test #4): when `recipients` is
    # non-empty, suppress self/other classification; body-side @name
    # tokens render as legacy chips. Self/other is a mention-only
    # treatment.
    is_whisper = bool(recipients)
    mentions_active = bool(mentions) and not is_whisper
    mentions_set = set(mentions) if mentions_active and mentions else set()
    viewer_is_sender = (
        viewer_key is not None and sender_key is not None and viewer_key == sender_key
    )

    segments: list[tuple[str, str]] = []
    last_end = 0
    for match in _MENTION_TOKEN_RE.finditer(stripped):
        if match.start() > last_end:
            segments.append(("plain", stripped[last_end : match.start()]))
        token = match.group(0)  # includes the leading "@"
        candidate_name = token[1:].lower() if token.startswith("@") else token.lower()
        resolved_key = nk.get(candidate_name)
        if resolved_key is None:
            # Unknown participant — render as plain text. Matches web's
            # `parseMentions` validation behaviour at MessageBubble.svelte
            # (unresolved names fall through to plain).
            segments.append(("plain", token))
        elif mentions_active and resolved_key in mentions_set:
            if resolved_key == viewer_key:
                if viewer_is_sender:
                    # Sender-self downgrade.
                    segments.append(("mention-legacy", token))
                else:
                    segments.append(("mention-self", token))
            else:
                segments.append(("mention-other", token))
        else:
            # mentions-inactive (whisper / legacy / no-mentions-field) OR
            # key not in mentions — legacy slot.
            segments.append(("mention-legacy", token))
        last_end = match.end()

    if last_end < len(stripped):
        segments.append(("plain", stripped[last_end:]))

    # Coalesce adjacent plain segments (cosmetic — mirrors web's coalesce).
    coalesced: list[tuple[str, str]] = []
    for seg in segments:
        if coalesced and coalesced[-1][0] == "plain" and seg[0] == "plain":
            coalesced[-1] = ("plain", coalesced[-1][1] + seg[1])
        else:
            coalesced.append(seg)
    return coalesced


def _render_segments_as_text(
    segments: list[tuple[str, str]],
    *,
    self_accent: bool = False,
) -> Text:
    """Render a classified-segment list as a styled Rich Text object.

    Style tokens are the module-level ``MENTION_*_STYLE`` constants. When
    ``self_accent`` is True (i.e. at least one segment is
    ``mention-self`` and we are at the body's top level — see
    ``_render_text_with_mentions``), the ``▎`` self-accent glyph is
    prepended in the loud amber style, mirroring web's
    ``.has-self-mention`` 3px amber border.
    """
    result = Text()
    if self_accent:
        result.append("▎ ", style=MENTION_SELF_STYLE)  # `▎ `
    for kind, value in segments:
        if kind == "mention-self":
            result.append(value, style=MENTION_SELF_STYLE)
        elif kind == "mention-other":
            result.append(value, style=MENTION_OTHER_STYLE)
        elif kind == "mention-legacy":
            result.append(value, style=MENTION_LEGACY_STYLE)
        else:
            result.append(value)
    return result


def _name_to_key_from_participants(
    participants: dict | list | None,
) -> dict[str, str]:
    """Coerce a participants map / list into the case-folded name→key dict
    the classifier expects.

    Accepts:
    * ``dict[key, {name, key, ...}]`` — the canonical web-style participants
      map (also used in the TUI Round 15 tests).
    * ``dict[name, key]`` — the legacy ``ParticipantList.get_name_to_key()``
      shape; passed through unchanged.
    * ``list[{name, key, ...}]`` — pass-through.
    * ``None`` — empty mapping.
    """
    if not participants:
        return {}
    if isinstance(participants, dict):
        # Detect the dict-of-dicts (key→info) shape vs the flat name→key
        # shape by peeking at one value.
        try:
            sample = next(iter(participants.values()))
        except StopIteration:
            return {}
        if isinstance(sample, dict):
            out: dict[str, str] = {}
            for entry in participants.values():
                name = entry.get("name") if isinstance(entry, dict) else None
                key = entry.get("key") if isinstance(entry, dict) else None
                if isinstance(name, str) and isinstance(key, str):
                    out[name] = key
            return out
        return dict(participants)  # already name→key
    # List / iterable of {name, key, ...}
    out = {}
    for entry in participants:
        if isinstance(entry, dict):
            name = entry.get("name")
            key = entry.get("key")
            if isinstance(name, str) and isinstance(key, str):
                out[name] = key
    return out


def _render_text_with_mentions(
    text: str,
    *,
    message: Message,
    viewer_key: str | None,
    participants: dict | list | None,
) -> Text:
    """Render *text* with @-mention classification spans (Phase E entrypoint).

    This is the public render-classifier entrypoint that ``MessageBubble``
    calls per body section. It mirrors the web side's
    ``MessageBubble.svelte:parseBody`` shape — the four-case algorithm
    in §6.3 lives in ``classify_mention_segments``; this function adapts
    the participants payload, classifies, and produces a Rich ``Text``
    with the appropriate styling spans.

    A ``▎`` self-accent glyph is prepended when any segment classifies
    as ``mention-self`` (i.e. viewer is mentioned and is not the
    sender). This is the line-level equivalent of web's
    ``.has-self-mention`` border accent.

    The ``Text`` return type is part of the Phase E test contract — see
    ``tests/test_tui.py::TestRound15TuiMentionRenderParity``.
    """
    name_to_key = _name_to_key_from_participants(participants)
    classified = classify_mention_segments(
        text,
        mentions=message.mentions,
        recipients=message.recipients,
        name_to_key=name_to_key,
        viewer_key=viewer_key,
        sender_key=message.sender.key,
    )
    self_accent = any(kind == "mention-self" for kind, _ in classified)
    return _render_segments_as_text(classified, self_accent=self_accent)


class MessageBubble(Static):
    """A single rendered message bubble.

    Render-classifier inputs (``viewer_key`` and ``name_to_key``) are
    resolved at construction time from ``ChatView``'s cached snapshot.
    See ``ChatView.add_message`` for the wiring.
    """

    def __init__(
        self,
        message: Message,
        *,
        viewer_key: str | None = None,
        name_to_key: dict[str, str] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._message = message
        self._viewer_key = viewer_key
        self._name_to_key = name_to_key or {}

    def render(self) -> Panel | Text:
        """Render the message as a Rich Panel with sender-colored border."""
        msg = self._message
        sender_color = _color_for_key(msg.sender.key)
        timestamp = _format_timestamp(msg.ts)

        # Whisper detection — drives bubble border + label. Gates on
        # `recipients` only (independent of `mentions`).
        is_whisper = bool(msg.recipients)

        # Classify body segments once so we can compute both the rendered
        # body and the self-mention bubble accent from the same data.
        # Code-block extraction is run first; classification only applies
        # to text segments. Self-mention may light up only inside text.
        body_renderable, has_self_mention = self._render_body(msg, is_whisper)

        # Sender type indicator
        type_icon = "\U0001f916" if msg.sender.type == "claude" else "\U0001f464"

        # Build header: "icon sender_name  timestamp [whisper]?"
        header = Text()
        header.append(f"{type_icon} ", style="")
        header.append(msg.sender.name, style=f"bold {sender_color}")
        header.append(f"  {timestamp}", style="dim #6a6a6a")
        if is_whisper:
            # Lock-glyph + label — terminal equivalent of web's
            # `.bubble-targeted` lock indicator.
            header.append("  \U0001f512 [whisper]", style=WHISPER_LABEL_STYLE)

        # Pick border style + color per the bubble "kind":
        #   - whisper → minimal box, muted color (terminal equivalent of
        #     web's dashed border + muted bg).
        #   - self-mention bubble → heavy box, amber accent (terminal
        #     equivalent of web's 3px amber border).
        #   - default broadcast → rounded sender-color border (existing).
        if is_whisper:
            border_style = WHISPER_BORDER_COLOR
            box_style = box.MINIMAL
        elif has_self_mention:
            border_style = SELF_MENTION_ACCENT_COLOR
            box_style = box.HEAVY
        else:
            border_style = sender_color
            box_style = box.ROUNDED

        return Panel(
            body_renderable,
            title=header,
            title_align="left",
            border_style=border_style,
            box=box_style,
            padding=(0, 1),
            expand=True,
        )

    # ------------------------------------------------------------------
    # Body rendering — classifies @-mention segments and composes Rich
    # renderables that respect existing code-block + multi-segment paths.
    # ------------------------------------------------------------------

    def _render_body(self, msg: Message, is_whisper: bool):
        """Render the body and return (renderable, has_self_mention).

        ``has_self_mention`` is True iff any text segment classified to
        ``mention-self``. It drives the bubble border accent. Whispers
        suppress self/other classification entirely (whisper-gate), so
        ``has_self_mention`` is always False on whisper bubbles by
        construction (the classifier returns no ``mention-self`` segments
        when ``recipients`` is non-empty).
        """
        sections = _extract_code_blocks(msg.body)

        any_self = False
        rendered: list = []
        for seg_type, lang, content in sections:
            if seg_type == "code":
                rendered.append(
                    Syntax(
                        content,
                        lang or "text",
                        theme="monokai",
                        line_numbers=False,
                        word_wrap=True,
                    )
                )
                continue
            # Classify once so we can decide self-accent placement.
            classified = classify_mention_segments(
                content,
                mentions=msg.mentions,
                recipients=msg.recipients,
                name_to_key=self._name_to_key,
                viewer_key=self._viewer_key,
                sender_key=msg.sender.key,
            )
            section_has_self = any(kind == "mention-self" for kind, _ in classified)
            # Only the FIRST text section that contains a self-mention
            # gets the `▎` glyph prepended — drawing it once per bubble
            # is the parity equivalent of the single web .has-self-mention
            # border accent. Subsequent text sections render their
            # mention-self spans loud without re-glyphing.
            self_accent_here = section_has_self and not any_self
            rendered.append(
                _render_segments_as_text(classified, self_accent=self_accent_here)
            )
            if section_has_self:
                any_self = True

        if len(rendered) == 1:
            return rendered[0], any_self
        from rich.console import Group

        return Group(*rendered), any_self


class SystemMessage(Static):
    """A system message (join/leave) displayed as centered dim text with a rule."""

    DEFAULT_CSS = """
    SystemMessage {
        text-align: center;
        color: #6a6a6a;
        text-style: italic;
        margin: 1 4;
        padding: 0 2;
    }
    """

    def __init__(self, text: str, **kwargs) -> None:
        super().__init__(text, **kwargs)


class EmptyChannelMessage(Static):
    """Placeholder shown when a channel has no messages yet."""

    DEFAULT_CSS = """
    EmptyChannelMessage {
        text-align: center;
        color: #6a6a6a;
        margin: 4 4;
        padding: 1 2;
    }
    """

    def __init__(self, conv_id: str, **kwargs) -> None:
        text = f"This is the beginning of # {conv_id}\nNo messages yet. Say hello!"
        super().__init__(text, **kwargs)


class ChatView(VerticalScroll):
    """Scrollable container for chat messages.

    Messages are appended as child widgets. New messages auto-scroll
    to the bottom unless the user has scrolled up.

    Render-classifier wiring (Phase E):
        ``ChatView`` caches the viewer's key and a callable that returns
        the live ``name_to_key`` snapshot. Each ``MessageBubble`` is
        constructed with these so the @-mention classifier (see
        ``classify_mention_segments``) can resolve names → keys and
        apply the self/other/legacy classification at render time.
    """

    DEFAULT_CSS = """
    ChatView {
        height: 1fr;
        background: #141416;
        padding: 0 1;
        scrollbar-color: #2c2c2e;
        scrollbar-color-hover: #d97706;
        scrollbar-color-active: #fbbf24;
    }
    """

    current_conv: reactive[str] = reactive("general")

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        # Track seen message IDs for client-side dedup
        self._seen_ids: set[str] = set()
        # Store messages per conversation
        self._messages: dict[str, list[Message]] = {}
        # Render-classifier context. ``app.py`` calls
        # ``set_render_context`` at startup once the viewer key is known
        # and the participant list is mounted. Until then we render with
        # an empty name_to_key (every @-token classified as plain).
        self._viewer_key: str | None = None
        self._name_to_key_provider: Callable[[], dict[str, str]] | None = None

    # ------------------------------------------------------------------
    # Render-classifier context wiring
    # ------------------------------------------------------------------

    def set_render_context(
        self,
        viewer_key: str | None,
        name_to_key_provider: Callable[[], dict[str, str]] | None,
    ) -> None:
        """Provide viewer-key + name→key snapshot accessor.

        Called by the parent app once at startup and again whenever the
        viewer's identity changes. ``name_to_key_provider`` is a
        zero-arg callable (e.g. ``ParticipantList.get_name_to_key``) so
        the snapshot stays live as participants come and go.
        """
        self._viewer_key = viewer_key
        self._name_to_key_provider = name_to_key_provider

    def _current_name_to_key(self) -> dict[str, str]:
        if self._name_to_key_provider is None:
            return {}
        try:
            return self._name_to_key_provider() or {}
        except Exception:
            return {}

    def _make_bubble(self, message: Message) -> MessageBubble:
        return MessageBubble(
            message,
            viewer_key=self._viewer_key,
            name_to_key=self._current_name_to_key(),
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add_message(self, message: Message) -> None:
        """Add a message to the view, deduplicating by ID."""
        if message.id in self._seen_ids:
            return
        self._seen_ids.add(message.id)

        # Store in per-conv history
        conv = message.conv
        if conv not in self._messages:
            self._messages[conv] = []
        self._messages[conv].append(message)

        # Only render if it's the active conversation
        if conv == self.current_conv:
            # Remove empty channel placeholder if present
            self.query(EmptyChannelMessage).remove()
            self._render_message(message)

    def add_system_message(self, text: str, conv: str | None = None) -> None:
        """Add a system notification (join/leave/info) to the view."""
        target_conv = conv or self.current_conv
        if target_conv == self.current_conv:
            self.mount(SystemMessage(text))
            self._auto_scroll()

    def switch_conversation(self, conv_id: str) -> None:
        """Switch the displayed conversation, re-rendering all messages."""
        self.current_conv = conv_id
        self._rebuild_view()

    def _render_message(self, message: Message) -> None:
        """Mount a single message bubble and auto-scroll."""
        self.mount(self._make_bubble(message))
        self._auto_scroll()

    def _rebuild_view(self) -> None:
        """Clear and re-render all messages for the current conversation."""
        self.query("MessageBubble, SystemMessage").remove()
        messages = self._messages.get(self.current_conv, [])
        if messages:
            for msg in messages:
                self.mount(self._make_bubble(msg))
        else:
            self.mount(EmptyChannelMessage(self.current_conv))
        self._auto_scroll()

    def _auto_scroll(self) -> None:
        """Scroll to bottom if user hasn't scrolled up."""
        # Simple approach: always scroll to end on new message
        self.call_after_refresh(self.scroll_end, animate=False)
