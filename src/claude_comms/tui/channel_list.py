"""Channel list sidebar widget with unread badges.

Displays a vertical list of conversation channels. The active channel
is highlighted. Channels with unread messages show an amber badge count.
"""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.message import Message as TMessage
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Label, Static


class ChannelSelected(TMessage):
    """Posted when the user selects a channel."""

    def __init__(self, conv_id: str) -> None:
        super().__init__()
        self.conv_id = conv_id


class ChannelItem(Widget):
    """A single channel entry in the sidebar."""

    DEFAULT_CSS = """
    ChannelItem {
        height: 3;
        padding: 0 1;
        layout: horizontal;
        color: #8a8a8a;
        content-align: left middle;
    }
    ChannelItem:hover {
        background: #2c2c2e;
        color: #e8e4df;
    }
    ChannelItem.--active {
        background: #2c2c2e;
        color: #d97706;
        text-style: bold;
    }
    """

    is_active: reactive[bool] = reactive(False)
    unread_count: reactive[int] = reactive(0)

    def __init__(self, conv_id: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.conv_id = conv_id
        self._name_label = Label(f"# {conv_id}", classes="channel-name-label")
        self._badge = Label("", classes="unread-badge")

    def compose(self) -> ComposeResult:
        yield self._name_label
        yield self._badge

    def watch_is_active(self, active: bool) -> None:
        """Toggle the --active CSS class."""
        self.set_class(active, "--active")

    def watch_unread_count(self, count: int) -> None:
        """Update the unread badge display."""
        if count > 0:
            self._badge.update(str(count) if count < 100 else "99+")
            self._badge.display = True
        else:
            self._badge.update("")
            self._badge.display = False

    def on_click(self) -> None:
        """Post a ChannelSelected message when clicked."""
        self.post_message(ChannelSelected(self.conv_id))


class ChannelList(Vertical):
    """Sidebar listing all conversation channels."""

    DEFAULT_CSS = """
    ChannelList {
        width: 24;
        dock: left;
        background: #1c1c1e;
        border-right: solid #2c2c2e;
    }
    """

    active_channel: reactive[str] = reactive("general")

    def __init__(self, channels: list[str] | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._channels: list[str] = channels or ["general"]
        self._items: dict[str, ChannelItem] = {}

    def compose(self) -> ComposeResult:
        yield Static("Channels", classes="sidebar-title")
        for conv_id in self._channels:
            item = ChannelItem(conv_id)
            self._items[conv_id] = item
            yield item

    def on_mount(self) -> None:
        """Mark the initial active channel."""
        self._update_active()

    def watch_active_channel(self, conv_id: str) -> None:
        """Update visual state when active channel changes."""
        self._update_active()

    def _update_active(self) -> None:
        """Set is_active on the matching channel item."""
        for cid, item in self._items.items():
            item.is_active = cid == self.active_channel

    def add_channel(self, conv_id: str) -> None:
        """Add a new channel to the list if it doesn't exist."""
        if conv_id in self._items:
            return
        self._channels.append(conv_id)
        item = ChannelItem(conv_id)
        self._items[conv_id] = item
        self.mount(item)

    def increment_unread(self, conv_id: str) -> None:
        """Bump the unread count for a conversation."""
        if conv_id in self._items:
            self._items[conv_id].unread_count += 1

    def clear_unread(self, conv_id: str) -> None:
        """Reset the unread count (user switched to this channel)."""
        if conv_id in self._items:
            self._items[conv_id].unread_count = 0

    def on_channel_item_channel_selected(self, event: ChannelSelected) -> None:
        """Bubble channel selection up — handled by the app."""
        pass  # The message bubbles up to the app naturally
