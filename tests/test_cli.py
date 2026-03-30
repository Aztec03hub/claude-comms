"""Tests for CLI commands (claude_comms.cli).

Tests init, status, config loading, and other CLI behaviors
WITHOUT requiring a running broker or daemon.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any
from unittest.mock import patch, MagicMock

import pytest
from typer.testing import CliRunner

from claude_comms.cli import app
from claude_comms.config import (
    get_default_config,
    load_config,
    save_config,
    get_config_path,
)


runner = CliRunner()


# ===================================================================
# CLI init command
# ===================================================================


class TestInitCommand:
    """Test 'claude-comms init' creates config with defaults."""

    def test_init_creates_config(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["init"])
        assert result.exit_code == 0
        assert config_path.exists()
        assert "Config created" in result.output

    def test_init_sets_name_from_option(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["init", "--name", "phil"])
        assert result.exit_code == 0
        assert "phil" in result.output

        loaded = load_config(config_path)
        assert loaded["identity"]["name"] == "phil"

    def test_init_generates_identity_key(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["init"])
        assert result.exit_code == 0

        loaded = load_config(config_path)
        key = loaded["identity"]["key"]
        assert len(key) == 8
        int(key, 16)  # valid hex

    def test_init_default_name_from_os(self, tmp_path: Path, monkeypatch) -> None:
        """When no --name is given, the OS username is used."""
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["init"])
        assert result.exit_code == 0

        loaded = load_config(config_path)
        # Name should be non-empty (OS username or "unnamed" fallback)
        assert len(loaded["identity"]["name"]) > 0

    def test_init_refuses_overwrite_without_force(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        # Create the config first
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("identity:\n  key: aabbccdd\n")

        result = runner.invoke(app, ["init"])
        assert result.exit_code == 1
        assert "already exists" in result.output

    def test_init_force_overwrites(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("identity:\n  key: aabbccdd\n")

        result = runner.invoke(app, ["init", "--force"])
        assert result.exit_code == 0
        assert "Config created" in result.output

        loaded = load_config(config_path)
        # Key should be freshly generated (different from aabbccdd, most likely)
        assert loaded["identity"]["key"] != ""

    def test_init_creates_logs_directory(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["init"])
        assert result.exit_code == 0

        loaded = load_config(config_path)
        log_dir = Path(loaded["logging"]["dir"]).expanduser()
        assert log_dir.exists()

    def test_init_invalid_type(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["init", "--type", "robot"])
        assert result.exit_code == 1
        assert "Invalid identity type" in result.output

    def test_init_claude_type(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.config.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["init", "--type", "claude", "--name", "test-claude"])
        assert result.exit_code == 0
        loaded = load_config(config_path)
        assert loaded["identity"]["type"] == "claude"


# ===================================================================
# CLI status command
# ===================================================================


class TestStatusCommand:
    """Test 'claude-comms status' output when daemon is/isn't running."""

    def test_status_no_config(self, tmp_path: Path, monkeypatch) -> None:
        """Status should fail gracefully when config doesn't exist."""
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 1
        assert "Config not found" in result.output

    def test_status_daemon_not_running(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        config = get_default_config()
        config["logging"]["dir"] = str(tmp_path / "logs")
        save_config(config, config_path)

        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: None)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "not running" in result.output

    def test_status_daemon_running(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        config = get_default_config()
        config["logging"]["dir"] = str(tmp_path / "logs")
        save_config(config, config_path)

        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: 12345)

        # Mock the broker connectivity probe to avoid actual connection
        async def fake_probe():
            return False

        import asyncio
        monkeypatch.setattr("asyncio.run", lambda coro: False)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "running" in result.output
        assert "12345" in result.output

    def test_status_shows_config_summary(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        config = get_default_config()
        config["identity"]["name"] = "test-phil"
        config["logging"]["dir"] = str(tmp_path / "logs")
        save_config(config, config_path)

        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: None)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "test-phil" in result.output
        assert "9920" in result.output  # MCP port
        assert "general" in result.output  # default conversation

    def test_status_stale_pid(self, tmp_path: Path, monkeypatch) -> None:
        """When PID file exists but daemon not running, show stale info."""
        config_path = tmp_path / ".claude-comms" / "config.yaml"
        config = get_default_config()
        config["logging"]["dir"] = str(tmp_path / "logs")
        save_config(config, config_path)

        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: 99999)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "not running" in result.output
        assert "stale" in result.output


# ===================================================================
# Config loading with env var password resolution
# ===================================================================


class TestConfigEnvPasswordResolution:
    """Test config loading with CLAUDE_COMMS_PASSWORD env var."""

    def test_env_var_overrides_yaml_password(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["password"] = "yaml-pass"
        save_config(config, config_path)

        monkeypatch.setenv("CLAUDE_COMMS_PASSWORD", "env-pass")
        loaded = load_config(config_path)
        assert loaded["broker"]["auth"]["password"] == "env-pass"

    def test_yaml_password_used_when_no_env(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["password"] = "yaml-only"
        save_config(config, config_path)

        monkeypatch.delenv("CLAUDE_COMMS_PASSWORD", raising=False)
        loaded = load_config(config_path)
        assert loaded["broker"]["auth"]["password"] == "yaml-only"

    def test_warning_when_auth_enabled_no_password(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["enabled"] = True
        config["broker"]["auth"]["password"] = ""
        save_config(config, config_path)

        monkeypatch.delenv("CLAUDE_COMMS_PASSWORD", raising=False)
        import warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            loaded = load_config(config_path)
            password_warnings = [x for x in w if "password" in str(x.message).lower()]
            assert len(password_warnings) >= 1

    def test_no_warning_when_auth_disabled(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "config.yaml"
        config = get_default_config()
        config["broker"]["auth"]["enabled"] = False
        config["broker"]["auth"]["password"] = ""
        save_config(config, config_path)

        monkeypatch.delenv("CLAUDE_COMMS_PASSWORD", raising=False)
        import warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            loaded = load_config(config_path)
            password_warnings = [x for x in w if "password" in str(x.message).lower()]
            assert len(password_warnings) == 0

    def test_deep_merge_fills_defaults(self, tmp_path: Path, monkeypatch) -> None:
        """A minimal config file should be merged with all defaults."""
        config_path = tmp_path / "config.yaml"
        config_path.write_text("identity:\n  key: aabbccdd\n  name: partial\n  type: human\n")

        monkeypatch.delenv("CLAUDE_COMMS_PASSWORD", raising=False)
        loaded = load_config(config_path)

        # All defaults should be filled in
        assert loaded["broker"]["port"] == 1883
        assert loaded["mcp"]["port"] == 9920
        assert loaded["web"]["port"] == 9921
        assert loaded["default_conversation"] == "general"
        assert loaded["logging"]["format"] == "both"
