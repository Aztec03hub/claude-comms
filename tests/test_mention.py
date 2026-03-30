"""Tests for @mention parsing, routing, and edge cases."""

from __future__ import annotations

import pytest

from claude_comms.mention import (
    build_mention_prefix,
    extract_mentions,
    resolve_mentions,
    strip_mentions,
)


# ---------------------------------------------------------------------------
# extract_mentions
# ---------------------------------------------------------------------------

class TestExtractMentions:
    def test_single_mention(self) -> None:
        assert extract_mentions("[@alice] Hello!") == ["alice"]

    def test_multiple_mentions(self) -> None:
        assert extract_mentions("[@alice, @bob] Hello!") == ["alice", "bob"]

    def test_three_mentions(self) -> None:
        assert extract_mentions("[@a, @b, @c] Hi") == ["a", "b", "c"]

    def test_no_mentions(self) -> None:
        assert extract_mentions("No mentions here") == []

    def test_mention_not_at_start(self) -> None:
        """Mentions must be at the start of the body."""
        assert extract_mentions("Hello [@alice] there") == []

    def test_inline_at_sign_ignored(self) -> None:
        """A bare @name not in brackets is not a structured mention."""
        assert extract_mentions("Hey @alice how are you?") == []

    def test_hyphenated_name(self) -> None:
        assert extract_mentions("[@claude-veridian] Hi") == ["claude-veridian"]

    def test_underscore_name(self) -> None:
        assert extract_mentions("[@claude_test] Hi") == ["claude_test"]

    def test_spaces_around_commas(self) -> None:
        assert extract_mentions("[@a ,  @b,@c] Hi") == ["a", "b", "c"]

    def test_empty_string(self) -> None:
        assert extract_mentions("") == []

    def test_only_bracket_prefix(self) -> None:
        assert extract_mentions("[@alice] ") == ["alice"]

    def test_multiline_body(self) -> None:
        body = "[@alice, @bob] First line.\nSecond line."
        assert extract_mentions(body) == ["alice", "bob"]


# ---------------------------------------------------------------------------
# strip_mentions
# ---------------------------------------------------------------------------

class TestStripMentions:
    def test_strip_single(self) -> None:
        assert strip_mentions("[@alice] Hello!") == "Hello!"

    def test_strip_multiple(self) -> None:
        assert strip_mentions("[@alice, @bob] Hello!") == "Hello!"

    def test_no_prefix(self) -> None:
        assert strip_mentions("No prefix") == "No prefix"

    def test_preserves_rest(self) -> None:
        body = "[@x] Line 1\nLine 2"
        assert strip_mentions(body) == "Line 1\nLine 2"


# ---------------------------------------------------------------------------
# build_mention_prefix
# ---------------------------------------------------------------------------

class TestBuildMentionPrefix:
    def test_empty(self) -> None:
        assert build_mention_prefix([]) == ""

    def test_single(self) -> None:
        assert build_mention_prefix(["alice"]) == "[@alice] "

    def test_multiple(self) -> None:
        assert build_mention_prefix(["alice", "bob"]) == "[@alice, @bob] "

    def test_round_trip(self) -> None:
        names = ["claude-veridian", "phil"]
        prefix = build_mention_prefix(names)
        assert extract_mentions(prefix + "Hello") == names


# ---------------------------------------------------------------------------
# resolve_mentions
# ---------------------------------------------------------------------------

class TestResolveMentions:
    def test_resolves_known_names(self) -> None:
        lookup = {"alice": "a1b2c3d4", "bob": "e5f6a7b8"}
        keys = resolve_mentions("[@alice, @bob] Hi", lookup)
        assert keys == ["a1b2c3d4", "e5f6a7b8"]

    def test_unknown_name_skipped(self) -> None:
        lookup = {"alice": "a1b2c3d4"}
        keys = resolve_mentions("[@alice, @unknown] Hi", lookup)
        assert keys == ["a1b2c3d4"]

    def test_no_mentions_returns_empty(self) -> None:
        assert resolve_mentions("Just a message", {"alice": "a1b2c3d4"}) == []

    def test_duplicate_mention_deduped(self) -> None:
        lookup = {"alice": "a1b2c3d4"}
        keys = resolve_mentions("[@alice, @alice] Hi", lookup)
        assert keys == ["a1b2c3d4"]

    def test_empty_lookup(self) -> None:
        keys = resolve_mentions("[@alice] Hi", {})
        assert keys == []
