"""Embedded amqtt broker wrapper and message deduplication utilities.

Provides:
- ``EmbeddedBroker``: lifecycle manager for an in-process amqtt broker.
- ``MessageDeduplicator``: bounded seen-ID set for server-side dedup.
- ``MessageStore``: in-memory per-conversation message history (capped).
- ``replay_jsonl_logs``: reconstruct message history from JSONL log files.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "EmbeddedBroker",
    "MessageDeduplicator",
    "MessageStore",
    "replay_jsonl_logs",
]

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 1883
DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 9001
DEFAULT_MAX_REPLAY = 1000

_DATA_DIR = Path.home() / ".claude-comms"
_PID_FILE = _DATA_DIR / "daemon.pid"
_LOG_DIR = _DATA_DIR / "logs"


# ---------------------------------------------------------------------------
# MessageDeduplicator
# ---------------------------------------------------------------------------


class MessageDeduplicator:
    """Bounded seen-ID set for server-side message deduplication.

    Primary dedup happens here (server-side).  Clients have UUID-based
    dedup as a safety net but should never need it in practice.

    Thread-safe via a simple :class:`threading.Lock` so it can also be
    used safely from synchronous helper functions that might be called
    from different threads.
    """

    def __init__(self, max_size: int = 10_000) -> None:
        if max_size < 1:
            raise ValueError("max_size must be >= 1")
        self._max_size = max_size
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._lock = threading.Lock()

    # -- public API --------------------------------------------------------

    def is_duplicate(self, message_id: str) -> bool:
        """Check whether *message_id* has been seen before.

        If the ID is new it is added to the set and ``False`` is returned.
        If it has already been seen, ``True`` is returned (duplicate).

        When the set exceeds *max_size*, the oldest entry is evicted.
        """
        with self._lock:
            if message_id in self._seen:
                # Move to end so it counts as "recently seen"
                self._seen.move_to_end(message_id)
                return True
            self._seen[message_id] = None
            if len(self._seen) > self._max_size:
                self._seen.popitem(last=False)  # evict oldest
            return False

    @property
    def size(self) -> int:
        """Current number of tracked IDs."""
        with self._lock:
            return len(self._seen)

    def clear(self) -> None:
        """Remove all tracked IDs."""
        with self._lock:
            self._seen.clear()


# ---------------------------------------------------------------------------
# MessageStore  (in-memory, per-conversation, capped)
# ---------------------------------------------------------------------------


class MessageStore:
    """In-memory store of recent messages, keyed by conversation ID.

    Each conversation keeps at most *max_per_conv* messages (FIFO eviction).
    """

    def __init__(self, max_per_conv: int = DEFAULT_MAX_REPLAY) -> None:
        self._max = max_per_conv
        self._store: dict[str, list[dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def add(self, conv_id: str, message: dict[str, Any]) -> None:
        """Append *message* to *conv_id*'s history, evicting oldest if full."""
        with self._lock:
            msgs = self._store.setdefault(conv_id, [])
            msgs.append(message)
            if len(msgs) > self._max:
                # Trim to keep only the last _max messages
                self._store[conv_id] = msgs[-self._max :]

    def get(self, conv_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        """Return messages for *conv_id* (most recent last).

        *limit* caps how many are returned (from the tail).
        """
        with self._lock:
            msgs = list(self._store.get(conv_id, []))
        if limit is not None and limit > 0:
            return msgs[-limit:]
        return msgs

    def conversations(self) -> list[str]:
        """Return list of conversation IDs that have stored messages."""
        with self._lock:
            return list(self._store.keys())

    def clear(self) -> None:
        """Drop all stored messages."""
        with self._lock:
            self._store.clear()


# ---------------------------------------------------------------------------
# JSONL replay
# ---------------------------------------------------------------------------


def replay_jsonl_logs(
    log_dir: Path | str | None = None,
    *,
    max_per_conv: int = DEFAULT_MAX_REPLAY,
    store: MessageStore | None = None,
    deduplicator: MessageDeduplicator | None = None,
) -> MessageStore:
    """Read JSONL log files and reconstruct recent message history.

    Parameters
    ----------
    log_dir:
        Directory containing ``*.jsonl`` files.  Defaults to
        ``~/.claude-comms/logs``.
    max_per_conv:
        Maximum messages to keep per conversation.
    store:
        An existing :class:`MessageStore` to populate.  A new one is
        created when *None*.
    deduplicator:
        Optional :class:`MessageDeduplicator` — IDs are registered so
        that replayed messages are not treated as new on first live
        receipt.

    Returns
    -------
    MessageStore
        The (possibly newly-created) store populated with replayed
        messages.
    """
    if log_dir is None:
        log_dir = _LOG_DIR
    log_dir = Path(log_dir)

    if store is None:
        store = MessageStore(max_per_conv=max_per_conv)

    if not log_dir.is_dir():
        logger.debug("JSONL log directory does not exist: %s", log_dir)
        return store

    jsonl_files = sorted(log_dir.glob("*.jsonl"))
    if not jsonl_files:
        logger.debug("No JSONL log files found in %s", log_dir)
        return store

    total = 0
    errors = 0
    for path in jsonl_files:
        try:
            with open(path, encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        errors += 1
                        logger.warning(
                            "Skipping malformed JSON at %s:%d", path.name, lineno
                        )
                        continue

                    msg_id = msg.get("id")
                    conv_id = msg.get("conv")
                    if not msg_id or not conv_id:
                        errors += 1
                        logger.warning(
                            "Skipping message without id/conv at %s:%d",
                            path.name,
                            lineno,
                        )
                        continue

                    # Register in deduplicator so live duplicates are caught
                    if deduplicator is not None:
                        deduplicator.is_duplicate(msg_id)

                    store.add(conv_id, msg)
                    total += 1
        except OSError as exc:
            logger.warning("Could not read JSONL file %s: %s", path, exc)

    logger.info(
        "Replayed %d messages from %d JSONL files (%d errors)",
        total,
        len(jsonl_files),
        errors,
    )
    return store


# ---------------------------------------------------------------------------
# EmbeddedBroker
# ---------------------------------------------------------------------------


def _build_broker_config(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    ws_host: str = DEFAULT_WS_HOST,
    ws_port: int = DEFAULT_WS_PORT,
    auth_enabled: bool = False,
    auth_username: str | None = None,
    auth_password: str | None = None,
) -> dict[str, Any]:
    """Build the amqtt broker configuration dict."""
    config: dict[str, Any] = {
        "listeners": {
            "default": {"type": "tcp", "bind": f"{host}:{port}"},
            "ws-mqtt": {"type": "ws", "bind": f"{ws_host}:{ws_port}"},
        },
        "sys_interval": 0,
        "topic-check": {"enabled": False},
    }

    if auth_enabled and auth_username and auth_password:
        config["auth"] = {
            "plugins": ["auth_file"],
            "password-file": None,  # handled dynamically
        }
        # amqtt password-based auth would go here; for now we keep
        # AnonymousAuthPlugin for simplicity and add password auth
        # support when the auth subsystem is wired end-to-end.
        config["plugins"] = {
            "amqtt.plugins.authentication.AnonymousAuthPlugin": {
                "allow_anonymous": False,
            },
        }
        logger.info("Broker auth enabled (username=%s)", auth_username)
    else:
        config["plugins"] = {
            "amqtt.plugins.authentication.AnonymousAuthPlugin": {
                "allow_anonymous": True,
            },
        }

    return config


class EmbeddedBroker:
    """Lifecycle wrapper around :class:`amqtt.broker.Broker`.

    Usage::

        broker = EmbeddedBroker.from_config(config_dict)
        await broker.start()
        ...
        await broker.stop()

    The broker writes a PID file on start and removes it on stop.
    """

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        ws_host: str = DEFAULT_WS_HOST,
        ws_port: int = DEFAULT_WS_PORT,
        auth_enabled: bool = False,
        auth_username: str | None = None,
        auth_password: str | None = None,
        pid_file: Path | str | None = None,
        log_dir: Path | str | None = None,
        max_replay: int = DEFAULT_MAX_REPLAY,
    ) -> None:
        self.host = host
        self.port = port
        self.ws_host = ws_host
        self.ws_port = ws_port
        self.auth_enabled = auth_enabled
        self.auth_username = auth_username
        self.auth_password = auth_password

        self.pid_file = Path(pid_file) if pid_file else _PID_FILE
        self.log_dir = Path(log_dir) if log_dir else _LOG_DIR
        self.max_replay = max_replay

        self._broker: Any = None  # amqtt.broker.Broker instance
        self._running = False

        # Shared utilities for downstream consumers
        self.deduplicator = MessageDeduplicator()
        self.message_store = MessageStore(max_per_conv=max_replay)

    # -- Factory -----------------------------------------------------------

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "EmbeddedBroker":
        """Create an :class:`EmbeddedBroker` from a parsed config dict.

        Expected keys mirror ``~/.claude-comms/config.yaml``::

            broker.host, broker.port, broker.ws_host, broker.ws_port,
            broker.auth.enabled, broker.auth.username, broker.auth.password
            logging.dir, logging.max_messages_replay
        """
        broker_cfg = config.get("broker", {})
        auth_cfg = broker_cfg.get("auth", {})
        logging_cfg = config.get("logging", {})

        return cls(
            host=broker_cfg.get("host", DEFAULT_HOST),
            port=broker_cfg.get("port", DEFAULT_PORT),
            ws_host=broker_cfg.get("ws_host", DEFAULT_WS_HOST),
            ws_port=broker_cfg.get("ws_port", DEFAULT_WS_PORT),
            auth_enabled=auth_cfg.get("enabled", False),
            auth_username=auth_cfg.get("username"),
            auth_password=auth_cfg.get("password"),
            log_dir=logging_cfg.get("dir", str(_LOG_DIR)),
            max_replay=logging_cfg.get("max_messages_replay", DEFAULT_MAX_REPLAY),
        )

    # -- Lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Start the embedded MQTT broker and replay JSONL logs.

        Catches ``websockets.exceptions.ConnectionClosedOK`` and
        ``struct.error`` internally — these are benign client-side
        disconnects (known amqtt bug) and must not crash the broker.
        """
        if self._running:
            raise RuntimeError("Broker is already running")

        # Ensure data directory exists
        self.pid_file.parent.mkdir(parents=True, exist_ok=True)

        # Replay JSONL logs into message store (pre-broker, synchronous)
        replay_jsonl_logs(
            log_dir=self.log_dir,
            max_per_conv=self.max_replay,
            store=self.message_store,
            deduplicator=self.deduplicator,
        )

        # Build amqtt config
        broker_config = _build_broker_config(
            host=self.host,
            port=self.port,
            ws_host=self.ws_host,
            ws_port=self.ws_port,
            auth_enabled=self.auth_enabled,
            auth_username=self.auth_username,
            auth_password=self.auth_password,
        )

        # Import amqtt lazily so the rest of the module is testable
        # without amqtt installed.
        from amqtt.broker import Broker  # type: ignore[import-untyped]

        self._broker = Broker(config=broker_config)
        await self._broker.start()
        self._running = True

        # Write PID file
        self._write_pid()

        # Install exception handler on the event loop to suppress known
        # amqtt WebSocket disconnect errors that would otherwise crash
        # the broker process.
        loop = asyncio.get_running_loop()
        _original_handler = loop.get_exception_handler()

        def _ws_exception_handler(
            loop: asyncio.AbstractEventLoop, context: dict[str, Any]
        ) -> None:
            exc = context.get("exception")
            if exc is not None:
                import struct

                try:
                    from websockets.exceptions import ConnectionClosedOK  # type: ignore[import-untyped]

                    ws_closed_type = ConnectionClosedOK
                except ImportError:
                    ws_closed_type = None  # type: ignore[assignment]

                if isinstance(exc, struct.error) and "unpack requires" in str(exc):
                    logger.warning(
                        "Suppressed benign amqtt struct.error from WS disconnect: %s",
                        exc,
                    )
                    return
                if ws_closed_type is not None and isinstance(exc, ws_closed_type):
                    logger.warning(
                        "Suppressed benign amqtt ConnectionClosedOK from WS disconnect: %s",
                        exc,
                    )
                    return

            # Fall through to original handler or default
            if _original_handler is not None:
                _original_handler(loop, context)
            else:
                loop.default_exception_handler(context)

        loop.set_exception_handler(_ws_exception_handler)

        logger.info(
            "Broker started — TCP %s:%d, WS %s:%d",
            self.host,
            self.port,
            self.ws_host,
            self.ws_port,
        )

    async def stop(self) -> None:
        """Gracefully stop the broker: disconnect clients, remove PID file."""
        if not self._running:
            logger.warning("Broker is not running; nothing to stop")
            return

        try:
            if self._broker is not None:
                await self._broker.shutdown()
        except Exception:
            logger.exception("Error during broker shutdown")
        finally:
            self._running = False
            self._remove_pid()
            logger.info("Broker stopped")

    @property
    def is_running(self) -> bool:
        """Whether the broker is currently running."""
        return self._running

    # -- PID file helpers --------------------------------------------------

    def _write_pid(self) -> None:
        """Write the current process PID to the PID file."""
        try:
            self.pid_file.parent.mkdir(parents=True, exist_ok=True)
            self.pid_file.write_text(str(os.getpid()), encoding="utf-8")
            logger.debug("PID file written: %s", self.pid_file)
        except OSError as exc:
            logger.warning("Could not write PID file: %s", exc)

    def _remove_pid(self) -> None:
        """Remove the PID file if it exists."""
        try:
            if self.pid_file.exists():
                self.pid_file.unlink()
                logger.debug("PID file removed: %s", self.pid_file)
        except OSError as exc:
            logger.warning("Could not remove PID file: %s", exc)

    @staticmethod
    def read_pid(pid_file: Path | str | None = None) -> int | None:
        """Read and return the PID from the PID file, or ``None``."""
        path = Path(pid_file) if pid_file else _PID_FILE
        try:
            if path.exists():
                text = path.read_text(encoding="utf-8").strip()
                return int(text) if text else None
        except (OSError, ValueError):
            pass
        return None

    @staticmethod
    def is_daemon_running(pid_file: Path | str | None = None) -> bool:
        """Check whether a daemon process is alive based on its PID file."""
        pid = EmbeddedBroker.read_pid(pid_file)
        if pid is None:
            return False
        try:
            os.kill(pid, 0)  # signal 0 = existence check
            return True
        except OSError:
            return False


def generate_client_id(component: str, participant_key: str) -> str:
    """Generate a unique MQTT client ID.

    Format: ``claude-comms-{component}-{participant_key}-{random}``

    Parameters
    ----------
    component:
        Subsystem name, e.g. ``"mcp"``, ``"tui"``, ``"log"``.
    participant_key:
        The 8-hex-char participant key.

    Returns
    -------
    str
        A unique client ID string.

    Raises
    ------
    ValueError
        If *component* or *participant_key* is empty or None.
    """
    if not component:
        raise ValueError("component must be a non-empty string")
    if not participant_key:
        raise ValueError("participant_key must be a non-empty string")

    import secrets

    random_suffix = secrets.token_hex(4)
    return f"claude-comms-{component}-{participant_key}-{random_suffix}"
