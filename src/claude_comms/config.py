"""Config management for Claude Comms.

Handles loading/saving YAML config at ~/.claude-comms/config.yaml,
with chmod 600 enforcement and environment variable password resolution.

Exports: load_config, save_config, get_config_path
"""

from __future__ import annotations

import os
import secrets
import stat
import warnings
from pathlib import Path
from typing import Any

import yaml


_DEFAULT_CONFIG: dict[str, Any] = {
    "identity": {
        "key": "",  # Auto-generated on init
        "name": "",
        "type": "human",
    },
    "broker": {
        "mode": "host",
        "host": "127.0.0.1",
        "port": 1883,
        "ws_host": "127.0.0.1",
        "ws_port": 9001,
        "remote_host": "",
        "remote_port": 1883,
        "remote_ws_port": 9001,
        "auth": {
            "enabled": True,
            "username": "comms-user",
            "password": "",
        },
    },
    "mcp": {
        "host": "127.0.0.1",
        "port": 9920,
        "auto_join": ["general"],
    },
    "web": {
        "enabled": True,
        "port": 9921,
    },
    "notifications": {
        "hook_enabled": True,
        # sound_enabled is read by the web UI only (SettingsPanel toggle).
        # The Python backend does not use this value.
        "sound_enabled": False,
    },
    "logging": {
        "dir": "~/.claude-comms/logs",
        "format": "both",
        "max_messages_replay": 1000,
        "rotation": {
            "max_size_mb": 50,
            "max_files": 10,
        },
    },
    "default_conversation": "general",
}

_ENV_PASSWORD_VAR = "CLAUDE_COMMS_PASSWORD"


def get_config_path() -> Path:
    """Return the path to the config file (~/.claude-comms/config.yaml)."""
    return Path.home() / ".claude-comms" / "config.yaml"


def generate_identity_key() -> str:
    """Generate an 8-hex-char identity key."""
    return secrets.token_hex(4)


def _deep_merge(base: dict, overlay: dict) -> dict:
    """Recursively merge overlay into base, returning a new dict.

    Values in overlay take precedence. Missing keys in overlay
    are filled from base (provides forward-compatible defaults).
    """
    result = base.copy()
    for key, value in overlay.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _set_file_permissions(path: Path) -> None:
    """Set file to owner-only read/write (chmod 600)."""
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        # On some platforms (e.g., certain Windows/WSL configs) chmod may
        # not work as expected. We warn but don't fail.
        warnings.warn(
            f"Could not set permissions on {path}. "
            "Ensure the file is not world-readable.",
            stacklevel=2,
        )


def load_config(path: Path | None = None) -> dict[str, Any]:
    """Load config from YAML, merged with defaults.

    Args:
        path: Optional override for config file path.
              Defaults to ~/.claude-comms/config.yaml.

    Returns:
        Complete config dict with all defaults filled in.
    """
    if path is None:
        path = get_config_path()

    if path.exists():
        with open(path) as f:
            user_config = yaml.safe_load(f) or {}
        config = _deep_merge(_DEFAULT_CONFIG, user_config)
    else:
        config = _DEFAULT_CONFIG.copy()

    # Resolve password via env var chain
    config = _resolve_password(config)

    return config


def _resolve_password(config: dict[str, Any]) -> dict[str, Any]:
    """Apply the password resolution chain and return the updated config.

    Priority:
    1. ``CLAUDE_COMMS_PASSWORD`` environment variable (highest)
    2. ``broker.auth.password`` from YAML config
    3. Emits a warning if both are empty and auth is enabled
    """
    env_password = os.environ.get(_ENV_PASSWORD_VAR, "")

    if env_password:
        config["broker"]["auth"]["password"] = env_password
    else:
        yaml_password = config.get("broker", {}).get("auth", {}).get("password", "")
        if not yaml_password and config.get("broker", {}).get("auth", {}).get("enabled", False):
            warnings.warn(
                "MQTT auth is enabled but no password is set. "
                f"Set {_ENV_PASSWORD_VAR} env var or broker.auth.password in config.",
                stacklevel=3,
            )

    return config


def save_config(config: dict[str, Any], path: Path | None = None) -> Path:
    """Save config dict to YAML with chmod 600.

    Args:
        config: Config dict to save.
        path: Optional override for config file path.

    Returns:
        Path to the saved config file.
    """
    if path is None:
        path = get_config_path()

    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)

    _set_file_permissions(path)

    return path


def _default_username() -> str:
    """Return the current OS username for use as a default display name."""
    import getpass

    try:
        return getpass.getuser()
    except Exception:
        return "unnamed"


def get_default_config() -> dict[str, Any]:
    """Return a copy of the default config with a fresh identity key and default name."""
    import copy

    config = copy.deepcopy(_DEFAULT_CONFIG)
    config["identity"]["key"] = generate_identity_key()
    config["identity"]["name"] = _default_username()
    return config
