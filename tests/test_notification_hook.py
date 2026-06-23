"""Tests for the Claude Comms notification hook installer and scripts.

Tests cover:
- The /api/notifications/{key} fetch-and-drain endpoint (Starlette TestClient)
- Hook script generation for Unix and Windows (now HTTP-fetch based)
- Hook formatter robustness against hostile cue bodies (injection-safe)
- Hook installation (script file + settings.json)
- Hook uninstallation (cleanup)
- Settings.json manipulation (add, replace, remove)

The hook is HTTP-based now: it pulls queued cues from the daemon's
``/api/notifications/<key>`` endpoint (which drains them server-side) instead
of reading a local file, so it works against a REMOTE daemon. The old
local-file-read e2e tests have been replaced accordingly.
"""

from __future__ import annotations

import json
import stat
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from claude_comms.cli import build_notifications_route
from claude_comms.hook_installer import (
    _PY_FORMATTER,
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
SAMPLE_URL = "http://daemon-host:9920"


# --- /api/notifications/{key} endpoint ---


class TestNotificationsEndpoint:
    """GET /api/notifications/{key} fetch-and-drain via Starlette TestClient.

    Points hook_installer._notification_dir() at a tmp dir so the route reads
    real .jsonl files written by the test.
    """

    @pytest.fixture()
    def client(self, tmp_path, monkeypatch):
        notif_dir = tmp_path / "notifications"
        notif_dir.mkdir()
        monkeypatch.setattr(
            "claude_comms.hook_installer._notification_dir",
            lambda: notif_dir,
        )
        app = Starlette(routes=[build_notifications_route({})])
        return TestClient(app), notif_dir

    def test_returns_cues_and_drains(self, client):
        tc, notif_dir = client
        notif_file = notif_dir / f"{SAMPLE_KEY}.jsonl"
        cues = [
            {"conversation": "general", "sender_name": "Alice", "body": "hi"},
            {"conversation": "dev", "sender_key": "b1c2d3e4", "body": "yo"},
        ]
        notif_file.write_text("\n".join(json.dumps(c) for c in cues) + "\n")

        resp = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 2
        assert data["cues"] == cues

        # Drained: the file is now empty.
        assert notif_file.read_text().strip() == ""

    def test_second_get_returns_empty(self, client):
        tc, notif_dir = client
        notif_file = notif_dir / f"{SAMPLE_KEY}.jsonl"
        notif_file.write_text(json.dumps({"conversation": "g", "body": "x"}) + "\n")

        first = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        assert first.json()["count"] == 1

        second = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        assert second.status_code == 200
        assert second.json() == {"cues": [], "count": 0}

    def test_missing_file_returns_empty(self, client):
        tc, _ = client
        resp = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        assert resp.status_code == 200
        assert resp.json() == {"cues": [], "count": 0}

    def test_malformed_lines_skipped(self, client):
        tc, notif_dir = client
        notif_file = notif_dir / f"{SAMPLE_KEY}.jsonl"
        notif_file.write_text(
            json.dumps({"conversation": "g", "body": "ok"})
            + "\n"
            + "{not valid json\n"
            + "\n"  # blank line
            + json.dumps({"conversation": "g", "body": "ok2"})
            + "\n"
        )
        resp = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        assert resp.json()["count"] == 2

    def test_invalid_key_path_traversal_rejected(self, client):
        tc, _ = client
        # A traversal-shaped single segment reaches the handler and is rejected
        # by the 8-hex regex (400). A slash-bearing payload (%2F decodes to "/")
        # never matches the single-segment route at all (404) — also no file
        # served. Both outcomes prevent path traversal.
        assert tc.get("/api/notifications/..%2e").status_code == 400
        assert tc.get("/api/notifications/aaaa..aa").status_code == 400
        assert tc.get("/api/notifications/..%2Fetc").status_code in (400, 404)

    def test_invalid_key_non_hex_rejected(self, client):
        tc, _ = client
        for bad in ("ZZZZZZZZ", "abc", "a3f7b2c12", "A3F7B2C1"):
            resp = tc.get(f"/api/notifications/{bad}")
            assert resp.status_code == 400, bad

    def test_valid_key_accepted(self, client):
        tc, _ = client
        resp = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        assert resp.status_code == 200


# --- Script generation (HTTP-fetch based) ---


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

    def test_unix_script_fetches_over_http(self):
        script = _generate_unix_script(SAMPLE_KEY, SAMPLE_URL)
        assert "curl -fsS --max-time 3" in script
        assert f"{SAMPLE_URL}/api/notifications/{SAMPLE_KEY}" in script

    def test_unix_script_default_base_url(self):
        script = _generate_unix_script(SAMPLE_KEY)
        assert "http://localhost:9920/api/notifications/" in script

    def test_unix_script_no_local_file_read(self):
        script = _generate_unix_script(SAMPLE_KEY)
        # The hook no longer touches a local notification file.
        assert ".jsonl" not in script
        assert "NOTIF_FILE" not in script

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

    def test_windows_script_fetches_over_http(self):
        script = _generate_windows_script(SAMPLE_KEY, SAMPLE_URL)
        assert "Invoke-RestMethod" in script
        assert f"{SAMPLE_URL}/api/notifications/{SAMPLE_KEY}" in script

    def test_windows_script_outputs_json(self):
        script = _generate_windows_script(SAMPLE_KEY)
        assert "hookSpecificOutput" in script
        assert "PostToolUse" in script

    @patch("claude_comms.hook_installer._is_windows", return_value=False)
    def test_generate_hook_script_unix(self, _mock):
        script = generate_hook_script(SAMPLE_KEY)
        assert script.startswith("#!/bin/bash")

    @patch("claude_comms.hook_installer._is_windows", return_value=False)
    def test_generate_hook_script_passes_base_url(self, _mock):
        script = generate_hook_script(SAMPLE_KEY, SAMPLE_URL)
        assert SAMPLE_URL in script
        assert SAMPLE_KEY in script
        assert "curl" in script

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
        entry = {"hooks": [{"command": "/path/to/claude-comms-notify-abc123.sh"}]}
        assert _is_claude_comms_hook_entry(entry) is True

    def test_is_claude_comms_hook_entry_false(self):
        entry = {"hooks": [{"command": "/some/other/hook.sh"}]}
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

    def test_install_creates_script(self, mock_home):  # pyright: ignore[reportUnusedParameter]
        result = install_hook(participant_key=SAMPLE_KEY)
        assert result["script_path"].exists()
        content = result["script_path"].read_text()
        assert SAMPLE_KEY in content

    @pytest.mark.skipif(sys.platform == "win32", reason="Unix permissions test")
    def test_install_script_is_executable(self, mock_home):  # pyright: ignore[reportUnusedParameter]
        result = install_hook(participant_key=SAMPLE_KEY)
        mode = result["script_path"].stat().st_mode
        assert mode & stat.S_IXUSR  # Owner execute bit set

    def test_install_creates_settings(self, mock_home):  # pyright: ignore[reportUnusedParameter]
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

    def test_install_loads_key_from_config(self, mock_home):  # pyright: ignore[reportUnusedParameter]
        # Don't pass participant_key — should load from config
        result = install_hook()
        content = result["script_path"].read_text()
        assert SAMPLE_KEY in content

    def test_install_bakes_base_url(self, mock_home):  # pyright: ignore[reportUnusedParameter]
        result = install_hook(participant_key=SAMPLE_KEY, base_url=SAMPLE_URL)
        content = result["script_path"].read_text()
        assert SAMPLE_URL in content
        assert f"/api/notifications/{SAMPLE_KEY}" in content

    def test_install_default_base_url(self, mock_home):  # pyright: ignore[reportUnusedParameter]
        result = install_hook(participant_key=SAMPLE_KEY)
        content = result["script_path"].read_text()
        assert "http://localhost:9920/api/notifications/" in content

    def test_install_raises_on_empty_key(self, mock_home):
        # Overwrite config with empty key
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text("identity:\n  key: ''\n  name: test\n  type: claude\n")

        with pytest.raises(ValueError, match="No participant key"):
            install_hook()

    def test_uninstall_removes_script(self, mock_home):  # pyright: ignore[reportUnusedParameter]
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

    def test_uninstall_noop_when_not_installed(self, mock_home):  # pyright: ignore[reportUnusedParameter]
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

    def test_install_skips_when_hook_disabled(self, mock_home):
        """install_hook should return skipped result when hook_enabled is False."""
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text(
            f"identity:\n  key: {SAMPLE_KEY}\n  name: test\n  type: claude\n"
            "notifications:\n  hook_enabled: false\n"
        )

        result = install_hook(participant_key=SAMPLE_KEY)
        assert result.get("skipped") is True
        assert "hook_enabled" in result.get("reason", "")
        # No script should have been created
        assert not _hook_script_path(SAMPLE_KEY).exists()

    def test_install_proceeds_when_hook_enabled(self, mock_home):
        """install_hook should install normally when hook_enabled is True."""
        config_path = mock_home / ".claude-comms" / "config.yaml"
        config_path.write_text(
            f"identity:\n  key: {SAMPLE_KEY}\n  name: test\n  type: claude\n"
            "notifications:\n  hook_enabled: true\n"
        )

        result = install_hook(participant_key=SAMPLE_KEY)
        assert "skipped" not in result
        assert result["script_path"].exists()


# --- Hook python formatter robustness (Unix only) ---


def _run_formatter(cues):
    """Run the hook's python3 -c formatter with ``{"cues": ...}`` on stdin,
    exactly as the generated bash hook pipes the daemon's HTTP response into
    it. Returns the CompletedProcess.
    """
    payload = json.dumps({"cues": cues, "count": len(cues)})
    return subprocess.run(
        [sys.executable, "-c", _PY_FORMATTER],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
    )


@pytest.mark.skipif(sys.platform == "win32", reason="Unix shell test")
class TestHookFormatter:
    """The python formatter parses the daemon's JSON response and emits a safe
    additionalContext. No body text is ever interpolated into source."""

    def test_empty_cues_exits_silently(self):
        proc = _run_formatter([])
        assert proc.returncode == 0
        assert proc.stdout.strip() == ""

    def test_single_cue_formats(self):
        cues = [
            {
                "conversation": "general",
                "sender_key": "b1c2d3e4",
                "sender_name": "TestBot",
                "body": "Hello from the test!",
            }
        ]
        proc = _run_formatter(cues)
        assert proc.returncode == 0
        out = json.loads(proc.stdout)
        ctx = out["hookSpecificOutput"]["additionalContext"]
        assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
        assert "#general" in ctx
        assert "@TestBot" in ctx
        assert "Hello from the test!" in ctx

    def test_sender_falls_back_to_key(self):
        proc = _run_formatter(
            [{"conversation": "g", "sender_key": "deadbeef", "body": "x"}]
        )
        ctx = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        assert "@deadbeef" in ctx

    def test_more_than_five_shows_overflow(self):
        cues = [
            {"conversation": "dev", "sender_name": f"User{i}", "body": f"m{i}"}
            for i in range(8)
        ]
        proc = _run_formatter(cues)
        ctx = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        assert "and 3 more message(s)" in ctx
        # Only the last 5 are shown.
        assert "User7" in ctx
        assert "User0" not in ctx

    def test_body_truncated_to_120(self):
        long_body = "z" * 500
        proc = _run_formatter([{"conversation": "g", "body": long_body}])
        ctx = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        assert "z" * 120 in ctx
        assert "z" * 121 not in ctx

    def test_hostile_body_is_inert(self):
        """A cue body containing newlines, quotes, unicode, braces and
        shell/python metacharacters must surface as inert text — never
        executed, never crash the formatter.

        Regression: the old hook interpolated the body into a ``python3 -c``
        source string, so a newline/quote produced a SyntaxError (the whole
        notification was silently dropped) and ``$(...)``/backticks were a
        command-injection vector. The body now arrives as parsed JSON data."""
        sentinel = Path("/tmp/cc_pwned_xyz")
        if sentinel.exists():
            sentinel.unlink()

        body = (
            "l1\nl2 'q' \"dq\" café 日本語 {not:a,dict} $(touch /tmp/cc_pwned_xyz) `id`"
        )
        proc = _run_formatter(
            [
                {
                    "conversation": "general",
                    "sender_name": "al'ice",
                    "body": body,
                }
            ]
        )
        assert proc.returncode == 0, proc.stderr
        out = json.loads(proc.stdout)
        ctx = out["hookSpecificOutput"]["additionalContext"]
        assert "New messages" in ctx
        assert "café 日本語" in ctx
        # The injection payload is surfaced as inert text (within the 120-char
        # truncation window), never executed.
        assert "$(touch /tmp/cc_pwned_xyz)" in ctx
        assert not sentinel.exists()


# --- End-to-end: endpoint -> formatter (the full HTTP delivery path) ---


@pytest.mark.skipif(sys.platform == "win32", reason="Unix shell test")
class TestEndpointToFormatterEndToEnd:
    """A cue written by NotificationWriter must travel the full HTTP path:
    drained by the /api/notifications endpoint and formatted by the hook's
    python pass into additionalContext."""

    @pytest.fixture()
    def env(self, tmp_path, monkeypatch):
        notif_dir = tmp_path / "notifications"
        notif_dir.mkdir()
        monkeypatch.setattr(
            "claude_comms.hook_installer._notification_dir",
            lambda: notif_dir,
        )
        app = Starlette(routes=[build_notifications_route({})])
        return TestClient(app), notif_dir

    def test_writer_cue_surfaces_through_endpoint_and_formatter(self, env):
        from claude_comms.notifier import NotificationWriter

        tc, notif_dir = env
        writer = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        assert (
            writer.write(
                {
                    "id": "e2e1",
                    "conv": "general",
                    "sender": {"key": "b1c2d3e4", "name": "Alice", "type": "claude"},
                    "recipients": [SAMPLE_KEY],
                    "mentions": None,
                    "body": "ping from the writer",
                }
            )
            == 1
        )

        resp = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        assert resp.status_code == 200
        proc = _run_formatter(resp.json()["cues"])
        assert proc.returncode == 0
        ctx = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        assert "#general" in ctx
        assert "@Alice" in ctx
        assert "ping from the writer" in ctx

    def test_hostile_writer_cue_survives_full_path(self, env):
        from claude_comms.notifier import NotificationWriter

        tc, notif_dir = env
        sentinel = Path("/tmp/cc_pwned_e2e")
        if sentinel.exists():
            sentinel.unlink()

        writer = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        body = 'l1\nl2 "q" café 日本語 $(touch /tmp/cc_pwned_e2e) `id`'
        writer.write(
            {
                "id": "hostile1",
                "conv": "general",
                "sender": {"key": "b1c2d3e4", "name": "al'ice", "type": "claude"},
                "recipients": [SAMPLE_KEY],
                "mentions": None,
                "body": body,
            }
        )

        resp = tc.get(f"/api/notifications/{SAMPLE_KEY}")
        proc = _run_formatter(resp.json()["cues"])
        assert proc.returncode == 0, proc.stderr
        ctx = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        assert "New messages" in ctx
        assert "café 日本語" in ctx
        assert "$(touch /tmp/cc_pwned_e2e)" in ctx
        assert not sentinel.exists()
