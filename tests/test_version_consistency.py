"""Version single-source-of-truth (SSOT) drift guard.

``pyproject.toml [project] version`` is the one source of truth. ``web/
package.json`` carries a build-time copy that the web UI uses ONLY as a
fallback when the live daemon version (served on ``/api/capabilities``) has
not loaded yet. Those two STATIC sources must always agree — that is the real
SSOT invariant this test enforces in CI.

``claude_comms.__version__`` is derived at runtime from installed package
metadata (``importlib.metadata``), so in a stale editable install it can lag
the source tree (it reflects whatever ``pip install`` last recorded, which may
be any older release). We therefore only assert it is importable and shaped
like a version string, rather than hard-failing on an out-of-date local
install — the static-source match above is the authoritative SSOT guard.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = REPO_ROOT / "pyproject.toml"
PACKAGE_JSON = REPO_ROOT / "web" / "package.json"

# Marker __version__ carries when package metadata is unavailable (source tree
# without an install — see src/claude_comms/__init__.py).
FALLBACK_MARKER = "0+unknown"
# A runtime version is acceptable if it is the no-install fallback or any
# semver-ish ``X.Y.Z[...]`` string (a real or stale installed version).
_VERSION_SHAPE_RE = re.compile(r"^\d+\.\d+\.\d+")


# Match the ``[project]`` table header so we scope the version lookup to it
# (TOML section names run until the next ``[...]`` header).
_PROJECT_SECTION_RE = re.compile(r"^\[project\]\s*$(.*?)(?=^\[|\Z)", re.M | re.S)
_PROJECT_VERSION_RE = re.compile(r'^version\s*=\s*"([^"]+)"', re.M)


def _pyproject_version() -> str:
    """Parse ``[project] version`` from pyproject without ``tomllib``.

    ``tomllib`` is stdlib only on Python 3.11+, but the project supports
    ``requires-python = ">=3.10"``; a regex keeps this test dependency-free and
    interpreter-agnostic across 3.10-3.13.
    """
    text = PYPROJECT.read_text(encoding="utf-8")
    section = _PROJECT_SECTION_RE.search(text)
    assert section, "no [project] table found in pyproject.toml"
    match = _PROJECT_VERSION_RE.search(section.group(1))
    assert match, "no version key found in pyproject.toml [project] table"
    return match.group(1)


def _package_json_version() -> str:
    data = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    return data["version"]


def test_pyproject_and_package_json_versions_match() -> None:
    """The two static version sources are the SSOT guard against drift."""
    py = _pyproject_version()
    web = _package_json_version()
    assert py == web, (
        f"version drift: pyproject.toml has {py!r} but web/package.json has "
        f"{web!r}. Run `python scripts/bump_version.py X.Y.Z` to bump both, "
        f"or hand-edit them to match."
    )


def test_runtime_version_importable_and_consistent() -> None:
    """``claude_comms.__version__`` imports and is shaped like a version.

    A correctly-installed package reports the pyproject version; a source tree
    without an install reports the ``0+unknown`` fallback; a stale editable
    install reports whatever older release ``pip`` last recorded. All three are
    acceptable here — the static-source match test above is the authoritative
    SSOT guard. We only require that ``__version__`` imports and is a sane
    version string so the derivation chain itself can't silently break.
    """
    from claude_comms import __version__

    assert isinstance(__version__, str) and __version__, (
        "__version__ must be a non-empty string"
    )
    assert __version__ == FALLBACK_MARKER or _VERSION_SHAPE_RE.match(__version__), (
        f"__version__ ({__version__!r}) is neither the {FALLBACK_MARKER!r} "
        f"no-install fallback nor a version-shaped string; the importlib.metadata "
        f"derivation chain in claude_comms/__init__.py is likely broken."
    )
