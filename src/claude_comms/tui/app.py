"""Main Textual application for Claude Comms TUI.

Three-column layout: channel list | chat view | participant list
with an MQTT async worker for real-time messaging.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input, Label, Static
from textual import work

from claude_comms.broker import generate_client_id
from claude_comms.config import load_config
from claude_comms.mention import resolve_mentions
from claude_comms.message import Message, validate_conv_id
from claude_comms.tui.channel_list import ChannelList, ChannelSelected
from claude_comms.tui.chat_view import ChatView
from claude_comms.tui.message_input import MessageInput, MessageSubmitted
from claude_comms.tui.participant_list import ParticipantList, PresenceState
from claude_comms.tui.status_bar import StatusBar

logger = logging.getLogger(__name__)

# Path to the TCSS stylesheet (sibling file)
CSS_PATH = str(Path(__file__).parent / "styles.tcss")


class ClaudeCommsApp(App):
    """Claude Comms terminal chat client.

    Connects directly to the MQTT broker via aiomqtt for real-time
    messaging. Uses Textual's @work() decorator for the async MQTT
    listener loop.
    """

    TITLE = "Claude Comms"
    SUB_TITLE = "Terminal Chat"
    CSS_PATH = "styles.tcss"

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit", show=True),
        Binding("ctrl+n", "new_conversation", "New Conv", show=True),
        Binding("ctrl+k", "switch_conversation", "Switch Conv", show=True, priority=True),
        Binding("f1", "show_help", "Help", show=True),
    ]

    def __init__(self, config: dict[str, Any] | None = None, **kwargs) -> None:
        super().__init__(**kwargs)

        # Load config
        self._config = config or load_config()
        identity = self._config.get("identity", {})

        # Build our participant identity
        self._key = identity.get("key", "00000000")
        self._name = identity.get("name", "") or f"user-{self._key}"
        self._type = identity.get("type", "human")

        # MQTT connection info
        broker_cfg = self._config.get("broker", {})
        self._mqtt_host = broker_cfg.get("host", "127.0.0.1")
        self._mqtt_port = broker_cfg.get("port", 1883)
        auth_cfg = broker_cfg.get("auth", {})
        self._mqtt_user = auth_cfg.get("username") if auth_cfg.get("enabled") else None
        self._mqtt_pass = auth_cfg.get("password") if auth_cfg.get("enabled") else None

        # State
        self._active_conv = self._config.get("default_conversation", "general")
        auto_join = self._config.get("mcp", {}).get("auto_join", ["general"])
        self._conversations: list[str] = list(auto_join) if auto_join else ["general"]

        # MQTT client reference (set by worker)
        self._mqtt_client = None

    # -- Compose the UI -------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="app-grid"):
            yield ChannelList(
                channels=list(self._conversations),
                id="channel-sidebar",
            )
            with Vertical(id="chat-area"):
                yield Static(
                    f"  # {self._active_conv}",
                    id="channel-header",
                )
                yield ChatView(id="chat-view")
                yield MessageInput(id="message-input-area")
            yield ParticipantList(id="participant-sidebar")
        yield StatusBar(id="status-bar")
        yield Footer()

    def on_mount(self) -> None:
        """Initialize after mount: wire up autocomplete, start MQTT worker."""
        # Wire up @mention autocomplete with participant names
        msg_input = self.query_one("#message-input-area", MessageInput)
        participant_list = self.query_one("#participant-sidebar", ParticipantList)
        msg_input.set_name_provider(participant_list.get_names)

        # Set initial active channel
        channel_list = self.query_one("#channel-sidebar", ChannelList)
        channel_list.active_channel = self._active_conv

        # Add ourselves to the participant list
        participant_list.set_participant(
            key=self._key,
            name=self._name,
            participant_type=self._type,
            presence=PresenceState.ONLINE,
        )

        # Initialize status bar
        status_bar = self.query_one("#status-bar", StatusBar)
        status_bar.active_channel = self._active_conv
        status_bar.user_name = self._name
        status_bar.user_key = self._key
        status_bar.participant_count = len(participant_list.get_names())

        # Focus the input
        msg_input.focus_input()

        # Start the MQTT listener worker
        self._start_mqtt_worker()

    # -- MQTT Worker -----------------------------------------------------------

    @work(exclusive=True, thread=False, group="mqtt")
    async def _start_mqtt_worker(self) -> None:
        """Async worker that connects to MQTT and listens for messages."""
        try:
            import aiomqtt
        except ImportError:
            self._show_system(
                "aiomqtt not installed. Run: pip install aiomqtt"
            )
            return

        client_id = generate_client_id("tui", self._key)

        try:
            async with aiomqtt.Client(
                hostname=self._mqtt_host,
                port=self._mqtt_port,
                username=self._mqtt_user,
                password=self._mqtt_pass,
                identifier=client_id,
            ) as client:
                self._mqtt_client = client

                # Subscribe to all conversation messages
                await client.subscribe("claude-comms/conv/+/messages", qos=1)

                # Subscribe to presence and typing for active conversation
                await self._subscribe_conv_topics(client, self._active_conv)

                # Publish our own presence as online
                await self._publish_presence(client, "online")

                self._show_system(f"Connected as {self._name} ({self._key})")
                try:
                    status_bar = self.query_one("#status-bar", StatusBar)
                    status_bar.connected = True
                except Exception:
                    pass

                # Message receive loop
                async for mqtt_msg in client.messages:
                    topic = str(mqtt_msg.topic)
                    payload = mqtt_msg.payload

                    if not payload:
                        continue

                    try:
                        if "/messages" in topic:
                            await self._handle_message(topic, payload)
                        elif "/presence/" in topic:
                            await self._handle_presence(topic, payload)
                        elif "/typing/" in topic:
                            await self._handle_typing(topic, payload)
                    except Exception as exc:
                        logger.debug("Error handling MQTT message: %s", exc)

        except Exception as exc:
            self._show_system(
                f"MQTT connection failed: {exc}\n"
                f"  Broker: {self._mqtt_host}:{self._mqtt_port}\n"
                f"  Ensure the broker is running: claude-comms broker start"
            )
            logger.exception("MQTT worker error")

    async def _subscribe_conv_topics(self, client, conv_id: str) -> None:
        """Subscribe to presence and typing topics for a conversation."""
        await client.subscribe(
            f"claude-comms/conv/{conv_id}/presence/+", qos=0
        )
        await client.subscribe(
            f"claude-comms/conv/{conv_id}/typing/+", qos=0
        )

    async def _unsubscribe_conv_topics(self, client, conv_id: str) -> None:
        """Unsubscribe from conversation-specific topics."""
        await client.unsubscribe(f"claude-comms/conv/{conv_id}/presence/+")
        await client.unsubscribe(f"claude-comms/conv/{conv_id}/typing/+")

    async def _publish_presence(self, client, status: str) -> None:
        """Publish our presence status for the active conversation."""
        payload = json.dumps({
            "key": self._key,
            "name": self._name,
            "type": self._type,
            "status": status,
        })
        topic = f"claude-comms/conv/{self._active_conv}/presence/{self._key}"
        await client.publish(topic, payload, qos=0, retain=True)

    async def _handle_message(self, topic: str, payload: bytes) -> None:
        """Process an incoming chat message from MQTT."""
        try:
            msg = Message.from_mqtt_payload(payload)
        except Exception:
            logger.debug("Could not parse message on %s", topic)
            return

        # Check if the message is for us (broadcast or targeted)
        if not msg.is_for(self._key) and not msg.is_broadcast:
            return

        chat_view = self.query_one("#chat-view", ChatView)
        chat_view.add_message(msg)

        # Update channel list preview and unread
        channel_list = self.query_one("#channel-sidebar", ChannelList)
        # Auto-add channel if we haven't seen it
        channel_list.add_channel(msg.conv)
        # Set last message preview
        channel_list.set_channel_preview(msg.conv, msg.sender.name, msg.body)

        # If message is not for the active conversation, bump unread
        if msg.conv != self._active_conv:
            channel_list.increment_unread(msg.conv)

    async def _handle_presence(self, topic: str, payload: bytes) -> None:
        """Process a presence update from MQTT."""
        try:
            data = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

        key = data.get("key", "")
        if not key:
            return
        name = data.get("name", "") or f"user-{key}"
        ptype = data.get("type", "claude")
        status = data.get("status", "offline")

        state_map = {
            "online": PresenceState.ONLINE,
            "away": PresenceState.AWAY,
            "offline": PresenceState.OFFLINE,
        }
        state = state_map.get(status, PresenceState.OFFLINE)

        participant_list = self.query_one("#participant-sidebar", ParticipantList)
        participant_list.set_participant(
            key=key,
            name=name,
            participant_type=ptype,
            presence=state,
        )

        # Update participant count in status bar
        try:
            status_bar = self.query_one("#status-bar", StatusBar)
            status_bar.participant_count = len(participant_list.get_names())
        except Exception:
            pass

    async def _handle_typing(self, topic: str, payload: bytes) -> None:
        """Process a typing indicator from MQTT."""
        try:
            data = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

        name = data.get("name", "")
        is_typing = data.get("typing", False)

        if not name or name == self._name:
            return  # Don't show our own typing

        try:
            status_bar = self.query_one("#status-bar", StatusBar)
            status_bar.typing_who = name if is_typing else ""
        except Exception:
            pass

    # -- Message sending -------------------------------------------------------

    def on_message_submitted(self, event: MessageSubmitted) -> None:
        """Handle submitted message from the input widget."""
        self._send_message(event.body)

    @work(thread=False)
    async def _send_message(self, body: str) -> None:
        """Publish a message to the active conversation via MQTT."""
        if not self._mqtt_client:
            self._show_system("Not connected to MQTT broker")
            return

        # Resolve @mentions to recipient keys
        participant_list = self.query_one("#participant-sidebar", ParticipantList)
        name_to_key = participant_list.get_name_to_key()
        recipient_keys = resolve_mentions(body, name_to_key)

        msg = Message.create(
            sender_key=self._key,
            sender_name=self._name,
            sender_type=self._type,
            body=body,
            conv=self._active_conv,
            recipients=recipient_keys if recipient_keys else None,
        )

        try:
            await self._mqtt_client.publish(
                msg.topic,
                msg.to_mqtt_payload(),
                qos=1,
            )
        except Exception as exc:
            self._show_system(f"Send failed: {exc}")
            logger.exception("Failed to publish message")

    # -- Channel switching -----------------------------------------------------

    def on_channel_selected(self, event: ChannelSelected) -> None:
        """Handle channel selection from the sidebar."""
        self._switch_to_conv(event.conv_id)

    def _switch_to_conv(self, conv_id: str) -> None:
        """Switch active conversation and update UI."""
        if conv_id == self._active_conv:
            return

        old_conv = self._active_conv
        self._active_conv = conv_id

        # Update header
        header = self.query_one("#channel-header", Static)
        header.update(f"  # {conv_id}")

        # Update channel list
        channel_list = self.query_one("#channel-sidebar", ChannelList)
        channel_list.active_channel = conv_id
        channel_list.clear_unread(conv_id)

        # Switch chat view
        chat_view = self.query_one("#chat-view", ChatView)
        chat_view.switch_conversation(conv_id)

        # Update status bar
        try:
            status_bar = self.query_one("#status-bar", StatusBar)
            status_bar.active_channel = conv_id
            status_bar.typing_who = ""  # Clear typing on channel switch
        except Exception:
            pass

        # Resubscribe to new conversation topics
        self._resubscribe_conversation(old_conv, conv_id)

    @work(thread=False)
    async def _resubscribe_conversation(
        self, old_conv: str, new_conv: str
    ) -> None:
        """Switch MQTT subscriptions when changing conversations."""
        if not self._mqtt_client:
            return
        try:
            await self._unsubscribe_conv_topics(self._mqtt_client, old_conv)
            await self._subscribe_conv_topics(self._mqtt_client, new_conv)
            await self._publish_presence(self._mqtt_client, "online")
        except Exception as exc:
            logger.debug("Error resubscribing: %s", exc)

    # -- Actions (keybindings) -------------------------------------------------

    def action_new_conversation(self) -> None:
        """Ctrl+N — prompt for a new conversation name."""
        self.push_screen(NewConversationScreen(self._on_new_conv_created))

    def action_switch_conversation(self) -> None:
        """Ctrl+K — quick switch to another conversation."""
        # Simple approach: cycle through conversations
        if len(self._conversations) <= 1:
            return
        try:
            idx = self._conversations.index(self._active_conv)
        except ValueError:
            idx = -1
        next_idx = (idx + 1) % len(self._conversations)
        self._switch_to_conv(self._conversations[next_idx])

    def action_show_help(self) -> None:
        """F1 — show keybinding help overlay."""
        self.push_screen(HelpScreen())

    def _on_new_conv_created(self, conv_id: str) -> None:
        """Callback when user creates a new conversation."""
        if not validate_conv_id(conv_id):
            self._show_system(f"Invalid conversation name: {conv_id}")
            return
        if conv_id not in self._conversations:
            self._conversations.append(conv_id)
        channel_list = self.query_one("#channel-sidebar", ChannelList)
        channel_list.add_channel(conv_id)
        self._switch_to_conv(conv_id)

    # -- Helpers ---------------------------------------------------------------

    def _show_system(self, text: str) -> None:
        """Show a system message in the chat view."""
        try:
            chat_view = self.query_one("#chat-view", ChatView)
            chat_view.add_system_message(text)
        except Exception:
            pass  # UI not ready yet


# ---------------------------------------------------------------------------
# New Conversation modal screen
# ---------------------------------------------------------------------------

from textual.screen import ModalScreen


class NewConversationScreen(ModalScreen):
    """Modal dialog for creating a new conversation."""

    DEFAULT_CSS = """
    NewConversationScreen {
        align: center middle;
    }
    #new-conv-dialog {
        width: 50;
        height: 11;
        background: #1c1c1e;
        border: round #d97706;
        padding: 1 2;
    }
    #new-conv-dialog Label {
        margin-bottom: 1;
    }
    #new-conv-input {
        background: #141416;
        color: #e8e4df;
        border: round #2c2c2e;
    }
    #new-conv-input:focus {
        border: round #d97706;
    }
    """

    def __init__(self, callback, **kwargs) -> None:
        super().__init__(**kwargs)
        self._callback = callback

    def compose(self) -> ComposeResult:
        with Vertical(id="new-conv-dialog"):
            yield Label("New Conversation")
            yield Label("Enter a name (lowercase, hyphens, numbers):")
            yield Input(
                placeholder="e.g., project-alpha",
                id="new-conv-input",
            )

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle Enter in the conversation name input."""
        name = event.value.strip()
        if name:
            self._callback(name)
        self.dismiss()


class HelpScreen(ModalScreen):
    """Modal overlay showing keybinding help."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("f1", "dismiss", "Close"),
    ]

    DEFAULT_CSS = """
    HelpScreen {
        align: center middle;
    }
    #help-dialog {
        width: 60;
        height: 20;
        background: #1c1c1e;
        border: round #d97706;
        padding: 1 2;
    }
    #help-dialog .help-title {
        text-align: center;
        text-style: bold;
        color: #d97706;
        margin-bottom: 1;
    }
    #help-dialog .help-line {
        height: 1;
        color: #e8e4df;
    }
    #help-dialog .help-footer {
        text-align: center;
        color: #6a6a6a;
        margin-top: 1;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="help-dialog"):
            yield Label("Keybindings", classes="help-title")
            yield Label("  Ctrl+Q      Quit", classes="help-line")
            yield Label("  Ctrl+N      New conversation", classes="help-line")
            yield Label("  Ctrl+K      Cycle conversations", classes="help-line")
            yield Label("  F1          This help screen", classes="help-line")
            yield Label("  Enter       Send message", classes="help-line")
            yield Label("  Tab         @mention autocomplete", classes="help-line")
            yield Label("  Shift+Tab   Navigate focus", classes="help-line")
            yield Label("  @name       Mention a participant", classes="help-line")
            yield Label("  ```lang     Code block (with syntax)", classes="help-line")
            yield Label("Press Escape or F1 to close", classes="help-footer")
