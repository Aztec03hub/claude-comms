"""Notification cue writer for the PostToolUse "never miss a message" hook.

The hook script (``hook_installer._generate_unix_script`` /
``_generate_windows_script``) drains ``~/.claude-comms/notifications/<key>.jsonl``
on every PostToolUse event and injects pending messages as ``additionalContext``.
Nothing in the daemon ever wrote that file, so push delivery silently no-opped
(see FINDINGS.md #1).  ``NotificationWriter`` closes that gap: the MQTT subscriber
calls :meth:`NotificationWriter.write` for every (post-dedup) message and it
appends one JSON line per *cued* recipient.

Cue line shape (the four keys the hook parser consumes — see
``hook_installer.py`` per-line ``json.load``)::

    {"conversation": <conv>, "sender_name": <name>, "sender_key": <key>, "body": <body>}

Delivery policy (all derivable from the message dict alone, except the optional
broadcast path which needs the registry):

* whisper      -> every key in ``recipients``
* mention      -> every key in ``mentions`` EXCLUDING the sender's own key
* plain bcast  -> nobody, unless ``cue_on_broadcast`` is True, then every OTHER
                  conversation member (resolved lazily via the registry)
* system msgs  -> never (``sender.key == "00000000"``)

De-duped: a participant cued by both whisper and mention gets exactly one line.

Exports: NotificationWriter
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from claude_comms.hook_installer import _notification_dir
from claude_comms.message import SYSTEM_SENDER_KEY

if TYPE_CHECKING:  # avoid an import cycle — mcp_tools is heavy
    from claude_comms.mcp_tools import ParticipantRegistry


logger = logging.getLogger(__name__)

# The reserved key used by every server-authored ``[system]`` message.
# Single-sourced from :data:`claude_comms.message.SYSTEM_SENDER_KEY`.
_SYSTEM_KEY = SYSTEM_SENDER_KEY


class NotificationWriter:
    """Append per-recipient cue lines to ``notifications/<key>.jsonl``.

    The writer is deliberately stateless beyond its config: each
    :meth:`write` call opens the target file in append mode and writes one
    newline-terminated JSON line per cued key.  This keeps it crash-safe and
    trivially concurrent-friendly (the hook drains+truncates separately).
    """

    def __init__(
        self,
        notif_dir: Path,
        enabled: bool,
        cue_on_broadcast: bool,
        registry_provider: Callable[[], "ParticipantRegistry | None"] | None = None,
    ) -> None:
        self._notif_dir: Path = notif_dir
        self._enabled: bool = enabled
        self._cue_on_broadcast: bool = cue_on_broadcast
        # Resolved lazily — the registry module global is reassigned during
        # daemon startup, so we must NOT capture the object at construction.
        self._registry_provider: Callable[[], "ParticipantRegistry | None"] | None = (
            registry_provider
        )

    @classmethod
    def from_config(
        cls,
        config: dict[str, Any],
        registry_provider: Callable[[], "ParticipantRegistry | None"] | None = None,
    ) -> "NotificationWriter":
        """Build a writer from the (plain-dict) config.

        Reads ``notifications.hook_enabled`` (default True) and
        ``notifications.cue_on_broadcast`` (default False).  Config is a plain
        dict — access is dict-style, never attribute-style.
        """
        notifs = config.get("notifications", {})
        return cls(
            notif_dir=_notification_dir(),
            enabled=notifs.get("hook_enabled", True),
            cue_on_broadcast=notifs.get("cue_on_broadcast", False),
            registry_provider=registry_provider,
        )

    def _cued_keys(self, msg: dict[str, Any]) -> list[str]:
        """Compute the ordered, de-duped set of keys to cue for *msg*.

        Returns an empty list for system messages, plain broadcasts (unless
        ``cue_on_broadcast``), or anything with no resolvable targets.
        """
        sender: dict[str, Any] = msg.get("sender") or {}
        sender_key = sender.get("key")

        # System messages never generate cues.
        if sender_key == _SYSTEM_KEY:
            return []

        recipients: list[Any] = msg.get("recipients") or []
        mentions: list[Any] = msg.get("mentions") or []

        cued: list[str] = []
        seen: set[str] = set()

        def _add(k: Any) -> None:
            if k and k not in seen:
                seen.add(k)
                cued.append(k)

        # whisper: send path already drops the sender from recipients.
        for k in recipients:
            _add(k)

        # mention: exclude the sender's own key (no self-cue on a self-@mention).
        for k in mentions:
            if k != sender_key:
                _add(k)

        # plain broadcast: no recipients, no mentions.
        if not recipients and not mentions and self._cue_on_broadcast:
            conv = msg.get("conv", "")
            registry = self._registry_provider() if self._registry_provider else None
            if conv and registry is not None:
                try:
                    members = registry.members(conv)
                except Exception:
                    logger.warning(
                        "Failed to resolve members for broadcast cue", exc_info=True
                    )
                    members = []
                for m in members:
                    mk = getattr(m, "key", None)
                    # Every OTHER member — never cue the broadcaster itself.
                    if mk and mk != sender_key:
                        _add(mk)

        return cued

    def write(self, msg: dict[str, Any]) -> int:
        """Append a cue line to ``<key>.jsonl`` for each cued recipient.

        Returns the number of cue lines written.  No-op (returns 0) when the
        writer is disabled.  Resolves the registry lazily via
        ``registry_provider`` (only the broadcast-cue path needs it).
        """
        if not self._enabled:
            return 0

        cued = self._cued_keys(msg)
        if not cued:
            return 0

        sender: dict[str, Any] = msg.get("sender") or {}
        # The hook parser only consumes these four keys; missing ones degrade
        # gracefully to "".  One json.dumps() per line so embedded newlines,
        # quotes, tabs and non-ASCII are escaped and never split a line.
        line = json.dumps(
            {
                "conversation": msg.get("conv", ""),
                "sender_name": sender.get("name", ""),
                "sender_key": sender.get("key", ""),
                "body": msg.get("body", ""),
            }
        )

        try:
            self._notif_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            logger.warning("Failed to create notification dir", exc_info=True)
            return 0

        written = 0
        for key in cued:
            path = self._notif_dir / f"{key}.jsonl"
            try:
                with open(path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
                written += 1
            except Exception:
                logger.warning(
                    "Failed to write notification cue for %s", key, exc_info=True
                )
        return written
