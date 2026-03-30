"""Message input widget with @mention Tab completion.

When the user types ``@`` followed by characters, Tab cycles through
matching participant names. Enter submits the message, Shift+Enter
inserts a newline.
"""

from __future__ import annotations

import re
from typing import Callable

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.events import Key
from textual.message import Message as TMessage
from textual.widgets import TextArea


class MessageSubmitted(TMessage):
    """Posted when the user submits a message (Enter key)."""

    def __init__(self, body: str) -> None:
        super().__init__()
        self.body = body


# Pattern to find an in-progress @mention at the cursor position
_MENTION_PARTIAL = re.compile(r"@([\w-]*)$")


class MessageInput(Vertical):
    """Input area with @mention Tab completion.

    Provides a TextArea widget that supports multiline input via
    Shift+Enter. When the user types ``@abc`` and presses Tab, the
    partial is completed from the participant list. Pressing Tab
    again cycles to the next match. Enter (without Shift) submits.
    """

    DEFAULT_CSS = """
    MessageInput {
        height: auto;
        max-height: 6;
        dock: bottom;
        background: #1c1c1e;
        border-top: solid #2c2c2e;
        padding: 0 1;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._name_provider: Callable[[], list[str]] | None = None
        self._completions: list[str] = []
        self._completion_index: int = 0
        self._last_partial: str = ""
        self._input = TextArea(
            id="message-input",
            language=None,
            soft_wrap=True,
            show_line_numbers=False,
            tab_behavior="focus",
        )

    def compose(self) -> ComposeResult:
        yield self._input

    def set_name_provider(self, provider: Callable[[], list[str]]) -> None:
        """Set a callable that returns current participant names."""
        self._name_provider = provider

    def _get_text(self) -> str:
        """Get the current text from the TextArea."""
        return self._input.text

    def _set_text(self, value: str) -> None:
        """Set the TextArea text content."""
        self._input.clear()
        self._input.insert(value)

    def on_key(self, event: Key) -> None:
        """Handle Enter (submit), Shift+Enter (newline), and Tab (completion)."""
        if event.key == "enter":
            # Plain Enter submits the message
            event.prevent_default()
            event.stop()
            body = self._get_text().strip()
            if body:
                self.post_message(MessageSubmitted(body))
                self._input.clear()
                self._reset_completions()
            return

        if event.key == "shift+enter":
            # Shift+Enter inserts a newline (default TextArea behavior)
            return

        if event.key == "tab":
            # Only handle Tab if focused on the input
            if not self._input.has_focus:
                return

            event.prevent_default()
            event.stop()

            value = self._get_text()
            # TextArea cursor is (row, col) — get linear position
            row, col = self._input.cursor_location
            lines = value.split("\n")
            cursor = sum(len(lines[i]) + 1 for i in range(row)) + col

            # Find partial @mention before cursor
            text_before_cursor = value[:cursor]
            match = _MENTION_PARTIAL.search(text_before_cursor)
            if not match:
                return

            partial = match.group(1).lower()
            prefix_start = match.start()

            # Get available names
            names = self._name_provider() if self._name_provider else []
            if not names:
                return

            # Filter matches
            if partial != self._last_partial:
                self._completions = [n for n in names if n.lower().startswith(partial)]
                if not self._completions:
                    self._completions = list(names)
                self._completion_index = 0
                self._last_partial = partial
            else:
                self._completion_index = (
                    (self._completion_index + 1) % len(self._completions)
                    if self._completions
                    else 0
                )

            if not self._completions:
                return

            # Apply completion
            completed_name = self._completions[self._completion_index]
            new_text = value[:prefix_start] + f"@{completed_name}" + value[cursor:]
            self._set_text(new_text)
            return

        # Reset completions on any other key
        self._reset_completions()

    def _reset_completions(self) -> None:
        """Clear the completion state."""
        self._completions = []
        self._completion_index = 0
        self._last_partial = ""

    def focus_input(self) -> None:
        """Programmatically focus the input."""
        self._input.focus()
