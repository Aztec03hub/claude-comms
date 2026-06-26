"""Claude Comms TUI — Textual-based terminal chat client.

Provides a three-column layout (channels | chat | participants) with
real-time MQTT messaging, @mention autocomplete, and Rich formatting.

Launch via ``claude-comms tui`` or ``python -m claude_comms.tui``.
"""

from typing import TYPE_CHECKING

__all__ = ["ClaudeCommsApp", "run"]

if TYPE_CHECKING:
    # Re-exported lazily via ``__getattr__`` below so importing this package
    # does not pull in ``textual`` (an optional dependency). The
    # TYPE_CHECKING import gives type checkers the symbol named in __all__
    # without triggering the runtime import.
    from claude_comms.tui.app import ClaudeCommsApp


def __getattr__(name: str) -> object:
    """Lazily resolve ``ClaudeCommsApp`` to avoid importing textual eagerly."""
    if name == "ClaudeCommsApp":
        from claude_comms.tui.app import ClaudeCommsApp

        return ClaudeCommsApp
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def run() -> None:
    """Entry point for ``claude-comms tui`` CLI command."""
    from claude_comms.tui.app import ClaudeCommsApp

    app = ClaudeCommsApp()
    app.run()
