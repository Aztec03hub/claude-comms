"""Run the REAL claude-comms PostToolUse hook the way Claude Code would.

This lets the harness measure the product's actual mid-turn delivery mechanism
end to end: the daemon is supposed to drop pending messages into
``~/.claude-comms/notifications/<key>.jsonl`` and this hook drains+formats them
into ``additionalContext`` after each tool call. We generate the hook with the
daemon's isolated HOME baked in (so its notif path matches the running daemon),
then invoke it per turn and record exactly what it delivered.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
VENV_PY = REPO_ROOT / ".venv" / "bin" / "python"


def generate_hook_for_home(participant_key: str, home: Path) -> str:
    """Generate the real hook script with `home` baked into its notif path.

    generate_hook_script() bakes an absolute path derived from Path.home() at
    generation time, so we generate it in a subprocess with HOME overridden to
    the daemon's isolated home (not the harness operator's real home).
    """
    env = dict(os.environ)
    env["HOME"] = str(home)
    out = subprocess.run(
        [
            str(VENV_PY),
            "-c",
            "import sys;from claude_comms.hook_installer import generate_hook_script;"
            "sys.stdout.write(generate_hook_script(sys.argv[1]))",
            participant_key,
        ],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout


def install_hook_script(participant_key: str, home: Path) -> Path:
    """Write the generated hook to the agent's hooks dir and mark it executable."""
    script = generate_hook_for_home(participant_key, home)
    hooks_dir = home / ".claude" / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    path = hooks_dir / f"claude-comms-{participant_key}.sh"
    path.write_text(script)
    path.chmod(0o755)
    return path


def run_hook(script_path: Path, home: Path) -> dict:
    """Invoke the hook exactly as PostToolUse would and parse its output.

    Returns {'delivered': bool, 'context': str|None, 'raw': str}. The hook drains
    stdin (we feed it an empty PostToolUse-shaped payload), so we always close it.
    """
    env = dict(os.environ)
    env["HOME"] = str(home)
    proc = subprocess.run(
        ["bash", str(script_path)],
        env=env,
        input=json.dumps({"hook_event_name": "PostToolUse"}),
        capture_output=True,
        text=True,
    )
    out = proc.stdout.strip()
    if not out:
        return {"delivered": False, "context": None, "raw": ""}
    try:
        parsed = json.loads(out)
        ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext")
        return {"delivered": bool(ctx), "context": ctx, "raw": out}
    except json.JSONDecodeError:
        return {"delivered": False, "context": None, "raw": out}
