"""Channel list sidebar widget with unread badges and message previews.

Displays a vertical list of conversation channels. The active channel
is highlighted with a warm ember background. Channels with unread messages
show an amber badge count. Each channel shows a preview of the last message.
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
    """A single channel entry in the sidebar with unread badge and preview."""

    DEFAULT_CSS = """
    ChannelItem {
        height: auto;
        min-height: 2;
        max-height: 4;
        padding: 0 1;
        layout: vertical;
        color: #8a8a8a;
    }
    ChannelItem:hover {
        background: #262628;
        color: #e8e4df;
    }
    ChannelItem.--active {
        background: #2a2017;
        color: #d97706;
        text-style: bold;
    }
    ChannelItem.--muted {
        color: #555555;
    }
    """

    is_active: reactive[bool] = reactive(False)
    unread_count: reactive[int] = reactive(0)
    is_muted: reactive[bool] = reactive(False)

    def __init__(self, conv_id: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.conv_id = conv_id
        self._header_label = Label("", classes="channel-header-row")
        self._preview_label = Label("", classes="channel-preview")

    def compose(self) -> ComposeResult:
        yield self._header_label
        yield self._preview_label

    def on_mount(self) -> None:
        self._refresh_header()
        self._preview_label.display = False

    def watch_is_active(self, active: bool) -> None:
        """Toggle the --active CSS class."""
        self.set_class(active, "--active")

    def watch_is_muted(self, muted: bool) -> None:
        """Toggle the --muted CSS class."""
        self.set_class(muted, "--muted")
        self._refresh_header()

    def watch_unread_count(self, count: int) -> None:
        """Update the header display with badge."""
        self._refresh_header()

    def _refresh_header(self) -> None:
        """Rebuild the header line with channel name, mute indicator, and badge."""
        mute_icon = " \U0001f515" if self.is_muted else ""
        badge = ""
        if self.unread_count > 0:
            badge_text = str(self.unread_count) if self.unread_count < 100 else "99+"
            badge = f" [{badge_text}]"
        self._header_label.update(f"# {self.conv_id}{mute_icon}{badge}")

    def set_preview(self, sender: str, text: str) -> None:
        """Set the last message preview text."""
        # Truncate to fit sidebar
        preview = f"{sender}: {text}"
        if len(preview) > 22:
            preview = preview[:20] + "\u2026"
        self._preview_label.update(preview)
        self._preview_label.display = True

    def clear_preview(self) -> None:
        """Hide the preview label."""
        self._preview_label.update("")
        self._preview_label.display = False

    def on_click(self) -> None:
        """Post a ChannelSelected message when clicked."""
        self.post_message(ChannelSelected(self.conv_id))


class ChannelList(Vertical):
    """Sidebar listing all conversation channels."""

    DEFAULT_CSS = """
    ChannelList {
        width: 26;
        dock: left;
        background: #1a1a1c;
        border-right: tall #2a2017;
    }
    .channel-header-row {
        height: 1;
        color: inherit;
    }
    .channel-preview {
        height: 1;
        color: #555555;
        text-style: italic;
        padding: 0 0 0 2;
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

    def set_channel_preview(self, conv_id: str, sender: str, text: str) -> None:
        """Update the last message preview for a channel."""
        if conv_id in self._items:
            self._items[conv_id].set_preview(sender, text)

    def set_channel_muted(self, conv_id: str, muted: bool) -> None:
        """Toggle the muted state for a channel."""
        if conv_id in self._items:
            self._items[conv_id].is_muted = muted

    def on_channel_item_channel_selected(self, event: ChannelSelected) -> None:
        """Bubble channel selection up — handled by the app."""
        pass  # The message bubbles up to the app naturally
