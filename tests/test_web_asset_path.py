"""
Regression test for the daemon's web-asset path resolution.

History: in 0.1.0 the daemon used ``Path(__file__) / "../../web/dist"`` which
walked UP two directories from the installed package and only resolved
correctly from an in-tree source checkout. From a pipx install it expanded
to ``<venv>/lib/pythonX.Y/web/dist`` which no install layer produced, so
the daemon logged "Web UI dist not found ... -- skipping" and served no
web UI.

The fix anchors the lookup inside the package via
``importlib.resources.files("claude_comms")``. These tests pin the contract
so a future "small refactor" doesn't silently regress to a path that only
works from a source checkout.
"""

from __future__ import annotations

import importlib.resources
from pathlib import Path

import pytest


def test_web_dist_resolves_inside_package() -> None:
    """``importlib.resources.files`` must anchor inside the installed package."""
    web_dist = importlib.resources.files("claude_comms").joinpath("web", "dist")
    # Whatever the install layout (editable, wheel, pipx, frozen), the path
    # must end with `claude_comms/web/dist` -- never `web/dist` at venv root,
    # never `<cwd>/web/dist`, never `<some-parent>/web/dist`.
    parts = Path(str(web_dist)).parts
    assert parts[-3:] == ("claude_comms", "web", "dist"), (
        f"web/dist path must be inside the claude_comms package; got {web_dist}"
    )


def test_web_dist_index_html_when_built() -> None:
    """When the UI is built, index.html must be reachable via the same path.

    Skipped when the dist isn't present (developer running tests without
    having run `pnpm build` yet). The CI ``build-wheel`` job installs the
    wheel into a clean venv where this assertion is always exercised.
    """
    index = (
        importlib.resources.files("claude_comms")
        .joinpath("web", "dist", "index.html")
    )
    if not index.is_file():
        pytest.skip(
            "src/claude_comms/web/dist/index.html missing -- run `pnpm build` "
            "in web/ or build the wheel to populate"
        )
    assert index.is_file()
    # ``Traversable`` doesn't declare ``stat()``; cast to ``Path`` for the
    # size check (always valid for non-zip installs, which is the only case
    # our wheels ever produce).
    assert Path(str(index)).stat().st_size > 0
