"""Main Textual application for Claude Comms TUI.

Three-column layout: channel list | chat view | participant list
with an MQTT async worker for real-time messaging.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time as _time
from pathlib import Path
from typing import Any

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Footer, Header, Input, Label, Static
from textual import work

from claude_comms.artifact import (
    list_artifacts,
    load_artifact,
    validate_artifact_name,
    DEFAULT_GET_CHUNK_SIZE,
)
from claude_comms.conversation import (
    list_all_conversations,
    load_meta,
)
from claude_comms.broker import generate_client_id
from claude_comms.config import load_config
from claude_comms.mention import resolve_mentions
from claude_comms.message import Message, validate_conv_id
from claude_comms.participant import CONNECTION_TYPES
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
        Binding(
            "ctrl+k", "switch_conversation", "Switch Conv", show=True, priority=True
        ),
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

        # Per-session instance ID (4 hex chars)
        self._instance_id = secrets.token_hex(2)

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

        # Artifact data directory
        self._artifact_dir = Path(
            self._config.get("artifacts", {}).get(
                "data_dir", "~/.claude-comms/artifacts"
            )
        ).expanduser()

        # MQTT client reference (set by worker)
        self._mqtt_client = None

        # Heartbeat task reference (cancelled on disconnect)
        self._heartbeat_task: asyncio.Task | None = None

        # Typing indicator debounce: publish at most once per 2 seconds
        self._last_typing_publish: float = 0.0
        self._TYPING_DEBOUNCE_SECS: float = 2.0

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

        # Add ourselves to the participant list (user key, with tui connection)
        conn_key = f"tui-{self._instance_id}"
        participant_list.set_participant(
            key=self._key,
            name=self._name,
            participant_type=self._type,
            presence=PresenceState.ONLINE,
            client_type="tui",
            connection_key=conn_key,
            connection_info={"client": "tui", "instanceId": self._instance_id},
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

    # -- Presence helpers -----------------------------------------------------

    @property
    def _presence_topic(self) -> str:
        """Our per-instance presence topic."""
        return f"claude-comms/presence/{self._key}/tui-{self._instance_id}"

    def _make_presence_payload(self, status: str) -> str:
        """Build a JSON presence payload."""
        from claude_comms.message import now_iso

        return json.dumps(
            {
                "key": self._key,
                "name": self._name,
                "type": self._type,
                "status": status,
                "client": "tui",
                "instanceId": self._instance_id,
                "ts": now_iso(),
            }
        )

    # -- MQTT Worker -----------------------------------------------------------

    @work(exclusive=True, thread=False, group="mqtt")
    async def _start_mqtt_worker(self) -> None:
        """Async worker that connects to MQTT and listens for messages."""
        try:
            import aiomqtt
        except ImportError:
            self._show_system("aiomqtt not installed. Run: pip install aiomqtt")
            return

        client_id = generate_client_id("tui", self._key)

        # Build LWT on per-instance presence topic
        lwt_payload = self._make_presence_payload("offline")
        lwt = aiomqtt.Will(
            topic=self._presence_topic,
            payload=lwt_payload,
            qos=1,
            retain=True,
        )

        try:
            async with aiomqtt.Client(
                hostname=self._mqtt_host,
                port=self._mqtt_port,
                username=self._mqtt_user,
                password=self._mqtt_pass,
                identifier=client_id,
                will=lwt,
            ) as client:
                self._mqtt_client = client

                # Subscribe to all conversation messages
                await client.subscribe("claude-comms/conv/+/messages", qos=1)

                # Subscribe to new presence topic (global)
                await client.subscribe("claude-comms/presence/+/+", qos=0)

                # Subscribe to old presence topics (dual subscription for migration)
                await self._subscribe_conv_topics(client, self._active_conv)

                # Publish our own presence as online
                await self._publish_presence(client, "online")

                # Start heartbeat (60-second periodic re-publish)
                self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(client))

                self._show_system(f"Connected as {self._name} ({self._key})")
                try:
                    status_bar = self.query_one("#status-bar", StatusBar)
                    status_bar.connected = True
                except Exception:
                    pass

                # Fetch message history from the REST API
                await self._fetch_history(self._active_conv)

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

        except asyncio.CancelledError:
            # Graceful shutdown — publish offline + clear retained
            await self._graceful_disconnect()
        except Exception as exc:
            self._show_system(
                f"MQTT connection failed: {exc}\n"
                f"  Broker: {self._mqtt_host}:{self._mqtt_port}\n"
                f"  Ensure the broker is running: claude-comms broker start"
            )
            logger.exception("MQTT worker error")
        finally:
            if self._heartbeat_task and not self._heartbeat_task.done():
                self._heartbeat_task.cancel()
                self._heartbeat_task = None

    async def _heartbeat_loop(self, client) -> None:
        """Re-publish presence every 60 seconds to keep lastSeen fresh."""
        try:
            while True:
                await asyncio.sleep(60)
                await self._publish_presence(client, "online")
        except asyncio.CancelledError:
            pass

    async def _graceful_disconnect(self) -> None:
        """Publish offline status and clear retained presence on disconnect."""
        if not self._mqtt_client:
            return
        try:
            # Publish offline
            await self._mqtt_client.publish(
                self._presence_topic,
                self._make_presence_payload("offline"),
                qos=1,
                retain=True,
            )
            # Clear retained message
            await self._mqtt_client.publish(
                self._presence_topic,
                b"",
                qos=1,
                retain=True,
            )
        except Exception:
            pass

    async def _subscribe_conv_topics(self, client, conv_id: str) -> None:
        """Subscribe to presence and typing topics for a conversation (old format)."""
        await client.subscribe(f"claude-comms/conv/{conv_id}/presence/+", qos=0)
        await client.subscribe(f"claude-comms/conv/{conv_id}/typing/+", qos=0)

    async def _unsubscribe_conv_topics(self, client, conv_id: str) -> None:
        """Unsubscribe from conversation-specific topics."""
        await client.unsubscribe(f"claude-comms/conv/{conv_id}/presence/+")
        await client.unsubscribe(f"claude-comms/conv/{conv_id}/typing/+")

    async def _fetch_history(self, conv_id: str) -> None:
        """Fetch message history from the REST API and display it."""
        import httpx

        mcp_cfg = self._config.get("mcp", {})
        mcp_host = mcp_cfg.get("host", "127.0.0.1")
        mcp_port = mcp_cfg.get("port", 9920)
        url = f"http://{mcp_host}:{mcp_port}/api/messages/{conv_id}?count=50"

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url)
                if resp.status_code != 200:
                    return
                data = resp.json()
                messages = data.get("messages", [])
                if not messages:
                    return

                chat_view = self.query_one("#chat-view", ChatView)
                from claude_comms.message import Message

                for msg_data in messages:
                    try:
                        msg = Message(**msg_data)
                        chat_view.add_message(msg)
                    except Exception:
                        pass  # Skip malformed messages

                self._show_system(f"Loaded {len(messages)} message(s) from history")
        except Exception:
            # History fetch failed — not critical, live messages still work
            pass

    async def _publish_presence(self, client, status: str) -> None:
        """Publish our presence to the new per-instance topic.

        Also publishes to the old conv-level and system topics for
        backward compatibility during migration.
        """
        payload = self._make_presence_payload(status)
        # New per-instance topic
        await client.publish(self._presence_topic, payload, qos=1, retain=True)

        # Old conv-level topic (backward compat)
        old_topic = f"claude-comms/conv/{self._active_conv}/presence/{self._key}"
        await client.publish(old_topic, payload, qos=1, retain=True)

        # Old system/participants topic (backward compat)
        system_topic = f"claude-comms/system/participants/{self._key}-tui"
        await client.publish(system_topic, payload, qos=1, retain=True)

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

        # Route system-type messages through the system message renderer
        if msg.sender.type == "system":
            chat_view.add_system_message(msg.body, conv=msg.conv)
        else:
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
        """Process a presence update from MQTT.

        Handles both new-format topics (``claude-comms/presence/{key}/{client}-{instanceId}``)
        and old-format topics (``claude-comms/conv/{channel}/presence/{key}``).
        Aggregates by user key so each user has one entry in the participant list.
        """
        try:
            data = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

        key = data.get("key", "")
        if not key:
            return

        status = data.get("status", "offline")
        name = data.get("name", "") or f"user-{key}"
        ptype = data.get("type", "claude")
        client_type = data.get("client", "")
        instance_id = data.get("instanceId", "")

        # Validate client type against allowed list
        if not client_type or client_type not in CONNECTION_TYPES:
            return

        # Build connection key
        conn_key = f"{client_type}-{instance_id}" if instance_id else client_type

        # Skip our own TUI instance
        if (
            key == self._key
            and client_type == "tui"
            and instance_id == self._instance_id
        ):
            return

        participant_list = self.query_one("#participant-sidebar", ParticipantList)

        if status == "offline":
            # Remove this specific connection
            participant_list.remove_connection(key, conn_key)
        else:
            # online / away / unknown status — add or update
            state_map = {
                "online": PresenceState.ONLINE,
                "away": PresenceState.AWAY,
            }
            state = state_map.get(status, PresenceState.OFFLINE)

            participant_list.set_participant(
                key=key,
                name=name,
                participant_type=ptype,
                presence=state,
                client_type=client_type,
                connection_key=conn_key,
                connection_info={"client": client_type, "instanceId": instance_id},
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

    # -- Typing indicators ----------------------------------------------------

    def on_input_changed(self, event: Input.Changed) -> None:
        """Publish a typing indicator when the user types (debounced)."""
        # Only act on the message input widget
        if event.input.id != "message-input":
            return
        # Don't publish typing when input is cleared (e.g. after send)
        if not event.value:
            return
        now = _time.monotonic()
        if now - self._last_typing_publish >= self._TYPING_DEBOUNCE_SECS:
            self._last_typing_publish = now
            self._publish_typing(True)

    @work(thread=False)
    async def _publish_typing(self, typing: bool) -> None:
        """Publish typing indicator via MQTT (QoS 0, fire-and-forget)."""
        if not self._mqtt_client:
            return
        from claude_comms.message import now_iso

        payload = json.dumps(
            {
                "key": self._key,
                "name": self._name,
                "typing": typing,
                "ts": now_iso(),
            }
        )
        topic = f"claude-comms/conv/{self._active_conv}/typing/{self._key}"
        try:
            await self._mqtt_client.publish(topic, payload, qos=0)
        except Exception:
            pass  # typing indicators are best-effort

    # -- Message sending -------------------------------------------------------

    def on_message_submitted(self, event: MessageSubmitted) -> None:
        """Handle submitted message from the input widget."""
        # Clear typing indicator on send
        self._last_typing_publish = 0.0
        self._publish_typing(False)

        # Intercept slash commands before sending as a chat message
        if event.body.startswith("/discover"):
            self._handle_discover_command(event.body)
            return

        if event.body.startswith("/artifact"):
            self._handle_artifact_command(event.body)
            return

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

    # -- Artifact slash commands ------------------------------------------------

    def _handle_artifact_command(self, body: str) -> None:
        """Handle /artifact slash commands."""
        parts = body.strip().split(None, 2)
        subcommand = parts[1] if len(parts) > 1 else "list"

        if subcommand == "list":
            self._artifact_list()
        elif subcommand == "view" and len(parts) > 2:
            self._artifact_view(parts[2])
        elif subcommand == "help":
            self._artifact_help()
        else:
            self._artifact_help()

    def _artifact_list(self) -> None:
        """Display artifacts in the current conversation."""
        artifacts = list_artifacts(self._active_conv, self._artifact_dir)
        chat = self.query_one("#chat-view", ChatView)

        if not artifacts:
            chat.add_system_message("[dim]No artifacts in this conversation.[/dim]")
            return

        lines = ["[bold]Artifacts:[/bold]"]
        for a in artifacts:
            type_badge = {"plan": "\U0001f4cb", "doc": "\U0001f4c4", "code": "\U0001f4bb"}.get(
                a["type"], "\U0001f4c4"
            )
            lines.append(
                f"  {type_badge} [bold]{a['title']}[/bold] ({a['name']}) "
                f"\u2014 v{a['version_count']}, by {a.get('author', {}).get('name', '?')}"
            )
        lines.append("[dim]Use /artifact view <name> to read an artifact[/dim]")
        chat.add_system_message("\n".join(lines))

    def _artifact_view(self, name: str) -> None:
        """Display an artifact's content in the chat view."""
        chat = self.query_one("#chat-view", ChatView)

        if not validate_artifact_name(name):
            chat.add_system_message(f"[red]Invalid artifact name: {name!r}[/red]")
            return

        artifact = load_artifact(self._active_conv, name, self._artifact_dir)

        if artifact is None:
            chat.add_system_message(f"[red]Artifact '{name}' not found.[/red]")
            return

        latest = artifact.versions[-1] if artifact.versions else None
        if latest is None:
            chat.add_system_message(f"[red]Artifact '{name}' has no versions.[/red]")
            return

        # Truncate content for display (Rich markup in terminal)
        content = latest.content
        if len(content) > DEFAULT_GET_CHUNK_SIZE:
            content = (
                content[:DEFAULT_GET_CHUNK_SIZE]
                + f"\n\n[dim]... truncated ({len(latest.content)} chars total)[/dim]"
            )

        header = (
            f"[bold]{artifact.title}[/bold] ({artifact.name}) \u2014 "
            f"v{latest.version} by {latest.author.name}"
        )
        if latest.summary:
            header += f"\n[dim]{latest.summary}[/dim]"

        chat.add_system_message(f"{header}\n{'\u2500' * 40}\n{content}")

    def _artifact_help(self) -> None:
        """Show artifact command help."""
        chat = self.query_one("#chat-view", ChatView)
        chat.add_system_message(
            "[bold]Artifact Commands:[/bold]\n"
            "  /artifact list \u2014 List all artifacts\n"
            "  /artifact view <name> \u2014 View an artifact\n"
            "  /artifact help \u2014 Show this help"
        )

    # -- Discover slash commands ------------------------------------------------

    def _handle_discover_command(self, body: str) -> None:
        """Handle /discover slash command -- list all conversations."""
        parts = body.strip().split(None, 1)
        subcommand = parts[0] if parts else "/discover"

        if subcommand == "/discover":
            self._discover_list()
        else:
            self._discover_help()

    def _discover_list(self) -> None:
        """List all conversations with metadata."""
        conv_data_dir = Path(
            self._config.get("conversations", {}).get(
                "data_dir", "~/.claude-comms/conversations"
            )
        ).expanduser()

        conversations = list_all_conversations(conv_data_dir)
        chat = self.query_one(ChatView)

        if not conversations:
            chat.add_system_message("[dim]No conversations found.[/dim]")
            return

        # Sort by last_activity (most recent first)
        conversations.sort(key=lambda c: c.last_activity, reverse=True)

        lines = ["[bold]All Conversations:[/bold]"]
        for conv in conversations:
            # Check membership
            is_member = (
                conv.name == self._active_conv
                or conv.name in self._conversations
            )
            status = (
                "[green]joined[/green]" if is_member else "[dim]not joined[/dim]"
            )
            topic_str = f" \u2014 {conv.topic}" if conv.topic else ""
            lines.append(
                f"  [bold]#{conv.name}[/bold]{topic_str} ({status})"
                f"\n    Last activity: "
                f"{conv.last_activity[:19] if conv.last_activity else 'never'}"
            )
        lines.append("\n[dim]Use Ctrl+N to join a conversation[/dim]")
        chat.add_system_message("\n".join(lines))

    def _discover_help(self) -> None:
        """Show discover command help."""
        chat = self.query_one("#chat-view", ChatView)
        chat.add_system_message(
            "[bold]Discover Commands:[/bold]\n"
            "  /discover \u2014 Browse all conversations"
        )

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
    async def _resubscribe_conversation(self, old_conv: str, new_conv: str) -> None:
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
        height: 25;
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
            yield Label("", classes="help-line")
            yield Label("  /artifact list       List artifacts", classes="help-line")
            yield Label("  /artifact view <n>   View an artifact", classes="help-line")
            yield Label("  /artifact help       Artifact help", classes="help-line")
            yield Label("  /discover            Browse all conversations", classes="help-line")
            yield Label("Press Escape or F1 to close", classes="help-footer")
