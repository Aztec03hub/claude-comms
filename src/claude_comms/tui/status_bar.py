"""Status bar widget showing connection state, channel, participants, and typing.

Displayed at the bottom of the chat area, above the Textual Footer.
Shows: connection dot, active channel, participant count, typing indicator,
and the current user identity.
"""

from __future__ import annotations

import time

from rich.text import Text
from textual.reactive import reactive
from textual.widgets import Static


class StatusBar(Static):
    """Single-line status bar with connection info and typing indicators."""

    DEFAULT_CSS = """
    StatusBar {
        height: 1;
        background: #1a1a1c;
        color: #8a8a8a;
        padding: 0 1;
        dock: bottom;
        border-top: solid #2a2017;
    }
    """

    connected: reactive[bool] = reactive(False)
    active_channel: reactive[str] = reactive("general")
    participant_count: reactive[int] = reactive(0)
    typing_who: reactive[str] = reactive("")
    user_name: reactive[str] = reactive("")
    user_key: reactive[str] = reactive("")

    def render(self) -> Text:
        """Build the status bar content."""
        bar = Text()

        # Connection indicator
        if self.connected:
            bar.append(" \u2022 ", style="bold #34d399")
            bar.append("Connected", style="#34d399")
        else:
            bar.append(" \u2022 ", style="bold #fb7185")
            bar.append("Disconnected", style="#fb7185")

        bar.append("  \u2502  ", style="#2c2c2e")

        # Active channel
        bar.append("# ", style="#d97706")
        bar.append(self.active_channel, style="bold #e8e4df")

        bar.append("  \u2502  ", style="#2c2c2e")

        # Participant count
        bar.append(f"\U0001f465 {self.participant_count}", style="#8a8a8a")

        # Typing indicator
        if self.typing_who:
            bar.append("  \u2502  ", style="#2c2c2e")
            bar.append(f"\u270d {self.typing_who} is typing\u2026", style="italic #fbbf24")

        # Push user identity to the right with spacer
        # We approximate right-alignment with padding
        identity = f"{self.user_name} ({self.user_key})"
        # Calculate remaining space (approximate)
        current_len = bar.cell_len
        # Just append with some spacing
        bar.append("  ", style="")
        bar.append(identity, style="dim #6a6a6a")

        return bar

    def watch_connected(self, _value: bool) -> None:
        self.refresh()

    def watch_active_channel(self, _value: str) -> None:
        self.refresh()

    def watch_participant_count(self, _value: int) -> None:
        self.refresh()

    def watch_typing_who(self, _value: str) -> None:
        self.refresh()
