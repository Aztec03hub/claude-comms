"""Claude Comms — Distributed inter-Claude messaging platform."""

from importlib.metadata import PackageNotFoundError, version as _pkg_version

try:
    # Distribution name (with dash), not import name. Resolves from the
    # wheel's `[project] version = ...` so `pyproject.toml` is the single
    # source of truth and the hardcoded constant can't drift again.
    __version__ = _pkg_version("claude-comms")
except PackageNotFoundError:
    # Source tree without an install (e.g. running tests directly from a
    # fresh clone before `pip install -e`). Fall back to an unknown marker
    # rather than baking in a literal that will go stale.
    __version__ = "0+unknown"

__all__ = ["__version__"]
