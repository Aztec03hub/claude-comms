"""
Hatch build hook for claude-comms.

Compiles the Svelte web UI at wheel-build time and ensures the result is
present at ``src/claude_comms/web/dist/`` so the wheel ships with the web
assets baked into the Python package (resolved via ``importlib.resources``
inside the daemon — see ``src/claude_comms/cli.py``).

Behavior
--------
- If ``src/claude_comms/web/dist/index.html`` already exists, the build is
  skipped (CI prebuild, local incremental dev, etc.).
- Otherwise the hook requires ``pnpm`` on PATH and runs:
    pnpm install --frozen-lockfile
    pnpm build
  in ``web/``. Vite is configured to emit straight into the package path,
  so no copy step is needed (see ``web/vite.config.js``).
- If ``pnpm`` is missing, a clear error explains the toolchain prereqs and
  points at the prebuilt PyPI wheel as the alternative.

This hook is a no-op for users installing the prebuilt PyPI wheel — it only
runs during ``python -m build`` / ``pip install .`` / ``pip wheel .``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class WebUIBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        root = Path(self.root)
        web_src = root / "web"
        package_dist = root / "src" / "claude_comms" / "web" / "dist"
        sentinel = package_dist / "index.html"

        # sdist of an sdist (no web/ tree) — nothing to do.
        if not web_src.exists():
            return

        if sentinel.is_file():
            # Already built (CI prebuild, dev incremental, repeat build).
            return

        if shutil.which("pnpm") is None:
            raise RuntimeError(
                "claude-comms source builds require pnpm to compile the web "
                "UI.\n"
                "Install Node 20+ and pnpm 11+ (https://pnpm.io/installation), "
                "or use the prebuilt wheel via `pip install claude-comms` / "
                "`pipx install claude-comms`."
            )

        env = os.environ.copy()
        env["CI"] = "true"

        subprocess.run(
            ["pnpm", "install", "--frozen-lockfile"],
            cwd=web_src,
            check=True,
            env=env,
        )
        subprocess.run(
            ["pnpm", "build"],
            cwd=web_src,
            check=True,
            env=env,
        )

        if not sentinel.is_file():
            raise RuntimeError(
                f"pnpm build completed but {sentinel} is missing. "
                f"Check web/vite.config.js outDir."
            )
