"""Chat view widget — scrollable message display with Rich formatting.

Renders messages as Rich Panels with sender-colored borders, timestamps
in "Today at 2:36 PM" format, and syntax-highlighted code blocks.
System messages (join/leave) appear as centered dim text.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from rich.markup import escape
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
    "#34d399",  # emerald
    "#fbbf24",  # amber
    "#f59e0b",  # bright amber
    "#fb7185",  # rose
    "#60a5fa",  # sky blue
    "#a78bfa",  # violet
    "#f472b6",  # pink
    "#2dd4bf",  # teal
]


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
    import re

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


class MessageBubble(Static):
    """A single rendered message bubble."""

    def __init__(self, message: Message, **kwargs) -> None:
        super().__init__(**kwargs)
        self._message = message

    def render(self) -> Panel | Text:
        """Render the message as a Rich Panel with sender-colored border."""
        msg = self._message
        sender_color = _color_for_key(msg.sender.key)
        timestamp = _format_timestamp(msg.ts)

        # Build header: "sender_name  timestamp"
        header = Text()
        header.append(msg.sender.name, style=f"bold {sender_color}")
        header.append(f"  {timestamp}", style="dim")

        # Build body with code block support
        segments = _extract_code_blocks(msg.body)
        if len(segments) == 1 and segments[0][0] == "text":
            # Simple text message
            body_renderable = Text(segments[0][2])
        else:
            # Mixed content — use a group
            from rich.console import Group

            renderables = []
            for seg_type, lang, content in segments:
                if seg_type == "code":
                    renderables.append(
                        Syntax(
                            content,
                            lang or "text",
                            theme="monokai",
                            line_numbers=False,
                            word_wrap=True,
                        )
                    )
                else:
                    renderables.append(Text(content))
            body_renderable = Group(*renderables)

        return Panel(
            body_renderable,
            title=header,
            title_align="left",
            border_style=sender_color,
            padding=(0, 1),
            expand=True,
        )


class SystemMessage(Static):
    """A system message (join/leave) displayed as centered dim text."""

    DEFAULT_CSS = """
    SystemMessage {
        text-align: center;
        color: #8a8a8a;
        text-style: italic;
        margin: 1 4;
    }
    """

    def __init__(self, text: str, **kwargs) -> None:
        super().__init__(text, **kwargs)


class ChatView(VerticalScroll):
    """Scrollable container for chat messages.

    Messages are appended as child widgets. New messages auto-scroll
    to the bottom unless the user has scrolled up.
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
        self.mount(MessageBubble(message))
        self._auto_scroll()

    def _rebuild_view(self) -> None:
        """Clear and re-render all messages for the current conversation."""
        self.query("MessageBubble, SystemMessage").remove()
        messages = self._messages.get(self.current_conv, [])
        for msg in messages:
            self.mount(MessageBubble(msg))
        self._auto_scroll()

    def _auto_scroll(self) -> None:
        """Scroll to bottom if user hasn't scrolled up."""
        # Simple approach: always scroll to end on new message
        self.call_after_refresh(self.scroll_end, animate=False)
