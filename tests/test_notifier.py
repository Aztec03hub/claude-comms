"""Tests for claude_comms.notifier.NotificationWriter (F1).

The writer appends per-recipient cue lines to notifications/<key>.jsonl so the
PostToolUse hook can push mid-turn messages. These tests assert delivery
policy, the visibility-leak guard, de-dup, system-message suppression, the
disabled no-op, and JSON-per-line robustness for multi-line / non-ASCII bodies.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from claude_comms.notifier import NotificationWriter


SENDER_KEY = "aaaa0001"
BOB_KEY = "bbbb0002"
CAROL_KEY = "cccc0003"
SYSTEM_KEY = "00000000"


# --- Fakes for the broadcast (registry) path ---


@dataclass
class _FakeParticipant:
    key: str
    name: str


class _FakeRegistry:
    def __init__(self, members):
        self._members = members

    def members(self, _conversation):  # matches real signature
        return list(self._members)


# --- Fixtures ---


@pytest.fixture
def notif_dir(tmp_path):
    d = tmp_path / "notifications"
    # Intentionally NOT pre-created — write() must mkdir it.
    return d


def _whisper_msg(body="hi bob"):
    return {
        "id": "m1",
        "conv": "general",
        "sender": {"key": SENDER_KEY, "name": "Alice", "type": "claude"},
        "recipients": [BOB_KEY],
        "mentions": None,
        "body": body,
    }


def _mention_msg(mentions, body="hey folks"):
    return {
        "id": "m2",
        "conv": "general",
        "sender": {"key": SENDER_KEY, "name": "Alice", "type": "claude"},
        "recipients": None,
        "mentions": mentions,
        "body": body,
    }


def _broadcast_msg(body="hello everyone"):
    return {
        "id": "m3",
        "conv": "general",
        "sender": {"key": SENDER_KEY, "name": "Alice", "type": "claude"},
        "recipients": None,
        "mentions": None,
        "body": body,
    }


def _system_msg():
    return {
        "id": "m4",
        "conv": "general",
        "sender": {"key": SYSTEM_KEY, "name": "system", "type": "system"},
        "recipients": None,
        "mentions": None,
        "body": "[artifact] Alice updated 'doc' to v2",
    }


def _read_lines(notif_dir, key):
    path = notif_dir / f"{key}.jsonl"
    if not path.exists():
        return []
    return [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


# --- Whisper ---


class TestWhisper:
    def test_whisper_cues_only_recipient(self, notif_dir):
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        n = w.write(_whisper_msg())
        assert n == 1
        bob = _read_lines(notif_dir, BOB_KEY)
        assert len(bob) == 1
        payload = json.loads(bob[0])
        assert payload == {
            "conversation": "general",
            "sender_name": "Alice",
            "sender_key": SENDER_KEY,
            "body": "hi bob",
        }

    def test_whisper_does_not_leak_to_non_recipient(self, notif_dir):
        """Visibility leak guard: a whisper must NEVER touch a non-recipient."""
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        w.write(_whisper_msg())
        # Carol was not a recipient — her file must not exist / be empty.
        assert _read_lines(notif_dir, CAROL_KEY) == []
        # Sender must not self-cue either.
        assert _read_lines(notif_dir, SENDER_KEY) == []


# --- Mention ---


class TestMention:
    def test_mention_cues_non_sender(self, notif_dir):
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        n = w.write(_mention_msg([BOB_KEY]))
        assert n == 1
        assert len(_read_lines(notif_dir, BOB_KEY)) == 1

    def test_mention_excludes_sender(self, notif_dir):
        """A self-@mention must not generate a self-cue."""
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        n = w.write(_mention_msg([SENDER_KEY, BOB_KEY]))
        assert n == 1
        assert _read_lines(notif_dir, SENDER_KEY) == []
        assert len(_read_lines(notif_dir, BOB_KEY)) == 1


# --- Broadcast ---


class TestBroadcast:
    def test_plain_broadcast_no_cues_by_default(self, notif_dir):
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        n = w.write(_broadcast_msg())
        assert n == 0
        assert _read_lines(notif_dir, BOB_KEY) == []
        assert _read_lines(notif_dir, CAROL_KEY) == []

    def test_broadcast_cues_other_members_when_enabled(self, notif_dir):
        registry = _FakeRegistry(
            [
                _FakeParticipant(SENDER_KEY, "Alice"),
                _FakeParticipant(BOB_KEY, "Bob"),
                _FakeParticipant(CAROL_KEY, "Carol"),
            ]
        )
        w = NotificationWriter(
            notif_dir,
            enabled=True,
            cue_on_broadcast=True,
            registry_provider=lambda: registry,  # pyright: ignore[reportArgumentType]
        )
        n = w.write(_broadcast_msg())
        # Bob + Carol cued, sender excluded.
        assert n == 2
        assert len(_read_lines(notif_dir, BOB_KEY)) == 1
        assert len(_read_lines(notif_dir, CAROL_KEY)) == 1
        assert _read_lines(notif_dir, SENDER_KEY) == []

    def test_broadcast_enabled_but_no_registry_no_crash(self, notif_dir):
        """cue_on_broadcast=True with no provider must degrade to no cues."""
        w = NotificationWriter(
            notif_dir, enabled=True, cue_on_broadcast=True, registry_provider=None
        )
        n = w.write(_broadcast_msg())
        assert n == 0


# --- System message ---


class TestSystem:
    def test_system_message_never_cues(self, notif_dir):
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=True)
        # Even if the system msg somehow carried recipients, it must be skipped.
        msg = _system_msg()
        msg["recipients"] = [BOB_KEY]  # pyright: ignore[reportArgumentType]
        n = w.write(msg)
        assert n == 0
        assert _read_lines(notif_dir, BOB_KEY) == []


# --- Disabled no-op ---


class TestDisabled:
    def test_disabled_writes_nothing(self, notif_dir):
        w = NotificationWriter(notif_dir, enabled=False, cue_on_broadcast=False)
        n = w.write(_whisper_msg())
        assert n == 0
        assert not notif_dir.exists() or _read_lines(notif_dir, BOB_KEY) == []


# --- De-dup ---


class TestDedup:
    def test_recipient_and_mention_overlap_one_line(self, notif_dir):
        """A participant both whispered AND mentioned gets exactly one cue."""
        msg = {
            "id": "m5",
            "conv": "general",
            "sender": {"key": SENDER_KEY, "name": "Alice", "type": "claude"},
            "recipients": [BOB_KEY],
            "mentions": [BOB_KEY],
            "body": "double-targeted",
        }
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        n = w.write(msg)
        assert n == 1
        assert len(_read_lines(notif_dir, BOB_KEY)) == 1


# --- JSON-per-line robustness ---


class TestLineRobustness:
    def test_multiline_unicode_body_is_one_line(self, notif_dir):
        body = 'line one\nline two\twith tab "quoted" and unicode: café 日本語 🎉'
        w = NotificationWriter(notif_dir, enabled=True, cue_on_broadcast=False)
        w.write(_whisper_msg(body=body))
        path = notif_dir / f"{BOB_KEY}.jsonl"
        raw = path.read_text(encoding="utf-8")
        # Exactly one physical line (one trailing newline, no embedded raw \n).
        physical_lines = raw.split("\n")
        assert physical_lines[-1] == ""  # trailing newline
        assert len([ln for ln in physical_lines if ln]) == 1
        # Round-trips through json with body preserved verbatim.
        payload = json.loads(raw.strip())
        assert payload["body"] == body
