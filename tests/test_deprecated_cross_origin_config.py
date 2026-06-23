"""Tests for the single-origin Phase 4 deprecation warnings.

``_warn_deprecated_cross_origin_config`` emits a one-line deprecation warning
for each LEGACY cross-origin config key that is set, once at daemon startup.
The legacy reverse-proxy path stays fully functional — these are warnings only.
"""

from __future__ import annotations

import logging

from claude_comms.cli import _warn_deprecated_cross_origin_config

_LOGGER = "claude_comms.cli"


def _warnings(caplog) -> list[str]:
    return [r.message for r in caplog.records if r.levelno == logging.WARNING]


def test_api_base_set_emits_deprecation(caplog) -> None:
    cfg = {"web": {"api_base": "https://comms.example.com"}}
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        _warn_deprecated_cross_origin_config(cfg)
    assert any("web.api_base is set" in m for m in _warnings(caplog))


def test_ws_url_set_emits_deprecation(caplog) -> None:
    cfg = {"web": {"ws_url": "wss://comms.example.com/mqtt"}}
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        _warn_deprecated_cross_origin_config(cfg)
    assert any("web.ws_url is set" in m for m in _warnings(caplog))


def test_csp_extra_connect_src_nonempty_emits_softer_note(caplog) -> None:
    cfg = {"web": {"csp_extra_connect_src": ["https://extra.example.com"]}}
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        _warn_deprecated_cross_origin_config(cfg)
    assert any("web.csp_extra_connect_src is non-empty" in m for m in _warnings(caplog))


def test_no_warning_when_unset(caplog) -> None:
    """Default single-origin config: none of the legacy keys set."""
    cfg = {
        "web": {
            "api_base": None,
            "ws_url": None,
            "csp_extra_connect_src": [],
        }
    }
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        _warn_deprecated_cross_origin_config(cfg)
    assert _warnings(caplog) == []


def test_no_warning_when_web_section_absent(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        _warn_deprecated_cross_origin_config({})
    assert _warnings(caplog) == []


def test_all_three_warn_independently(caplog) -> None:
    cfg = {
        "web": {
            "api_base": "https://comms.example.com",
            "ws_url": "wss://comms.example.com/mqtt",
            "csp_extra_connect_src": ["https://extra.example.com"],
        }
    }
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        _warn_deprecated_cross_origin_config(cfg)
    msgs = _warnings(caplog)
    assert any("web.api_base is set" in m for m in msgs)
    assert any("web.ws_url is set" in m for m in msgs)
    assert any("web.csp_extra_connect_src is non-empty" in m for m in msgs)
