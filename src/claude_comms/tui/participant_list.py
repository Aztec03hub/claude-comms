"""Participant list sidebar widget with presence indicators.

Shows online participants with green dots, recently-seen with amber,
and offline with gray. Sorted: online first, then offline.
"""

from __future__ import annotations

from enum import Enum

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Label, Static


class PresenceState(Enum):
    """Participant presence states with display properties."""

    ONLINE = ("online", "\u2022", "#34d399")  # green dot
    AWAY = ("away", "\u2022", "#fbbf24")  # amber dot
    OFFLINE = ("offline", "\u2022", "#555555")  # gray dot

    def __init__(self, label: str, dot: str, color: str) -> None:
        self.label = label
        self.dot = dot
        self.color = color


class ParticipantItem(Widget):
    """A single participant entry with presence dot."""

    DEFAULT_CSS = """
    ParticipantItem {
        height: 1;
        padding: 0 1;
        layout: horizontal;
        color: #e8e4df;
    }
    ParticipantItem.--offline {
        color: #8a8a8a;
    }
    """

    presence: reactive[PresenceState] = reactive(PresenceState.OFFLINE)

    def __init__(
        self,
        participant_key: str,
        name: str,
        participant_type: str = "claude",
        client_type: str = "unknown",
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.participant_key = participant_key
        self.participant_name = name
        self.participant_type = participant_type
        self.client_type = client_type
        self._label = Label("")

    def compose(self) -> ComposeResult:
        yield self._label

    def on_mount(self) -> None:
        self._refresh_display()

    def watch_presence(self, state: PresenceState) -> None:
        self.set_class(state == PresenceState.OFFLINE, "--offline")
        self._refresh_display()

    def _refresh_display(self) -> None:
        """Update the label with presence dot, name, and client type."""
        state = self.presence
        type_icon = "\U0001f916" if self.participant_type == "claude" else "\U0001f464"
        client_label = (
            f" [dim]({self.client_type})[/]"
            if self.client_type and self.client_type != "unknown"
            else ""
        )
        self._label.update(
            f"[{state.color}]{state.dot}[/] {type_icon} {self.participant_name}{client_label}"
        )


class ParticipantList(Vertical):
    """Right sidebar showing participants with presence dots."""

    DEFAULT_CSS = """
    ParticipantList {
        width: 22;
        dock: right;
        background: #1c1c1e;
        border-left: solid #2c2c2e;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._items: dict[str, ParticipantItem] = {}
        self._title = Static("Members", classes="sidebar-title")

    def compose(self) -> ComposeResult:
        yield self._title

    def set_participant(
        self,
        key: str,
        name: str,
        participant_type: str = "claude",
        presence: PresenceState = PresenceState.OFFLINE,
        client_type: str = "unknown",
    ) -> None:
        """Add or update a participant in the list."""
        if key in self._items:
            item = self._items[key]
            item.participant_name = name
            item.participant_type = participant_type
            item.client_type = client_type
            item.presence = presence
            item._refresh_display()
        else:
            item = ParticipantItem(
                participant_key=key,
                name=name,
                participant_type=participant_type,
                client_type=client_type,
            )
            item.presence = presence
            self._items[key] = item
            self.mount(item)

    def update_presence(self, key: str, state: PresenceState) -> None:
        """Update a participant's presence state."""
        if key in self._items:
            self._items[key].presence = state

    def remove_participant(self, key: str) -> None:
        """Remove a participant from the list."""
        if key in self._items:
            self._items[key].remove()
            del self._items[key]

    def clear_all(self) -> None:
        """Remove all participants (e.g., on channel switch)."""
        for item in self._items.values():
            item.remove()
        self._items.clear()

    def get_names(self) -> list[str]:
        """Return all participant display names (for autocomplete)."""
        return [item.participant_name for item in self._items.values()]

    def get_name_to_key(self) -> dict[str, str]:
        """Return name -> key mapping (for mention resolution)."""
        return {
            item.participant_name: item.participant_key for item in self._items.values()
        }
