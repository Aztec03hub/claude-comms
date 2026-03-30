"""Claude Comms TUI — Textual-based terminal chat client.

Provides a three-column layout (channels | chat | participants) with
real-time MQTT messaging, @mention autocomplete, and Rich formatting.

Launch via ``claude-comms tui`` or ``python -m claude_comms.tui``.
"""

__all__ = ["ClaudeCommsApp"]


def run() -> None:
    """Entry point for ``claude-comms tui`` CLI command."""
    from claude_comms.tui.app import ClaudeCommsApp

    app = ClaudeCommsApp()
    app.run()
