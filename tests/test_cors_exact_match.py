"""CORS exact-match behavior (R2-3 + R6-4 rollback).

The previous implementation used ``allowed in request.headers.get('origin')``
which is a substring match. An attacker at ``http://evil.com/http://127.0.0.1:9921``
would match allowed origin ``http://127.0.0.1:9921`` and get a permissive
CORS response.

The fix:
- ``_resolve_cors_origin`` enforces exact-match.
- When no match, ``Access-Control-Allow-Origin`` MUST be omitted entirely
  (never fall back to ``allow_list[0]``).
- ``strict_cors=False`` re-enables the legacy substring-match path with a
  deprecation warning, for operators who need a one-release rollback.
"""

from __future__ import annotations

import logging

import pytest

from claude_comms.cli import (
    _cors_headers,
    _resolve_cors_origin,
    _resolve_cors_origin_legacy,
)


class _FakeRequest:
    def __init__(self, origin: str):
        self.headers = {"origin": origin} if origin else {}


ALLOW = [
    "http://localhost:9921",
    "http://127.0.0.1:9921",
    "http://localhost:5173",
]


# ---------------------------------------------------------------------------
# _resolve_cors_origin (exact-match)
# ---------------------------------------------------------------------------


def test_exact_match_allowed_origin_returns_origin() -> None:
    req = _FakeRequest("http://localhost:9921")
    assert _resolve_cors_origin(req, ALLOW) == "http://localhost:9921"


def test_forged_origin_with_allowed_as_substring_rejected() -> None:
    """The classic attack payload — allowed origin appears as a path segment."""
    req = _FakeRequest("http://evil.com/http://127.0.0.1:9921")
    assert _resolve_cors_origin(req, ALLOW) is None


def test_forged_origin_suffix_trick_rejected() -> None:
    req = _FakeRequest("http://127.0.0.1:9921.evil.com")
    assert _resolve_cors_origin(req, ALLOW) is None


def test_missing_origin_returns_none() -> None:
    req = _FakeRequest("")
    assert _resolve_cors_origin(req, ALLOW) is None


def test_origin_not_in_list_returns_none() -> None:
    req = _FakeRequest("http://example.com")
    assert _resolve_cors_origin(req, ALLOW) is None


# ---------------------------------------------------------------------------
# _cors_headers (omits Access-Control-Allow-Origin on no match)
# ---------------------------------------------------------------------------


def test_cors_headers_emits_origin_on_match() -> None:
    req = _FakeRequest("http://localhost:9921")
    headers = _cors_headers(req, ALLOW, strict=True)
    assert headers["Access-Control-Allow-Origin"] == "http://localhost:9921"
    assert headers["Access-Control-Allow-Methods"]
    assert headers["Access-Control-Allow-Headers"]


def test_cors_headers_omits_origin_on_miss() -> None:
    """Missing origin or non-matching origin => header absent entirely.

    Never fall back to allow_list[0] (the old buggy behavior) because that
    would echo a safe-looking origin even to a forged cross-origin request.
    """
    req = _FakeRequest("http://evil.com")
    headers = _cors_headers(req, ALLOW, strict=True)
    assert "Access-Control-Allow-Origin" not in headers


def test_cors_headers_omits_origin_when_origin_missing() -> None:
    req = _FakeRequest("")
    headers = _cors_headers(req, ALLOW, strict=True)
    assert "Access-Control-Allow-Origin" not in headers


# ---------------------------------------------------------------------------
# Legacy strict_cors=False substring path + deprecation warning
# ---------------------------------------------------------------------------


def test_legacy_substring_match_accepts_exact_origin() -> None:
    req = _FakeRequest("http://localhost:9921")
    assert _resolve_cors_origin_legacy(req, ALLOW) == "http://localhost:9921"


def test_legacy_substring_match_accepts_forged_origin(caplog) -> None:
    """The legacy path DELIBERATELY accepts the substring-match pattern —
    that's why it's deprecated. This is the R6-4 rollback escape hatch."""
    req = _FakeRequest("http://evil.com/http://127.0.0.1:9921")
    with caplog.at_level(logging.WARNING, logger="claude_comms.cli"):
        result = _resolve_cors_origin_legacy(req, ALLOW)
    # The legacy path matches; this is expected behavior for the rollback.
    assert result == "http://127.0.0.1:9921"
    # Deprecation warning must fire.
    assert any(
        "strict_cors=false" in rec.message and "legacy substring" in rec.message
        for rec in caplog.records
    ), "Legacy CORS path must log a deprecation warning on every match"


def test_cors_headers_strict_false_uses_legacy(caplog) -> None:
    req = _FakeRequest("http://evil.com/http://127.0.0.1:9921")
    with caplog.at_level(logging.WARNING, logger="claude_comms.cli"):
        headers = _cors_headers(req, ALLOW, strict=False)
    # Legacy substring match returned an origin; header is emitted.
    assert "Access-Control-Allow-Origin" in headers
    assert headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:9921"
    # Deprecation warning emitted.
    assert any("strict_cors=false" in r.message for r in caplog.records)


def test_cors_headers_strict_true_blocks_forged_origin() -> None:
    req = _FakeRequest("http://evil.com/http://127.0.0.1:9921")
    headers = _cors_headers(req, ALLOW, strict=True)
    assert "Access-Control-Allow-Origin" not in headers
