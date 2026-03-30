"""Participant list sidebar widget with presence indicators.

Shows online participants with green dots, recently-seen with amber,
and offline with gray. Sorted: online first, then offline.

Uses a connection-aware model: one entry per user key, with a
``connections`` sub-dict keyed by ``{client}-{instanceId}``.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Label, Static

# Short labels shown next to participant names for each connection type.
CONNECTION_LABELS: dict[str, str] = {
    "web": "[W]",
    "tui": "[T]",
    "mcp": "[M]",
    "cli": "[C]",
    "api": "[A]",
}


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
    """A single participant entry with presence dot and connection indicators."""

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
        connections: dict[str, dict[str, Any]] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.participant_key = participant_key
        self.participant_name = name
        self.participant_type = participant_type
        self.connections: dict[str, dict[str, Any]] = connections or {}
        self._label = Label("")

    def compose(self) -> ComposeResult:
        yield self._label

    def on_mount(self) -> None:
        self._refresh_display()

    def watch_presence(self, state: PresenceState) -> None:
        self.set_class(state == PresenceState.OFFLINE, "--offline")
        self._refresh_display()

    def _refresh_display(self) -> None:
        """Update the label with presence dot, name, and connection indicators."""
        state = self.presence
        type_icon = "\U0001f916" if self.participant_type == "claude" else "\U0001f464"

        # Build connection indicator string from unique client types
        client_types: set[str] = set()
        for conn_info in self.connections.values():
            ct = conn_info.get("client", "")
            if ct:
                client_types.add(ct)

        conn_labels = " ".join(
            CONNECTION_LABELS.get(ct, "")
            for ct in sorted(client_types)
            if ct in CONNECTION_LABELS
        )
        conn_suffix = f" [dim]{conn_labels}[/]" if conn_labels else ""

        self._label.update(
            f"[{state.color}]{state.dot}[/] {type_icon} {self.participant_name}{conn_suffix}"
        )


class ParticipantList(Vertical):
    """Right sidebar showing participants with presence dots.

    Internal data model: ``_items`` is keyed by **user key** (not composite).
    Each ``ParticipantItem`` carries a ``connections`` dict for multi-device
    awareness.
    """

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

    # -----------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------

    def set_participant(
        self,
        key: str,
        name: str,
        participant_type: str = "claude",
        presence: PresenceState = PresenceState.OFFLINE,
        client_type: str = "unknown",
        connection_key: str | None = None,
        connection_info: dict[str, Any] | None = None,
    ) -> None:
        """Add or update a participant (keyed by *user* key).

        If *connection_key* and *connection_info* are supplied they are
        merged into the participant's ``connections`` dict.  For backward
        compatibility the old ``client_type`` parameter is still accepted
        and will create a bare connection entry when no explicit connection
        info is provided.
        """
        if key in self._items:
            item = self._items[key]
            item.participant_name = name
            item.participant_type = participant_type
            if connection_key and connection_info:
                item.connections[connection_key] = connection_info
            elif client_type and client_type != "unknown" and not connection_key:
                # Legacy: create a simple connection entry from client_type
                if not any(
                    c.get("client") == client_type for c in item.connections.values()
                ):
                    item.connections[client_type] = {"client": client_type}
            item.presence = presence
            item._refresh_display()
        else:
            connections: dict[str, dict[str, Any]] = {}
            if connection_key and connection_info:
                connections[connection_key] = connection_info
            elif client_type and client_type != "unknown":
                connections[client_type] = {"client": client_type}

            item = ParticipantItem(
                participant_key=key,
                name=name,
                participant_type=participant_type,
                connections=connections,
            )
            item.presence = presence
            self._items[key] = item
            self.mount(item)

    def remove_connection(self, key: str, connection_key: str) -> None:
        """Remove a single connection from a participant.

        If the participant has no remaining connections, remove them from
        the list entirely.
        """
        if key not in self._items:
            return
        item = self._items[key]
        item.connections.pop(connection_key, None)
        if not item.connections:
            item.remove()
            del self._items[key]
        else:
            item._refresh_display()

    def update_presence(self, key: str, state: PresenceState) -> None:
        """Update a participant's presence state."""
        if key in self._items:
            self._items[key].presence = state

    def remove_participant(self, key: str) -> None:
        """Remove a participant from the list entirely."""
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
        """Return name -> key mapping (for mention resolution).

        Keys are now the bare user key (not composite).
        """
        return {
            item.participant_name: item.participant_key
            for item in self._items.values()
        }
