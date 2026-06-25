#!/usr/bin/env python3
"""Single source-of-truth version bump tool for claude-comms.

``pyproject.toml [project] version`` is the ONE source of truth. Everything
else derives from it: the CLI/TUI read it at runtime via
``importlib.metadata``; the web UI shows the running daemon's version (served
on ``/api/capabilities``) and falls back to the build-time
``web/package.json`` version. This script keeps ``web/package.json`` in lock
step with ``pyproject.toml`` so the build-time fallback never drifts, and a
CI test (``tests/test_version_consistency.py``) guards the invariant.

Usage::

    python scripts/bump_version.py X.Y.Z

It will, in order:

1. validate ``X.Y.Z`` is a semantic version,
2. refuse if the project is already at that version or the ``vX.Y.Z`` tag
   already exists (idempotent-safe),
3. update ``[project] version`` in ``pyproject.toml``,
4. update ``version`` in ``web/package.json`` (preserving indent / trailing
   newline),
5. prepend a stub entry to ``CHANGELOG.md``,
6. ``git add`` those three files and commit ``Release vX.Y.Z``,
7. create an annotated tag ``vX.Y.Z``.

It does NOT push. Pushing the tag is what triggers the PyPI publish workflow,
so that stays a deliberate human action. The script prints the exact push
commands when it finishes.
"""

from __future__ import annotations

import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = REPO_ROOT / "pyproject.toml"
PACKAGE_JSON = REPO_ROOT / "web" / "package.json"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"

# Strict semver core (X.Y.Z) with optional pre-release / build metadata.
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

# ``version = "X.Y.Z"`` inside the ``[project]`` table. We match the first
# top-level ``version =`` line; pyproject keeps it directly under [project].
PYPROJECT_VERSION_RE = re.compile(
    r'^(?P<prefix>version\s*=\s*")(?P<version>[^"]+)(?P<suffix>")\s*$',
    re.MULTILINE,
)

# ``"version": "X.Y.Z",`` in package.json. Capture the exact surrounding
# punctuation/whitespace so we preserve the file's formatting byte-for-byte.
PACKAGE_JSON_VERSION_RE = re.compile(
    r'(?P<prefix>"version"\s*:\s*")(?P<version>[^"]+)(?P<suffix>")'
)


class BumpError(RuntimeError):
    """A user-facing failure that should abort the bump with a clear message."""


def _read(path: Path) -> str:
    if not path.is_file():
        raise BumpError(f"Expected file not found: {path}")
    return path.read_text(encoding="utf-8")


def read_pyproject_version(text: str) -> str:
    match = PYPROJECT_VERSION_RE.search(text)
    if not match:
        raise BumpError(f"Could not find a 'version = \"...\"' line in {PYPROJECT}")
    return match.group("version")


def read_package_json_version(text: str) -> str:
    match = PACKAGE_JSON_VERSION_RE.search(text)
    if not match:
        raise BumpError(
            f'Could not find a \'"version": "..."\' field in {PACKAGE_JSON}'
        )
    return match.group("version")


def set_pyproject_version(text: str, new_version: str) -> str:
    # Replace only the first match (the [project] version) to avoid touching
    # any later ``version =`` that might appear in tool config.
    new_text, count = PYPROJECT_VERSION_RE.subn(
        lambda m: f"{m.group('prefix')}{new_version}{m.group('suffix')}",
        text,
        count=1,
    )
    if count != 1:
        raise BumpError("Failed to rewrite the version in pyproject.toml")
    return new_text


def set_package_json_version(text: str, new_version: str) -> str:
    new_text, count = PACKAGE_JSON_VERSION_RE.subn(
        lambda m: f"{m.group('prefix')}{new_version}{m.group('suffix')}",
        text,
        count=1,
    )
    if count != 1:
        raise BumpError("Failed to rewrite the version in web/package.json")
    return new_text


def prepend_changelog(text: str, new_version: str, today: str) -> str:
    entry = (
        f"## [{new_version}] - {today}\n\n"
        "### Changed\n\n"
        f"- Version bump to {new_version}. Fill in the release notes here.\n\n"
    )
    # Insert the new entry directly above the first existing ``## [`` heading
    # so the changelog header/preamble stays on top.
    marker = "\n## ["
    idx = text.find(marker)
    if idx == -1:
        # No existing entries; append after whatever header exists.
        return text.rstrip("\n") + "\n\n" + entry
    insert_at = idx + 1  # keep the leading newline before the heading
    return text[:insert_at] + entry + text[insert_at:]


def _git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise BumpError(
            f"git {' '.join(args)} failed:\n{result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout.strip()


def tag_exists(tag: str) -> bool:
    out = _git("tag", "--list", tag)
    return out.strip() == tag


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bump_version.py",
        description=(
            "Bump the claude-comms version (pyproject.toml is the single "
            "source of truth) and keep web/package.json in sync. Commits and "
            "tags; does NOT push."
        ),
    )
    parser.add_argument("version", help="New version, e.g. 0.5.0 (semver)")
    args = parser.parse_args(argv)

    new_version = args.version.lstrip("v").strip()

    try:
        if not SEMVER_RE.match(new_version):
            raise BumpError(
                f"'{new_version}' is not a valid semantic version (expected X.Y.Z)"
            )

        tag = f"v{new_version}"

        pyproject_text = _read(PYPROJECT)
        package_json_text = _read(PACKAGE_JSON)

        current = read_pyproject_version(pyproject_text)
        if current == new_version:
            raise BumpError(
                f"pyproject.toml is already at {new_version}; nothing to do."
            )
        if tag_exists(tag):
            raise BumpError(f"Tag {tag} already exists; refusing to overwrite.")

        # Rewrite the three files.
        pyproject_text = set_pyproject_version(pyproject_text, new_version)
        package_json_text = set_package_json_version(package_json_text, new_version)
        PYPROJECT.write_text(pyproject_text, encoding="utf-8")
        PACKAGE_JSON.write_text(package_json_text, encoding="utf-8")

        today = datetime.date.today().isoformat()
        changelog_text = _read(CHANGELOG)
        CHANGELOG.write_text(
            prepend_changelog(changelog_text, new_version, today),
            encoding="utf-8",
        )

        # Stage + commit + tag.
        _git("add", str(PYPROJECT), str(PACKAGE_JSON), str(CHANGELOG))
        _git("commit", "-m", f"Release {tag}")
        _git("tag", "-a", tag, "-m", f"Release {tag}")

    except BumpError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    print(f"Bumped {current} -> {new_version} and created tag {tag}.")
    print("\nNext steps (CI publishes to PyPI when the tag is pushed):")
    print(f"  git push origin {branch}")
    print(f"  git push origin {tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
