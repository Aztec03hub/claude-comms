"""Server-side visibility tests for the mentions vs whisper separation.

Covers the §10 test matrix from
``plans/mentions-vs-whisper-separation.md`` (Phase F1, sage-server lane).

Scope: ``_is_visible`` correctness across all visibility states, Pydantic
round-tripping for legacy/new wire formats, sender-key dedup discipline at
``tool_comms_send``, ``tool_comms_check`` cursor-advance + visibility-filter
behaviour, and registry-level mention-resolution validation.

Render-side branches (web vitest, F2) and TUI render parity (F3) are
intentionally NOT in scope here.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from claude_comms.broker import MessageStore
from claude_comms.mcp_tools import (
    ParticipantRegistry,
    _is_visible,
    tool_comms_check,
    tool_comms_send,
)
from claude_comms.message import Message, Sender


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def populated_registry() -> dict[str, Any]:
    """Registry with three participants joined to ``general``.

    Returns a dict with the registry plus the three participant keys keyed by
    name. All three are claude-type for simplicity.
    """
    reg = ParticipantRegistry()
    ember = reg.join("ember", "general")
    sage = reg.join("sage", "general")
    phil = reg.join("phil", "general", participant_type="human")
    return {
        "registry": reg,
        "ember": ember.key,
        "sage": sage.key,
        "phil": phil.key,
    }


def _msg_dict(
    *,
    sender_key: str,
    sender_name: str = "sender",
    sender_type: str = "claude",
    body: str = "hi",
    recipients: list[str] | None = None,
    mentions: list[str] | None = None,
    ts: str = "2026-05-06T10:00:00-05:00",
    msg_id: str = "msg-test-0001",
    conv: str = "general",
) -> dict[str, Any]:
    """Build a wire-format message dict suitable for ``_is_visible`` and the
    in-memory ``MessageStore``.

    Mirrors the JSON shape ``Message.to_mqtt_payload()`` produces — the
    visibility filter operates on dicts, not Pydantic instances, because the
    store keeps deserialized dicts.
    """
    return {
        "id": msg_id,
        "ts": ts,
        "sender": {"key": sender_key, "name": sender_name, "type": sender_type},
        "body": body,
        "recipients": recipients,
        "mentions": mentions,
        "reply_to": None,
        "conv": conv,
    }


# ===========================================================================
# §10 Test #1 — Broadcast
# ===========================================================================


class TestBroadcast:
    def test_broadcast_visible_to_all(self, populated_registry: dict[str, Any]) -> None:
        """`mentions=None, recipients=None` → visible to every viewer."""
        sender_key = populated_registry["phil"]
        msg = _msg_dict(sender_key=sender_key, recipients=None, mentions=None)

        for viewer_key in (
            populated_registry["ember"],
            populated_registry["sage"],
            populated_registry["phil"],
            "ffffffff",  # an unrelated key
        ):
            assert _is_visible(msg, viewer_key) is True


# ===========================================================================
# §10 Test #2 — Mention (broadcast-visible, with highlight intent)
# ===========================================================================


class TestMention:
    def test_mention_visible_to_all(self, populated_registry: dict[str, Any]) -> None:
        """`mentions=[ember], recipients=None` → visible to all (mentions does
        NOT participate in `_is_visible`)."""
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]
        phil = populated_registry["phil"]
        msg = _msg_dict(
            sender_key=phil,
            recipients=None,
            mentions=[ember],
            body="@ember can you check this?",
        )

        # Mentioned user
        assert _is_visible(msg, ember) is True
        # Bystander
        assert _is_visible(msg, sage) is True
        # Sender
        assert _is_visible(msg, phil) is True
        # Stranger not in conversation
        assert _is_visible(msg, "ffffffff") is True


# ===========================================================================
# §10 Test #3 — Whisper
# ===========================================================================


class TestWhisper:
    def test_whisper_visible_only_to_recipients_and_sender(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`recipients=[ember]` → visible to ember + sender; NOT to sage."""
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]
        phil = populated_registry["phil"]
        msg = _msg_dict(sender_key=phil, recipients=[ember], mentions=None)

        # Listed recipient
        assert _is_visible(msg, ember) is True
        # Sender (always sees own messages via sender-key check)
        assert _is_visible(msg, phil) is True
        # Bystander — explicitly excluded
        assert _is_visible(msg, sage) is False
        # Random stranger — also excluded
        assert _is_visible(msg, "ffffffff") is False


# ===========================================================================
# §10 Test #4 — Mention + Whisper (visibility driven by recipients only)
# ===========================================================================


class TestMentionWhisper:
    def test_mention_whisper_visibility_driven_by_recipients(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`recipients=[ember], mentions=[ember]` → visibility identical to
        plain whisper. Mentions doesn't change visibility — render is the
        renderer's concern (F2 lane)."""
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]
        phil = populated_registry["phil"]
        msg = _msg_dict(
            sender_key=phil,
            recipients=[ember],
            mentions=[ember],
            body="@ember psst",
        )

        assert _is_visible(msg, ember) is True
        assert _is_visible(msg, phil) is True  # sender
        assert _is_visible(msg, sage) is False  # bystander
        assert _is_visible(msg, "ffffffff") is False


# ===========================================================================
# §10 Test #5 — Multi-mention
# ===========================================================================


class TestMultiMention:
    def test_multi_mention_visible_to_all(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`mentions=[ember, sage]` → all visible."""
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]
        phil = populated_registry["phil"]
        msg = _msg_dict(
            sender_key=phil,
            recipients=None,
            mentions=[ember, sage],
            body="@ember @sage thoughts?",
        )

        for viewer_key in (ember, sage, phil, "ffffffff"):
            assert _is_visible(msg, viewer_key) is True


# ===========================================================================
# §10 Test #6 — Multi-whisper
# ===========================================================================


class TestMultiWhisper:
    def test_multi_whisper_visible_to_listed(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`recipients=[ember, sage]` → ember/sage/sender True, others False."""
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]
        phil = populated_registry["phil"]
        msg = _msg_dict(
            sender_key=phil,
            recipients=[ember, sage],
            mentions=None,
        )

        assert _is_visible(msg, ember) is True
        assert _is_visible(msg, sage) is True
        assert _is_visible(msg, phil) is True  # sender
        assert _is_visible(msg, "ffffffff") is False


# ===========================================================================
# §10 Test #7a — Legacy whisper, prefix-only body
# ===========================================================================


LEGACY_WHISPER_JSON_PREFIX_ONLY = (
    '{"id":"legacy-001",'
    '"ts":"2026-05-01T10:00:00-05:00",'
    '"sender":{"key":"aabbccdd","name":"alice","type":"claude"},'
    '"recipients":["00ff0e8a"],'
    '"body":"[@ember] hi",'
    '"reply_to":null,'
    '"conv":"general"}'
)


class TestLegacyWhisperPrefixOnly:
    def test_legacy_whisper_pydantic_coerces_mentions_none(self) -> None:
        """Legacy JSON without `mentions` key → Pydantic parses with
        `mentions=None`. Visibility = whisper. Body content preserved."""
        m = Message.model_validate_json(LEGACY_WHISPER_JSON_PREFIX_ONLY)

        # Pydantic coercion
        assert m.mentions is None
        assert m.recipients == ["00ff0e8a"]
        assert m.body == "[@ember] hi"

        # Visibility = whisper. Build dict from the parsed message so we drive
        # `_is_visible` exactly the way `MessageStore` does.
        msg_dict = json.loads(m.model_dump_json())
        assert _is_visible(msg_dict, "00ff0e8a") is True  # listed recipient
        assert _is_visible(msg_dict, "aabbccdd") is True  # sender
        assert _is_visible(msg_dict, "11111111") is False  # bystander


# ===========================================================================
# §10 Test #7b — Legacy whisper with body @name
# ===========================================================================


LEGACY_WHISPER_JSON_BODY_AT_NAME = (
    '{"id":"legacy-002",'
    '"ts":"2026-05-01T10:00:00-05:00",'
    '"sender":{"key":"aabbccdd","name":"alice","type":"claude"},'
    '"recipients":["00ff0e8a"],'
    '"body":"[@ember] hi @ember",'
    '"reply_to":null,'
    '"conv":"general"}'
)


class TestLegacyWhisperBodyAtName:
    def test_legacy_whisper_with_body_at_name(self) -> None:
        """Same Pydantic + visibility behaviour as 7a; body content preserved
        verbatim including the body-side `@ember` token."""
        m = Message.model_validate_json(LEGACY_WHISPER_JSON_BODY_AT_NAME)

        assert m.mentions is None
        assert m.recipients == ["00ff0e8a"]
        # Body preserved verbatim, including the body-side @ember
        assert m.body == "[@ember] hi @ember"

        msg_dict = json.loads(m.model_dump_json())
        assert _is_visible(msg_dict, "00ff0e8a") is True
        assert _is_visible(msg_dict, "aabbccdd") is True  # sender
        assert _is_visible(msg_dict, "11111111") is False


# ===========================================================================
# §10 Test #8 — Empty mentions list behaves as null
# ===========================================================================


class TestEmptyMentionsList:
    def test_empty_mentions_list_behaves_as_null(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`mentions=[]` → behaves identically to `mentions=None`: broadcast
        visibility, no special routing."""
        phil = populated_registry["phil"]
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]

        msg_empty = _msg_dict(sender_key=phil, recipients=None, mentions=[])
        msg_null = _msg_dict(sender_key=phil, recipients=None, mentions=None)

        # Both visible to everyone
        for viewer_key in (ember, sage, phil, "ffffffff"):
            assert _is_visible(msg_empty, viewer_key) is True
            assert _is_visible(msg_null, viewer_key) is True

        # Pydantic-level: empty list is preserved as empty list (not null) but
        # visibility-equivalence still holds.
        m_empty = Message(
            sender=Sender(key=phil, name="phil", type="human"),
            body="hi",
            conv="general",
            recipients=None,
            mentions=[],
        )
        assert m_empty.mentions == []


# ===========================================================================
# §10 Test #9 — Unknown-key mention dropped by resolve_for_mentions
# ===========================================================================


class TestUnknownKeyMentionDropped:
    def test_unknown_key_mention_dropped_by_resolve_for_mentions(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`resolve_for_mentions(['deadbeef'])` where deadbeef is NOT in the
        registry → returns []. The Pydantic-level malformed-key validation is
        a separate layer; here we test the registry-validation layer."""
        reg: ParticipantRegistry = populated_registry["registry"]

        # Unregistered hex8 → dropped
        assert reg.resolve_for_mentions(["deadbeef"]) == []

        # Mixed: known name + unregistered hex8 → only the name survives
        ember = populated_registry["ember"]
        result = reg.resolve_for_mentions(["ember", "deadbeef"])
        assert result == [ember]

        # Known hex8 (registered ember key) → kept
        assert reg.resolve_for_mentions([ember]) == [ember]


# ===========================================================================
# §10 Test #10 — Self-mention by sender (legacy/external path)
# ===========================================================================


class TestLegacySenderSelfMention:
    def test_legacy_sender_self_mention_round_trips(self) -> None:
        """A Message with `mentions=[sender_key]` constructed directly
        (bypassing tool_comms_send composer dedup) round-trips through
        Pydantic and remains visible to the sender via `_is_visible`.

        Renderer's sender-self special case is web-side (F2 lane); we lock the
        wire-format invariant here only.
        """
        sender_key = "aabbccdd"
        m = Message(
            sender=Sender(key=sender_key, name="ember", type="claude"),
            body="@ember note to self",
            conv="general",
            recipients=None,
            mentions=[sender_key],
        )
        # Pydantic accepts a mentions list containing the sender's own key —
        # no server-side dedup at the model layer.
        assert m.mentions == [sender_key]

        # Round-trip through JSON preserves the invariant.
        m2 = Message.from_mqtt_payload(m.to_mqtt_payload())
        assert m2.mentions == [sender_key]

        # `_is_visible` is True for the sender (broadcast: no recipients).
        msg_dict = json.loads(m.model_dump_json())
        assert _is_visible(msg_dict, sender_key) is True
        assert _is_visible(msg_dict, "11111111") is True  # broadcast


# ===========================================================================
# §10 Test #11a — Sender-key dedup at server (recipients)
# ===========================================================================


class TestSenderKeyDedupRecipients:
    def test_send_drops_sender_from_recipients(
        self, populated_registry: dict[str, Any], publish_spy
    ) -> None:
        """`tool_comms_send(recipients=[ember, phil])` from sender=phil →
        published Message has `recipients=[ember]` only. Server drops sender's
        own key (defense in depth)."""
        reg: ParticipantRegistry = populated_registry["registry"]
        ember = populated_registry["ember"]
        phil = populated_registry["phil"]

        result = asyncio.run(
            tool_comms_send(
                reg,
                publish_spy,
                key=phil,
                conversation="general",
                message="hey",
                recipients=[ember, phil],
            )
        )

        assert result.get("error") is not True
        assert result["recipients"] == [ember]

        # Verify the published wire payload also reflects the dedup
        topic, payload, _retain = publish_spy.last_call
        assert topic == "claude-comms/conv/general/messages"
        msg = json.loads(payload)
        assert msg["recipients"] == [ember]
        assert phil not in msg["recipients"]


# ===========================================================================
# §10 Test #11b — Sender-key NO-dedup at server (mentions)
# ===========================================================================


class TestSenderKeyNoDedupMentions:
    def test_send_keeps_sender_in_mentions(
        self, populated_registry: dict[str, Any], publish_spy
    ) -> None:
        """`tool_comms_send(mentions=[ember, phil])` from sender=phil →
        published Message has `mentions=[ember, phil]`. Server does NOT dedup
        mentions (presentation metadata; renderer handles sender-self)."""
        reg: ParticipantRegistry = populated_registry["registry"]
        ember = populated_registry["ember"]
        phil = populated_registry["phil"]

        result = asyncio.run(
            tool_comms_send(
                reg,
                publish_spy,
                key=phil,
                conversation="general",
                message="@ember @phil heads up",
                mentions=[ember, phil],
            )
        )

        assert result.get("error") is not True
        # Order may follow input order; assert as a set for resilience but
        # also assert phil's own key is preserved (the load-bearing invariant).
        assert set(result["mentions"]) == {ember, phil}
        assert phil in result["mentions"]

        # Wire payload must round-trip the same shape
        topic, payload, _retain = publish_spy.last_call
        msg = json.loads(payload)
        assert set(msg["mentions"]) == {ember, phil}
        assert phil in msg["mentions"]


# ===========================================================================
# §10 Test #12 — Round-trip Pydantic with and without mentions
# ===========================================================================


class TestPydanticRoundtrip:
    def test_pydantic_roundtrip_with_and_without_mentions(self) -> None:
        """Old-format JSON (no `mentions` key) parses → `mentions=None`.
        `model_dump_json()` re-emits with `mentions:null` (Pydantic v2 default,
        symmetric with existing `recipients:null`). No `exclude_none` config
        required."""
        # 1. Old-format fixture lacking the `mentions` key entirely
        old_format_json = (
            '{"id":"abc",'
            '"ts":"2026-05-06T10:00:00-05:00",'
            '"sender":{"key":"aabbccdd","name":"a","type":"claude"},'
            '"recipients":null,'
            '"body":"hi",'
            '"reply_to":null,'
            '"conv":"general"}'
        )
        m = Message.model_validate_json(old_format_json)
        assert m.mentions is None
        assert m.recipients is None

        # 2. Re-emitted JSON includes a symmetric `mentions:null` key
        emitted = m.model_dump_json()
        data = json.loads(emitted)
        assert "mentions" in data
        assert data["mentions"] is None
        # Symmetric with `recipients:null` — already-emitted shape today
        assert "recipients" in data
        assert data["recipients"] is None

        # 3. Full round-trip equals — same Message object after parse → emit → parse
        m2 = Message.from_mqtt_payload(emitted)
        assert m2 == m

        # 4. With mentions explicitly set, the field round-trips intact
        m3 = Message(
            sender=Sender(key="aabbccdd", name="a", type="claude"),
            body="hi @ember",
            conv="general",
            mentions=["b2e19d04"],
        )
        m4 = Message.from_mqtt_payload(m3.to_mqtt_payload())
        assert m4.mentions == ["b2e19d04"]


# ===========================================================================
# §10 Test #13 — mark_seen=True cursor advance (visible-only)
# ===========================================================================


class TestMarkSeenCursorAdvance:
    def test_comms_check_mark_seen_advances_to_latest_visible(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """Store with [visible_at_t1, whisper-to-other_at_t2]. A third-party
        viewer calling `comms_check(mark_seen=True)` sees pre-advance
        `total_unread=1` (only the visible one) and the cursor advances to t1
        (latest visible-to-viewer), NOT t2. Subsequent check returns 0."""
        reg: ParticipantRegistry = populated_registry["registry"]
        ember = populated_registry["ember"]  # viewer
        phil = populated_registry["phil"]  # sender of both messages
        sage = populated_registry["sage"]  # whisper recipient (NOT viewer)

        store = MessageStore()
        ts1 = "2026-05-06T10:00:00-05:00"
        ts2 = "2026-05-06T11:00:00-05:00"

        # m1: broadcast at t1 — visible to viewer
        store.add(
            "general",
            _msg_dict(
                sender_key=phil,
                sender_name="phil",
                sender_type="human",
                body="hello channel",
                recipients=None,
                mentions=None,
                ts=ts1,
                msg_id="m1",
            ),
        )
        # m2: whisper to sage (third-party) at t2 — NOT visible to viewer
        store.add(
            "general",
            _msg_dict(
                sender_key=phil,
                sender_name="phil",
                sender_type="human",
                body="psst sage",
                recipients=[sage],
                mentions=None,
                ts=ts2,
                msg_id="m2",
            ),
        )

        # First call: pre-advance count is 1 (only m1 is visible)
        result = tool_comms_check(
            reg, store, key=ember, conversation="general", mark_seen=True
        )
        assert result["total_unread"] == 1
        assert result["conversations"][0]["unread_count"] == 1
        # Latest of the visible-to-viewer set is m1 itself
        assert result["conversations"][0]["latest"]["id"] == "m1"

        # Cursor advanced to t1 (latest VISIBLE), NOT t2 (latest absolute).
        cursor = reg.get_cursor(ember, "general")
        assert cursor == ts1

        # Subsequent peek-only check: nothing new visible.
        result2 = tool_comms_check(
            reg, store, key=ember, conversation="general", mark_seen=False
        )
        assert result2["total_unread"] == 0


# ===========================================================================
# §10 Test #14 — TUI-origin free-`@` produces broadcast
# ===========================================================================


class TestTuiFreeAtBroadcast:
    def test_tui_origin_free_at_produces_broadcast(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """Simulate a TUI-published Message: body `"@ember hi"`,
        `recipients=None`, `mentions=None`. Visibility = broadcast (all see
        it). This is a wire-format invariant, not a TUI-render assertion."""
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]
        phil = populated_registry["phil"]

        # Build the message exactly as TUI's free-`@` send path produces it.
        m = Message(
            sender=Sender(key=phil, name="phil", type="human"),
            body="@ember hi",
            conv="general",
            recipients=None,
            mentions=None,
        )
        msg_dict = json.loads(m.model_dump_json())

        # Wire-format invariants: both routing fields null/empty.
        assert msg_dict["recipients"] is None
        assert msg_dict["mentions"] is None

        # Broadcast visibility — every viewer can see it.
        for viewer_key in (ember, sage, phil, "ffffffff"):
            assert _is_visible(msg_dict, viewer_key) is True


# ===========================================================================
# §10 Test #15 — Sender-self visibility invariant (R4-mi added to DoD)
# ===========================================================================


class TestSenderSelfVisibilityInvariant:
    def test_sender_visible_to_self_via_is_visible(self) -> None:
        """`_is_visible({recipients: [other_key], sender: sender_key},
        sender_key)` returns True via the sender-key check at mcp_tools.py:93.

        Locks the assumption that `_is_visible` always lets the sender
        through — even when the sender is NOT explicitly listed in
        `recipients`. Future changes (mute lists, allow lists, etc.) must not
        silently break the sender-key dedup invariant.
        """
        sender_key = "aabbccdd"
        other_key = "00ff0e8a"

        # Whisper to "other" — sender NOT explicitly listed.
        msg = _msg_dict(
            sender_key=sender_key,
            recipients=[other_key],
            mentions=None,
        )

        # Sender always sees own messages, even when not in `recipients`.
        assert _is_visible(msg, sender_key) is True
        # Listed recipient also sees it.
        assert _is_visible(msg, other_key) is True
        # An unlisted bystander does NOT.
        assert _is_visible(msg, "11111111") is False


# ===========================================================================
# Edge cases beyond the matrix (defensive coverage)
# ===========================================================================


class TestResolveForMentionsHex8Validation:
    def test_resolve_for_mentions_validates_hex8_against_participants(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`resolve_for_mentions` accepts:
        - names that resolve via the name index
        - hex8-format keys that ARE registered participants

        and drops:
        - hex8-format keys that LOOK valid but are NOT in the registry

        Locks the asymmetric mentions-side scope (vs `resolve_recipients`'s
        lenient pass-through) per §11 Phase A R2-M3.
        """
        reg: ParticipantRegistry = populated_registry["registry"]
        ember = populated_registry["ember"]
        sage = populated_registry["sage"]

        # Mixed input: name + valid registered hex8 + valid-format-but-unregistered
        result = reg.resolve_for_mentions(
            [
                "ember",  # name → ember key
                sage,  # registered hex8 → kept
                "deadbeef",  # valid format, NOT registered → dropped
            ]
        )
        assert ember in result
        assert sage in result
        assert "deadbeef" not in result
        # Ordered with no duplicates
        assert len(result) == 2


class TestResolveRecipientsLenientHex8:
    def test_resolve_recipients_lenient_hex8_unchanged(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """`resolve_recipients` keeps unregistered hex8 entries (lenient pass-
        through). Locks the asymmetric scope vs `resolve_for_mentions` so a
        future "fix" doesn't accidentally collapse the two."""
        reg: ParticipantRegistry = populated_registry["registry"]

        # An unregistered hex8 — passes through unchanged.
        result = reg.resolve_recipients(["deadbeef"])
        assert result == ["deadbeef"]

        # Mixed with a known name still works.
        ember = populated_registry["ember"]
        result2 = reg.resolve_recipients(["ember", "deadbeef"])
        assert ember in result2
        assert "deadbeef" in result2


class TestCommsCheckVisibilityFilter:
    def test_comms_check_visibility_filter_excludes_invisible_whispers(
        self, populated_registry: dict[str, Any]
    ) -> None:
        """Defect-fix verification (R2-M1): a viewer with 1 broadcast + 5
        whispers-addressed-to-other in their store should see
        `total_unread=1`, NOT 6.

        Pre-fix `comms_check` counted invisible whispers; the Phase A defect-
        fix applies `_is_visible` so the count matches `comms_read`'s actual
        visibility model.
        """
        reg: ParticipantRegistry = populated_registry["registry"]
        ember = populated_registry["ember"]  # viewer
        phil = populated_registry["phil"]  # sender
        sage = populated_registry["sage"]  # whisper target (NOT viewer)

        store = MessageStore()
        # 1 broadcast — visible to ember
        store.add(
            "general",
            _msg_dict(
                sender_key=phil,
                sender_name="phil",
                sender_type="human",
                body="hello",
                recipients=None,
                ts="2026-05-06T10:00:00-05:00",
                msg_id="m-broadcast",
            ),
        )
        # 5 whispers to sage — NOT visible to ember
        for i in range(5):
            store.add(
                "general",
                _msg_dict(
                    sender_key=phil,
                    sender_name="phil",
                    sender_type="human",
                    body=f"psst {i}",
                    recipients=[sage],
                    ts=f"2026-05-06T10:0{i + 1}:00-05:00",
                    msg_id=f"m-whisper-{i}",
                ),
            )

        result = tool_comms_check(reg, store, key=ember, conversation="general")
        assert result["total_unread"] == 1
        assert result["conversations"][0]["unread_count"] == 1
        assert result["conversations"][0]["latest"]["id"] == "m-broadcast"
