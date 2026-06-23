"""Spawn and tear down a real claude-comms daemon for agent harness runs.

Mirrors the e2e fixture (web/e2e/fixtures/daemon.ts) but in Python and for a
non-browser workload: we don't need the static web UI, so it is disabled and
the MQTT ports are free-floating (they no longer have to be pinned to 1883/9001
for the hardcoded web client). Every daemon path derives from ``Path.home()``,
so the only knob we need is a ``HOME`` override on the spawned process.

The daemon is launched through ``.venv/bin/claude-comms`` so module resolution
comes from the venv interpreter's own site-packages (independent of HOME),
which sidesteps the PYTHONPATH/typing_extensions shadowing the e2e fixture has
to work around.
"""

from __future__ import annotations

import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
VENV_DAEMON = REPO_ROOT / ".venv" / "bin" / "claude-comms"
READY_MARKER = "Daemon running"


@dataclass
class DaemonPorts:
    mcp: int = 9940
    mqtt_tcp: int = 1893
    mqtt_ws: int = 9011


@dataclass
class DaemonHandle:
    proc: subprocess.Popen
    ports: DaemonPorts
    home: Path
    data_dir: Path
    owner: dict  # {key, name, type} of the daemon-owner identity
    log_path: Path
    _stdout_lines: list = field(default_factory=list)

    @property
    def mcp_url(self) -> str:
        return f"http://127.0.0.1:{self.ports.mcp}/mcp"

    @property
    def api_url(self) -> str:
        return f"http://127.0.0.1:{self.ports.mcp}"

    @property
    def notifications_dir(self) -> Path:
        return self.data_dir / "notifications"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def registry_db(self) -> Path:
        return self.data_dir / "registry.db"

    def stdout_text(self) -> str:
        return "".join(self._stdout_lines)


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _build_config_yaml(owner: dict, ports: DaemonPorts) -> str:
    """Full config.yaml overriding every default. Auth disabled, web off.

    presence TTL/sweep are short so the harness can observe join/leave presence
    transitions within a run. hook_enabled stays True so that any daemon-side
    notification writer (if one exists) is exercised — the harness measures
    whether the per-recipient notification file is ever actually written.
    """
    return "\n".join(
        [
            "identity:",
            f'  key: "{owner["key"]}"',
            f'  name: "{owner["name"]}"',
            f'  type: "{owner["type"]}"',
            "broker:",
            '  mode: "host"',
            '  host: "127.0.0.1"',
            f"  port: {ports.mqtt_tcp}",
            '  ws_host: "127.0.0.1"',
            f"  ws_port: {ports.mqtt_ws}",
            "  auth:",
            "    enabled: false",
            '    username: "comms-user"',
            '    password: "harness-password"',
            "mcp:",
            '  host: "127.0.0.1"',
            f"  port: {ports.mcp}",
            "  auto_join:",
            '    - "general"',
            "web:",
            "  enabled: false",
            "notifications:",
            "  hook_enabled: true",
            "  sound_enabled: false",
            "presence:",
            "  connection_ttl_seconds: 60",
            "  sweep_interval_seconds: 10",
            "logging:",
            '  format: "both"',
            "  max_messages_replay: 1000",
            'default_conversation: "general"',
            "",
        ]
    )


def spawn_daemon(
    owner: dict | None = None,
    ports: DaemonPorts | None = None,
    startup_timeout_s: float = 25.0,
) -> DaemonHandle:
    """Spawn an isolated claude-comms daemon and block until it is ready."""
    owner = owner or {"key": "ab01cd23", "name": "harness", "type": "human"}
    ports = ports or DaemonPorts()

    for label, p in (
        ("mcp", ports.mcp),
        ("mqtt_tcp", ports.mqtt_tcp),
        ("mqtt_ws", ports.mqtt_ws),
    ):
        if not _port_free(p):
            raise RuntimeError(
                f"harness port {p} ({label}) in use. Stop any dev daemon "
                f"(`claude-comms stop`) or pick other ports."
            )
    if not VENV_DAEMON.exists():
        raise RuntimeError(f"daemon entrypoint not found: {VENV_DAEMON}")

    home = Path(tempfile.mkdtemp(prefix="cc-harness-"))
    data_dir = home / ".claude-comms"
    for sub in ("logs", "conversations", "artifacts", "notifications"):
        (data_dir / sub).mkdir(parents=True, exist_ok=True)
    (data_dir / "config.yaml").write_text(_build_config_yaml(owner, ports))
    (data_dir / "config.yaml").chmod(0o600)

    env = dict(os.environ)
    env["HOME"] = str(home)
    env.pop("PYTHONPATH", None)  # venv interpreter resolves its own packages

    log_path = home / "daemon.out"
    log_fh = open(log_path, "w")
    proc = subprocess.Popen(
        [str(VENV_DAEMON), "start"],
        cwd=str(home),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    handle = DaemonHandle(
        proc=proc,
        ports=ports,
        home=home,
        data_dir=data_dir,
        owner=owner,
        log_path=log_path,
    )
    ready = threading.Event()

    def _drain() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            handle._stdout_lines.append(line)
            log_fh.write(line)
            log_fh.flush()
            if READY_MARKER in line:
                ready.set()
        log_fh.close()

    threading.Thread(target=_drain, daemon=True).start()

    if not ready.wait(timeout=startup_timeout_s):
        tail = handle.stdout_text()[-2000:]
        _terminate(proc)
        raise RuntimeError(
            f"daemon did not report '{READY_MARKER}' within {startup_timeout_s}s.\n"
            f"--- daemon output tail ---\n{tail}"
        )
    # Brief settle so the MCP HTTP app and broker finish binding.
    time.sleep(1.0)
    return handle


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def stop_daemon(handle: DaemonHandle, keep_home: bool = False) -> None:
    """SIGTERM the daemon and (optionally) remove its isolated HOME."""
    _terminate(handle.proc)
    if not keep_home:
        shutil.rmtree(handle.home, ignore_errors=True)
