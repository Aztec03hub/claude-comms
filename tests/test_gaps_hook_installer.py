"""Gap tests for hook_installer.py.

Covers:
- hook_enabled config check edge cases
- Windows template generation details
- Uninstall flow edge cases
- install_hook validation (whitespace key, invalid key)
- _is_claude_comms_hook_entry edge cases
"""

from __future__ import annotations

import json
import stat
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
    _is_claude_comms_hook_entry,
    _load_settings,
    _remove_hook_from_settings,
    _save_settings,
    generate_hook_script,
    install_hook,
    uninstall_hook,
)


SAMPLE_KEY = "deadbeef"


@pytest.fixture()
def mock_home(tmp_path, monkeypatch):
    """Fake home with valid config."""
    home = tmp_path / "fakehome"
    home.mkdir()
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    config_dir = home / ".claude-comms"
    config_dir.mkdir(parents=True)
    config_path = config_dir / "config.yaml"
    config_path.write_text(
        f"identity:\n  key: {SAMPLE_KEY}\n  name: test\n  type: claude\n"
    )
    return home


# --- hook_enabled config edge cases ---


class TestHookEnabledCheck:
    def test_install_skips_when_hook_enabled_false(self, mock_home):
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text(
            f"identity:\n  key: {SAMPLE_KEY}\n  name: test\n  type: claude\n"
            "notifications:\n  hook_enabled: false\n"
        )
        result = install_hook(participant_key=SAMPLE_KEY)
        assert result["skipped"] is True

    def test_install_proceeds_when_notifications_section_missing(self, mock_home):
        """When notifications section is absent, hook_enabled defaults to True."""
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text(
            f"identity:\n  key: {SAMPLE_KEY}\n  name: test\n  type: claude\n"
        )
        result = install_hook(participant_key=SAMPLE_KEY)
        assert "skipped" not in result
        assert result["script_path"].exists()

    def test_install_proceeds_when_hook_enabled_key_missing(self, mock_home):
        """When hook_enabled key is absent, defaults to True."""
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text(
            f"identity:\n  key: {SAMPLE_KEY}\n  name: test\n  type: claude\n"
            "notifications:\n  sound_enabled: true\n"
        )
        result = install_hook(participant_key=SAMPLE_KEY)
        assert "skipped" not in result


# --- Windows template generation details ---


class TestWindowsTemplateGeneration:
    def test_windows_script_contains_notification_file_path(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert f"{SAMPLE_KEY}.jsonl" in script

    def test_windows_script_contains_powershell_json_conversion(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert "ConvertTo-Json" in script

    def test_windows_script_contains_truncation_logic(self):
        """Windows script should truncate (Set-Content) the notif file."""
        script = _generate_windows_script(SAMPLE_KEY)
        assert "Set-Content" in script

    def test_windows_script_has_rem_comments(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert "REM" in script

    def test_windows_script_checks_file_existence(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert "if not exist" in script

    def test_generate_hook_script_dispatches_to_windows(self):
        with patch("claude_comms.hook_installer._is_windows", return_value=True):
            script = generate_hook_script(SAMPLE_KEY)
        assert "@echo off" in script
        assert "powershell" in script


# --- install_hook validation edge cases ---


class TestInstallValidation:
    def test_install_raises_on_whitespace_key(self, mock_home):
        with pytest.raises(ValueError, match="non-empty string"):
            install_hook(participant_key="   ")

    def test_install_raises_on_empty_string_key(self, mock_home):
        """Empty string passed explicitly should raise."""
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text(
            "identity:\n  key: somekey1\n  name: test\n  type: claude\n"
        )
        with pytest.raises(ValueError, match="non-empty string"):
            install_hook(participant_key="")


# --- Uninstall edge cases ---


class TestUninstallEdgeCases:
    def test_uninstall_with_empty_key_in_config(self, mock_home):
        """Uninstall with empty key in config returns noop."""
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text(
            "identity:\n  key: ''\n  name: test\n  type: claude\n"
        )
        result = uninstall_hook()
        assert result["script_removed"] is False
        assert result["settings_updated"] is False

    def test_uninstall_with_corrupt_settings_json(self, mock_home):
        """Uninstall should handle corrupt settings.json gracefully."""
        install_hook(participant_key=SAMPLE_KEY)
        settings_path = mock_home / ".claude" / "settings.json"
        settings_path.write_text("NOT VALID JSON!!!")
        # Should not raise, just log warning
        result = uninstall_hook(participant_key=SAMPLE_KEY)
        # script_removed can be True since script file exists
        assert result["script_removed"] is True

    def test_uninstall_cleans_up_completely(self, mock_home):
        """After uninstall, settings should have no hooks section."""
        install_hook(participant_key=SAMPLE_KEY)
        uninstall_hook(participant_key=SAMPLE_KEY)
        settings_path = mock_home / ".claude" / "settings.json"
        settings = json.loads(settings_path.read_text())
        assert "hooks" not in settings


# --- _is_claude_comms_hook_entry edge cases ---


class TestIsClaudeCommsHookEntry:
    def test_empty_hooks_list(self):
        assert _is_claude_comms_hook_entry({"hooks": []}) is False

    def test_missing_hooks_key(self):
        assert _is_claude_comms_hook_entry({}) is False

    def test_hook_without_command_key(self):
        entry = {"hooks": [{"type": "command"}]}
        assert _is_claude_comms_hook_entry(entry) is False

    def test_multiple_hooks_one_is_comms(self):
        entry = {
            "hooks": [
                {"command": "some-other-hook.sh"},
                {"command": "/path/claude-comms-notify-abc12345.sh"},
            ]
        }
        assert _is_claude_comms_hook_entry(entry) is True
