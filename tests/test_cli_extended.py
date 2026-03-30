"""Extended CLI tests to improve coverage on cli.py.

Covers: stop, send, web, log, tui, conv list/create/delete commands,
_require_config, _version_callback, and various edge cases -- all
WITHOUT requiring a running broker or daemon.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from claude_comms.cli import app, _require_config, _version_callback
from claude_comms.config import get_default_config, save_config


runner = CliRunner()


# ===================================================================
# Helper to set up a temp config + monkeypatch
# ===================================================================


def _setup_config(tmp_path: Path, monkeypatch, **overrides):
    """Create a valid config in tmp_path and monkeypatch CLI to use it."""
    config_path = tmp_path / ".claude-comms" / "config.yaml"
    config = get_default_config()
    config["logging"]["dir"] = str(tmp_path / "logs")
    for k, v in overrides.items():
        # support dotted keys like "identity.name"
        parts = k.split(".")
        target = config
        for part in parts[:-1]:
            target = target[part]
        target[parts[-1]] = v
    save_config(config, config_path)
    monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
    return config_path, config


# ===================================================================
# _require_config helper
# ===================================================================


class TestRequireConfig:
    """Test the _require_config helper directly."""

    def test_require_config_missing(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "nonexistent" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)
        with pytest.raises(typer.Exit):
            _require_config()

    def test_require_config_exists(self, tmp_path: Path, monkeypatch) -> None:
        config_path, _ = _setup_config(tmp_path, monkeypatch)
        result = _require_config()
        assert isinstance(result, dict)
        assert "identity" in result


# ===================================================================
# _version_callback
# ===================================================================


class TestVersionCallback:
    """Test the version callback raises Exit when value is True."""

    def test_callback_true_raises_exit(self) -> None:
        with pytest.raises(typer.Exit):
            _version_callback(True)

    def test_callback_false_does_nothing(self) -> None:
        # Should not raise
        _version_callback(False)


# ===================================================================
# stop command
# ===================================================================


class TestStopCommand:
    """Test 'claude-comms stop' without a real daemon."""

    def test_stop_no_pid_file(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: None)

        result = runner.invoke(app, ["stop"])
        assert result.exit_code == 0
        assert "No daemon running" in result.output

    def test_stop_stale_pid(self, tmp_path: Path, monkeypatch) -> None:
        """When PID exists but process is gone, clean up the stale file."""
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: 999999)

        # os.kill(pid, 0) should raise OSError for nonexistent process
        def fake_kill(pid, sig):
            raise OSError("No such process")

        monkeypatch.setattr("os.kill", fake_kill)
        # Mock _PID_FILE.unlink so it doesn't touch real filesystem
        monkeypatch.setattr("claude_comms.cli._PID_FILE", tmp_path / "daemon.pid")
        (tmp_path / "daemon.pid").write_text("999999")

        result = runner.invoke(app, ["stop"])
        assert result.exit_code == 0
        assert "stale PID file" in result.output


# ===================================================================
# send command
# ===================================================================


class TestSendCommand:
    """Test 'claude-comms send' argument parsing and validation."""

    def test_send_no_config(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "nonexistent" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["send", "hello"])
        assert result.exit_code == 1
        assert "Config not found" in result.output

    def test_send_no_identity_key(self, tmp_path: Path, monkeypatch) -> None:
        config_path, _ = _setup_config(tmp_path, monkeypatch, **{"identity.key": ""})
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)

        result = runner.invoke(app, ["send", "hello"])
        assert result.exit_code == 1
        assert "No identity key" in result.output

    def test_send_daemon_not_running(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)

        result = runner.invoke(app, ["send", "hello"])
        assert result.exit_code == 1
        assert "not running" in result.output

    def test_send_success(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)
        # Mock asyncio.run to skip actual MQTT publish
        monkeypatch.setattr("asyncio.run", lambda coro: None)

        result = runner.invoke(app, ["send", "hello world"])
        assert result.exit_code == 0
        assert "Message sent" in result.output

    def test_send_with_conversation(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)
        monkeypatch.setattr("asyncio.run", lambda coro: None)

        result = runner.invoke(app, ["send", "hi", "-c", "dev-chat"])
        assert result.exit_code == 0
        assert "dev-chat" in result.output

    def test_send_with_recipient(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)
        monkeypatch.setattr("asyncio.run", lambda coro: None)

        result = runner.invoke(app, ["send", "hi", "--to", "@aabb1122"])
        assert result.exit_code == 0
        assert "aabb1122" in result.output

    def test_send_publish_failure(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)

        def raise_conn_error(coro):
            raise ConnectionError("broker down")

        monkeypatch.setattr("asyncio.run", raise_conn_error)

        result = runner.invoke(app, ["send", "hello"])
        assert result.exit_code == 1
        assert "Failed to send" in result.output


# ===================================================================
# web command
# ===================================================================


class TestWebCommand:
    """Test 'claude-comms web' opens browser."""

    def test_web_no_config(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "nonexistent" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["web"])
        assert result.exit_code == 1
        assert "Config not found" in result.output

    def test_web_opens_browser(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: True)

        opened_urls = []
        monkeypatch.setattr("webbrowser.open", lambda url: opened_urls.append(url))

        result = runner.invoke(app, ["web"])
        assert result.exit_code == 0
        assert len(opened_urls) == 1
        assert "9921" in opened_urls[0]

    def test_web_warns_daemon_not_running(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        monkeypatch.setattr("webbrowser.open", lambda url: None)

        result = runner.invoke(app, ["web"])
        assert result.exit_code == 0
        assert "not running" in result.output


# ===================================================================
# tui command
# ===================================================================


class TestTuiCommand:
    """Test 'claude-comms tui' gating logic."""

    def test_tui_no_config(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "nonexistent" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["tui"])
        assert result.exit_code == 1
        assert "Config not found" in result.output

    def test_tui_daemon_not_running(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)

        result = runner.invoke(app, ["tui"])
        assert result.exit_code == 1
        assert "not running" in result.output


# ===================================================================
# log command
# ===================================================================


class TestLogCommand:
    """Test 'claude-comms log' validation."""

    def test_log_no_config(self, tmp_path: Path, monkeypatch) -> None:
        config_path = tmp_path / "nonexistent" / "config.yaml"
        monkeypatch.setattr("claude_comms.cli.get_config_path", lambda: config_path)

        result = runner.invoke(app, ["log"])
        assert result.exit_code == 1
        assert "Config not found" in result.output

    def test_log_file_not_found(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)

        result = runner.invoke(app, ["log"])
        assert result.exit_code == 1
        assert "Log file not found" in result.output

    def test_log_custom_conversation(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)

        result = runner.invoke(app, ["log", "-c", "my-channel"])
        assert result.exit_code == 1
        assert "my-channel" in result.output


# ===================================================================
# conv list command
# ===================================================================


class TestConvListCommand:
    """Test 'claude-comms conv list'."""

    def test_conv_list_no_conversations(self, tmp_path: Path, monkeypatch) -> None:
        config_path, _ = _setup_config(tmp_path, monkeypatch)
        # Override auto_join to empty so no conversations appear
        from claude_comms.config import load_config

        config = load_config(config_path)
        config["mcp"]["auto_join"] = []
        save_config(config, config_path)

        result = runner.invoke(app, ["conv", "list"])
        assert result.exit_code == 0
        assert "No conversations found" in result.output

    def test_conv_list_shows_auto_join(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)

        result = runner.invoke(app, ["conv", "list"])
        assert result.exit_code == 0
        assert "general" in result.output

    def test_conv_list_discovers_log_files(self, tmp_path: Path, monkeypatch) -> None:
        config_path, _ = _setup_config(tmp_path, monkeypatch)
        # Create a log file for a conversation
        log_dir = tmp_path / "logs"
        log_dir.mkdir(exist_ok=True)
        (log_dir / "dev-chat.log").write_text("some log data\n")

        result = runner.invoke(app, ["conv", "list"])
        assert result.exit_code == 0
        assert "dev-chat" in result.output


# ===================================================================
# conv create command
# ===================================================================


class TestConvCreateCommand:
    """Test 'claude-comms conv create' validation."""

    def test_conv_create_invalid_name(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)

        result = runner.invoke(app, ["conv", "create", "INVALID NAME!"])
        assert result.exit_code == 1
        assert "Invalid conversation name" in result.output

    def test_conv_create_daemon_not_running(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)

        result = runner.invoke(app, ["conv", "create", "valid-name"])
        assert result.exit_code == 1
        assert "not running" in result.output


# ===================================================================
# conv delete command
# ===================================================================


class TestConvDeleteCommand:
    """Test 'claude-comms conv delete' validation."""

    def test_conv_delete_invalid_name(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)

        result = runner.invoke(app, ["conv", "delete", "BAD NAME!!"])
        assert result.exit_code == 1
        assert "Invalid conversation name" in result.output

    def test_conv_delete_daemon_not_running(self, tmp_path: Path, monkeypatch) -> None:
        _setup_config(tmp_path, monkeypatch)
        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)

        result = runner.invoke(app, ["conv", "delete", "--force", "test-conv"])
        assert result.exit_code == 1
        assert "not running" in result.output


# ===================================================================
# status: remote broker mode display
# ===================================================================


class TestStatusRemoteBroker:
    """Test status output when broker mode is 'remote'."""

    def test_status_remote_mode(self, tmp_path: Path, monkeypatch) -> None:
        config_path, _ = _setup_config(tmp_path, monkeypatch)
        from claude_comms.config import load_config

        config = load_config(config_path)
        config["broker"]["mode"] = "remote"
        config["broker"]["remote_host"] = "mqtt.example.com"
        config["broker"]["remote_port"] = 8883
        save_config(config, config_path)

        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: None)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "mqtt.example.com" in result.output
        assert "8883" in result.output


# ===================================================================
# status: web enabled display
# ===================================================================


class TestStatusWebEnabled:
    """Test status shows web UI as enabled/disabled."""

    def test_status_web_enabled(self, tmp_path: Path, monkeypatch) -> None:
        config_path, _ = _setup_config(tmp_path, monkeypatch)
        from claude_comms.config import load_config

        config = load_config(config_path)
        config["web"]["enabled"] = True
        save_config(config, config_path)

        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: None)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "enabled" in result.output

    def test_status_web_disabled(self, tmp_path: Path, monkeypatch) -> None:
        config_path, _ = _setup_config(tmp_path, monkeypatch)
        from claude_comms.config import load_config

        config = load_config(config_path)
        config["web"]["enabled"] = False
        save_config(config, config_path)

        monkeypatch.setattr("claude_comms.cli._is_daemon_running", lambda: False)
        monkeypatch.setattr("claude_comms.cli._read_pid", lambda: None)

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "disabled" in result.output
