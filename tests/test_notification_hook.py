"""Tests for the Claude Comms notification hook installer and scripts.

Tests cover:
- Hook script generation for Unix and Windows
- Hook installation (script file + settings.json)
- Hook uninstallation (cleanup)
- Settings.json manipulation (add, replace, remove)
- Notification file reading via subprocess (integration)
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_comms.hook_installer import (
    _add_hook_to_settings,
    _build_hook_entry,
    _generate_unix_script,
    _generate_windows_script,
    _hook_script_name,
    _hook_script_path,
    _is_claude_comms_hook_entry,
    _load_settings,
    _remove_hook_from_settings,
    _save_settings,
    generate_hook_script,
    install_hook,
    uninstall_hook,
)


SAMPLE_KEY = "a3f7b2c1"


# --- Script generation ---


class TestScriptGeneration:
    """Tests for hook script content generation."""

    def test_unix_script_contains_key(self):
        script = _generate_unix_script(SAMPLE_KEY)
        assert SAMPLE_KEY in script

    def test_unix_script_has_shebang(self):
        script = _generate_unix_script(SAMPLE_KEY)
        assert script.startswith("#!/bin/bash")

    def test_unix_script_drains_stdin(self):
        script = _generate_unix_script(SAMPLE_KEY)
        assert "cat > /dev/null" in script

    def test_unix_script_checks_notification_file(self):
        script = _generate_unix_script(SAMPLE_KEY)
        assert f"{SAMPLE_KEY}.jsonl" in script

    def test_unix_script_truncates_file(self):
        script = _generate_unix_script(SAMPLE_KEY)
        assert '> "$NOTIF_FILE"' in script

    def test_unix_script_outputs_json(self):
        script = _generate_unix_script(SAMPLE_KEY)
        assert "hookSpecificOutput" in script
        assert "PostToolUse" in script
        assert "additionalContext" in script

    def test_windows_script_contains_key(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert SAMPLE_KEY in script

    def test_windows_script_has_echo_off(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert script.startswith("@echo off")

    def test_windows_script_drains_stdin(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert "more > nul" in script

    def test_windows_script_uses_powershell(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert "powershell" in script

    def test_windows_script_outputs_json(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert "hookSpecificOutput" in script
        assert "PostToolUse" in script

    @patch("claude_comms.hook_installer._is_windows", return_value=False)
    def test_generate_hook_script_unix(self, _mock):
        script = generate_hook_script(SAMPLE_KEY)
        assert script.startswith("#!/bin/bash")

    @patch("claude_comms.hook_installer._is_windows", return_value=True)
    def test_generate_hook_script_windows(self, _mock):
        script = generate_hook_script(SAMPLE_KEY)
        assert script.startswith("@echo off")


# --- Script naming ---


class TestScriptNaming:
    """Tests for hook script file naming."""

    @patch("claude_comms.hook_installer._is_windows", return_value=False)
    def test_unix_script_name(self, _mock):
        name = _hook_script_name(SAMPLE_KEY)
        assert name == f"claude-comms-notify-{SAMPLE_KEY}.sh"

    @patch("claude_comms.hook_installer._is_windows", return_value=True)
    def test_windows_script_name(self, _mock):
        name = _hook_script_name(SAMPLE_KEY)
        assert name == f"claude-comms-notify-{SAMPLE_KEY}.cmd"

    @patch("claude_comms.hook_installer._is_windows", return_value=False)
    def test_script_path_under_claude_hooks(self, _mock):
        path = _hook_script_path(SAMPLE_KEY)
        assert path.parent.name == "hooks"
        assert path.parent.parent.name == ".claude"


# --- Settings.json manipulation ---


class TestSettingsManipulation:
    """Tests for Claude Code settings.json read/write."""

    def test_load_settings_missing_file(self, tmp_path):
        path = tmp_path / "nonexistent.json"
        result = _load_settings(path)
        assert result == {}

    def test_load_settings_valid_json(self, tmp_path):
        path = tmp_path / "settings.json"
        path.write_text('{"foo": "bar"}')
        result = _load_settings(path)
        assert result == {"foo": "bar"}

    def test_load_settings_invalid_json(self, tmp_path):
        path = tmp_path / "settings.json"
        path.write_text("not json at all")
        result = _load_settings(path)
        assert result == {}

    def test_save_settings_creates_file(self, tmp_path):
        path = tmp_path / "subdir" / "settings.json"
        _save_settings({"test": True}, path)
        assert path.exists()
        data = json.loads(path.read_text())
        assert data == {"test": True}

    def test_save_settings_pretty_format(self, tmp_path):
        path = tmp_path / "settings.json"
        _save_settings({"a": 1}, path)
        content = path.read_text()
        assert "\n" in content  # Pretty-printed, not compact

    def test_build_hook_entry(self):
        entry = _build_hook_entry(SAMPLE_KEY)
        assert entry["matcher"] == ""
        assert len(entry["hooks"]) == 1
        hook = entry["hooks"][0]
        assert hook["type"] == "command"
        assert f"claude-comms-notify-{SAMPLE_KEY}" in hook["command"]
        assert hook["timeout"] == 5

    def test_is_claude_comms_hook_entry_true(self):
        entry = {
            "hooks": [{"command": "/path/to/claude-comms-notify-abc123.sh"}]
        }
        assert _is_claude_comms_hook_entry(entry) is True

    def test_is_claude_comms_hook_entry_false(self):
        entry = {
            "hooks": [{"command": "/some/other/hook.sh"}]
        }
        assert _is_claude_comms_hook_entry(entry) is False

    def test_add_hook_to_empty_settings(self):
        settings = {}
        result = _add_hook_to_settings(settings, SAMPLE_KEY)
        assert "hooks" in result
        assert "PostToolUse" in result["hooks"]
        assert len(result["hooks"]["PostToolUse"]) == 1

    def test_add_hook_preserves_other_hooks(self):
        settings = {
            "hooks": {
                "PostToolUse": [
                    {"matcher": "Bash", "hooks": [{"command": "other-hook.sh"}]}
                ]
            }
        }
        result = _add_hook_to_settings(settings, SAMPLE_KEY)
        # Should have both: the existing one + our new one
        assert len(result["hooks"]["PostToolUse"]) == 2

    def test_add_hook_replaces_existing_comms_hook(self):
        old_key = "old12345"
        settings = {
            "hooks": {
                "PostToolUse": [
                    _build_hook_entry(old_key),
                ]
            }
        }
        result = _add_hook_to_settings(settings, SAMPLE_KEY)
        # Old one replaced, only our new one remains
        assert len(result["hooks"]["PostToolUse"]) == 1
        cmd = result["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        assert SAMPLE_KEY in cmd
        assert old_key not in cmd

    def test_remove_hook_from_settings(self):
        settings = _add_hook_to_settings({}, SAMPLE_KEY)
        result = _remove_hook_from_settings(settings)
        assert "hooks" not in result

    def test_remove_hook_preserves_other_hooks(self):
        settings = {
            "hooks": {
                "PostToolUse": [
                    {"matcher": "Bash", "hooks": [{"command": "other-hook.sh"}]},
                    _build_hook_entry(SAMPLE_KEY),
                ]
            }
        }
        result = _remove_hook_from_settings(settings)
        assert len(result["hooks"]["PostToolUse"]) == 1
        assert result["hooks"]["PostToolUse"][0]["matcher"] == "Bash"

    def test_remove_hook_noop_when_absent(self):
        settings = {"other_key": True}
        result = _remove_hook_from_settings(settings)
        assert result == {"other_key": True}


# --- Install / Uninstall (integration with tmp filesystem) ---


class TestInstallUninstall:
    """Integration tests for install_hook / uninstall_hook using tmp dirs."""

    @pytest.fixture()
    def mock_home(self, tmp_path, monkeypatch):
        """Set up a fake home directory with config."""
        home = tmp_path / "fakehome"
        home.mkdir()

        # Patch Path.home() to return our fake home
        monkeypatch.setattr(Path, "home", staticmethod(lambda: home))

        # Create config with a known key
        config_dir = home / ".claude-comms"
        config_dir.mkdir(parents=True)
        config_path = config_dir / "config.yaml"
        config_path.write_text(
            f"identity:\n  key: {SAMPLE_KEY}\n  name: test\n  type: claude\n"
        )

        return home

    def test_install_creates_script(self, mock_home):
        result = install_hook(participant_key=SAMPLE_KEY)
        assert result["script_path"].exists()
        content = result["script_path"].read_text()
        assert SAMPLE_KEY in content

    @pytest.mark.skipif(sys.platform == "win32", reason="Unix permissions test")
    def test_install_script_is_executable(self, mock_home):
        result = install_hook(participant_key=SAMPLE_KEY)
        mode = result["script_path"].stat().st_mode
        assert mode & stat.S_IXUSR  # Owner execute bit set

    def test_install_creates_settings(self, mock_home):
        result = install_hook(participant_key=SAMPLE_KEY)
        assert result["settings_path"].exists()
        settings = json.loads(result["settings_path"].read_text())
        assert "hooks" in settings
        assert "PostToolUse" in settings["hooks"]

    def test_install_creates_notification_dir(self, mock_home):
        install_hook(participant_key=SAMPLE_KEY)
        notif_dir = mock_home / ".claude-comms" / "notifications"
        assert notif_dir.is_dir()

    def test_install_preserves_existing_settings(self, mock_home):
        # Pre-create settings with other content
        settings_path = mock_home / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text('{"existingKey": true}')

        install_hook(participant_key=SAMPLE_KEY)
        settings = json.loads(settings_path.read_text())
        assert settings["existingKey"] is True
        assert "hooks" in settings

    def test_install_loads_key_from_config(self, mock_home):
        # Don't pass participant_key — should load from config
        result = install_hook()
        content = result["script_path"].read_text()
        assert SAMPLE_KEY in content

    def test_install_raises_on_empty_key(self, mock_home):
        # Overwrite config with empty key
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text("identity:\n  key: ''\n  name: test\n  type: claude\n")

        with pytest.raises(ValueError, match="No participant key"):
            install_hook()

    def test_uninstall_removes_script(self, mock_home):
        install_hook(participant_key=SAMPLE_KEY)
        result = uninstall_hook(participant_key=SAMPLE_KEY)
        assert result["script_removed"] is True
        assert not _hook_script_path(SAMPLE_KEY).exists()

    def test_uninstall_updates_settings(self, mock_home):
        install_hook(participant_key=SAMPLE_KEY)
        result = uninstall_hook(participant_key=SAMPLE_KEY)
        assert result["settings_updated"] is True
        settings_path = mock_home / ".claude" / "settings.json"
        settings = json.loads(settings_path.read_text())
        assert "hooks" not in settings

    def test_uninstall_noop_when_not_installed(self, mock_home):
        result = uninstall_hook(participant_key=SAMPLE_KEY)
        assert result["script_removed"] is False
        assert result["settings_updated"] is False

    def test_reinstall_replaces_old(self, mock_home):
        # Install, then reinstall with same key
        install_hook(participant_key=SAMPLE_KEY)
        install_hook(participant_key=SAMPLE_KEY)

        settings_path = mock_home / ".claude" / "settings.json"
        settings = json.loads(settings_path.read_text())
        # Should have exactly one hook entry, not two
        assert len(settings["hooks"]["PostToolUse"]) == 1


# --- Hook script integration test (Unix only) ---


@pytest.mark.skipif(sys.platform == "win32", reason="Unix shell test")
class TestHookScriptExecution:
    """Run the generated hook script and verify JSON output."""

    @pytest.fixture()
    def hook_env(self, tmp_path, monkeypatch):
        """Set up notification file and generate hook script."""
        home = tmp_path / "fakehome"
        home.mkdir()
        monkeypatch.setattr(Path, "home", staticmethod(lambda: home))

        notif_dir = home / ".claude-comms" / "notifications"
        notif_dir.mkdir(parents=True)

        notif_file = notif_dir / f"{SAMPLE_KEY}.jsonl"

        # Generate script
        script_content = _generate_unix_script(SAMPLE_KEY)
        script_path = tmp_path / "hook.sh"
        script_path.write_text(script_content)
        script_path.chmod(script_path.stat().st_mode | stat.S_IXUSR)

        return {
            "home": home,
            "notif_file": notif_file,
            "script_path": script_path,
        }

    def test_hook_exits_silently_when_no_notifications(self, hook_env):
        """Hook should exit 0 with no output when notification file is empty/missing."""
        result = subprocess.run(
            [str(hook_env["script_path"])],
            input="{}",  # Simulate stdin from Claude Code
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "HOME": str(hook_env["home"])},
        )
        assert result.returncode == 0
        assert result.stdout.strip() == ""

    def test_hook_reads_and_outputs_notifications(self, hook_env):
        """Hook should read notifications and output valid JSON."""
        msg = {
            "conversation": "general",
            "sender_key": "b1c2d3e4",
            "sender_name": "TestBot",
            "body": "Hello from the test!",
        }
        hook_env["notif_file"].write_text(json.dumps(msg) + "\n")

        result = subprocess.run(
            [str(hook_env["script_path"])],
            input="{}",
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "HOME": str(hook_env["home"])},
        )
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        assert "hookSpecificOutput" in output
        assert "additionalContext" in output["hookSpecificOutput"]
        ctx = output["hookSpecificOutput"]["additionalContext"]
        assert "#general" in ctx
        assert "@TestBot" in ctx
        assert "Hello from the test!" in ctx

    def test_hook_truncates_notification_file(self, hook_env):
        """After running, the notification file should be empty."""
        msg = {"conversation": "general", "sender_key": "x", "body": "msg"}
        hook_env["notif_file"].write_text(json.dumps(msg) + "\n")

        subprocess.run(
            [str(hook_env["script_path"])],
            input="{}",
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "HOME": str(hook_env["home"])},
        )

        # File should exist but be empty
        assert hook_env["notif_file"].exists()
        assert hook_env["notif_file"].read_text().strip() == ""

    def test_hook_handles_multiple_messages(self, hook_env):
        """Hook should summarize multiple messages."""
        lines = []
        for i in range(3):
            msg = {
                "conversation": "dev",
                "sender_key": f"key{i}",
                "sender_name": f"User{i}",
                "body": f"Message number {i}",
            }
            lines.append(json.dumps(msg))
        hook_env["notif_file"].write_text("\n".join(lines) + "\n")

        result = subprocess.run(
            [str(hook_env["script_path"])],
            input="{}",
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "HOME": str(hook_env["home"])},
        )
        output = json.loads(result.stdout.strip())
        ctx = output["hookSpecificOutput"]["additionalContext"]
        assert "#dev" in ctx
        assert "User0" in ctx or "User1" in ctx or "User2" in ctx
