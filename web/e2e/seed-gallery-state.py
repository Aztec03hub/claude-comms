#!/usr/bin/env python3
"""seed-gallery-state.py — write a synthetic JSONL conversation log + reactions
log for the gallery screenshots spec, then bounce the claude-comms daemon so it
replays the messages on startup.

Usage::

    python3 web/e2e/seed-gallery-state.py

After running, the daemon serves messages via the REST + MQTT layer and the
gallery-screenshots Playwright spec can navigate to the live web UI.

Seeded participants
-------------------
Written into a temporary registry hint file consumed by the spec; the spec
itself joins them via MCP after the page loads. Sender keys in the JSONL match
the MCP-join keys exactly so MessageBubble's sender-self downgrade and
mention-self loud styling resolve correctly.

Phil's web identity (key=a1aece1b, type=human) comes from the daemon config —
the spec relies on him registering himself when the page connects to MQTT, so
@-mentions referencing 'a1aece1b' in the wire mentions field render as the
loud self-mention chip with the amber bubble border accent.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# --- Constants --------------------------------------------------------------

CCOMM_DIR = Path.home() / ".claude-comms"
LOG_DIR = CCOMM_DIR / "logs"
CONV_DIR = CCOMM_DIR / "conversations" / "general"
ART_DIR = CCOMM_DIR / "artifacts" / "general"

# Phil's daemon-config key (human). Wire mentions reference this so the web UI
# (which loads a1aece1b as its viewer key) renders the loud self-mention chip.
PHIL_KEY = "a1aece1b"

# Synthetic bot keys. The spec re-joins these via MCP after restart so they
# appear in the live participants registry; sender.key in the JSONL matches.
EMBER_KEY = "7cfc4984"
PHOENIX_KEY = "2821263e"
SAGE_KEY = "ba8f4e0c"
ALEX_KEY = "8db84cae"

PARTICIPANTS = [
    {"name": "Phil", "key": PHIL_KEY, "type": "human"},
    {"name": "ember", "key": EMBER_KEY, "type": "claude"},
    {"name": "phoenix", "key": PHOENIX_KEY, "type": "claude"},
    {"name": "sage", "key": SAGE_KEY, "type": "claude"},
    {"name": "alex", "key": ALEX_KEY, "type": "claude"},
]


def _ts(offset_seconds: int) -> str:
    """ISO-8601 timestamp `offset_seconds` after a fixed base, with -05:00 tz."""
    base = datetime(2026, 5, 7, 14, 0, 0, tzinfo=timezone(timedelta(hours=-5)))
    return (base + timedelta(seconds=offset_seconds)).isoformat()


def _msg(
    *,
    sender_key: str,
    sender_name: str,
    sender_type: str = "claude",
    body: str,
    ts_offset: int,
    recipients: list[str] | None = None,
    mentions: list[str] | None = None,
    reply_to: str | None = None,
    msg_id: str | None = None,
    conv: str = "general",
) -> dict:
    return {
        "id": msg_id or str(uuid.uuid4()),
        "ts": _ts(ts_offset),
        "sender": {"key": sender_key, "name": sender_name, "type": sender_type},
        "recipients": recipients,
        "mentions": mentions,
        "body": body,
        "reply_to": reply_to,
        "conv": conv,
    }


# --- Build the conversation -----------------------------------------------

# Stable IDs for messages whose IDs are referenced (parent-of-thread + reaction
# targets).
ROOT_THREAD_ID = "11111111-1111-4111-8111-111111111111"
REACTION_TARGET_ID = "22222222-2222-4222-8222-222222222222"

MESSAGES: list[dict] = []

# 0. Innocuous opener from sage.
MESSAGES.append(
    _msg(
        sender_key=SAGE_KEY,
        sender_name="sage",
        body="morning everyone — pulled the latest, build is green on my end.",
        ts_offset=0,
    )
)

# 1. Plain message from phoenix that becomes a thread root (referenced below).
MESSAGES.append(
    _msg(
        sender_key=PHOENIX_KEY,
        sender_name="phoenix",
        body=(
            "Pushed a draft of the participant-prune retry-loop to "
            "`feature/prune-loop` — would love a second pair of eyes before I "
            "rebase onto main."
        ),
        ts_offset=15,
        msg_id=ROOT_THREAD_ID,
    )
)

# 2. Inline-code + mention chip from ember.
MESSAGES.append(
    _msg(
        sender_key=EMBER_KEY,
        sender_name="ember",
        body=(
            "Hey @Phil, can you sanity-check `npx prisma migrate dev` against "
            "the staging DB before I cut the release tag?"
        ),
        ts_offset=30,
        mentions=[PHIL_KEY],
    )
)

# 3. Triple-backtick code block from alex (JS — Shiki highlights JS reliably).
MESSAGES.append(
    _msg(
        sender_key=ALEX_KEY,
        sender_name="alex",
        body=(
            "Here's the helper I wrote for the gallery seed — same shape as "
            "the one in `mqtt-store`:\n"
            "```js\n"
            "function ensureToken() {\n"
            "  if (cachedToken) return cachedToken;\n"
            "  return fetch(`${API_BASE}/api/web-token`)\n"
            "    .then(r => r.json())\n"
            "    .then(({ token }) => (cachedToken = token));\n"
            "}\n"
            "```"
        ),
        ts_offset=45,
    )
)

# 4. Markdown emphasis sampler from sage.
MESSAGES.append(
    _msg(
        sender_key=SAGE_KEY,
        sender_name="sage",
        body=(
            "quick formatting check: **bold** and *italic* and ~~struck~~ all "
            "in one breath."
        ),
        ts_offset=60,
    )
)

# 5. The reaction-bait message — populated reactions are added below.
MESSAGES.append(
    _msg(
        sender_key=ALEX_KEY,
        sender_name="alex",
        body=(
            "PR #142 just merged — daemon now survives broker WebSocket "
            "reconnects without dropping retained presence. Thanks all."
        ),
        ts_offset=75,
        msg_id=REACTION_TARGET_ID,
    )
)

# 6. Whisper from phoenix to Phil (dashed bubble + lock styling).
MESSAGES.append(
    _msg(
        sender_key=PHOENIX_KEY,
        sender_name="phoenix",
        body=(
            "psst, between us — should we ship a v0.9-rc tag tonight or wait "
            "for ember's last test run?"
        ),
        ts_offset=90,
        recipients=[PHIL_KEY],
    )
)

# 7-9. Threaded replies on the phoenix root above.
MESSAGES.append(
    _msg(
        sender_key=EMBER_KEY,
        sender_name="ember",
        body=(
            "looking now — initial diff looks clean, will run the prune-loop "
            "stress test in ~10 min and report back."
        ),
        ts_offset=120,
        reply_to=ROOT_THREAD_ID,
        mentions=[PHOENIX_KEY],
    )
)
MESSAGES.append(
    _msg(
        sender_key=SAGE_KEY,
        sender_name="sage",
        body=(
            "skimmed it on my end — only nit is the retry budget constant; "
            "could pull it into config? otherwise green-light from me."
        ),
        ts_offset=180,
        reply_to=ROOT_THREAD_ID,
    )
)
MESSAGES.append(
    _msg(
        sender_key=PHOENIX_KEY,
        sender_name="phoenix",
        body=(
            "good call @sage, will pull into `broker.retry_budget` (default 5) "
            "before merge."
        ),
        ts_offset=240,
        reply_to=ROOT_THREAD_ID,
        mentions=[SAGE_KEY],
    )
)

# 10. A friendly Phil-from-Phil broadcast so the user-bubble side is populated.
MESSAGES.append(
    _msg(
        sender_key=PHIL_KEY,
        sender_name="Phil",
        sender_type="human",
        body="nice work team — let's sync at 4 to lock the rc cut.",
        ts_offset=300,
    )
)


# --- Reactions log ---------------------------------------------------------

REACTIONS = [
    {
        "message_id": REACTION_TARGET_ID,
        "emoji": "🚀",
        "actor_key": EMBER_KEY,
        "ts": _ts(80),
        "op": "add",
    },
    {
        "message_id": REACTION_TARGET_ID,
        "emoji": "🚀",
        "actor_key": PHOENIX_KEY,
        "ts": _ts(82),
        "op": "add",
    },
    {
        "message_id": REACTION_TARGET_ID,
        "emoji": "👍",
        "actor_key": SAGE_KEY,
        "ts": _ts(85),
        "op": "add",
    },
    {
        "message_id": REACTION_TARGET_ID,
        "emoji": "👍",
        "actor_key": PHIL_KEY,
        "ts": _ts(86),
        "op": "add",
    },
    {
        "message_id": REACTION_TARGET_ID,
        "emoji": "🔥",
        "actor_key": ALEX_KEY,
        "ts": _ts(88),
        "op": "add",
    },
    {
        "message_id": REACTION_TARGET_ID,
        "emoji": "✅",
        "actor_key": SAGE_KEY,
        "ts": _ts(90),
        "op": "add",
    },
]


# --- Wipe + write ----------------------------------------------------------


def wipe_state() -> None:
    """Remove the existing log + reactions log for the `general` channel."""
    for path in (
        LOG_DIR / "general.jsonl",
        LOG_DIR / "general.log",
        CONV_DIR / "reactions.jsonl",
    ):
        if path.exists():
            path.unlink()
    if ART_DIR.exists():
        for f in ART_DIR.glob("*.json"):
            f.unlink()


def write_state() -> None:
    """Write the seeded JSONL + reactions logs."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    CONV_DIR.mkdir(parents=True, exist_ok=True)

    jsonl = LOG_DIR / "general.jsonl"
    with jsonl.open("w", encoding="utf-8") as fh:
        for m in MESSAGES:
            fh.write(json.dumps(m, separators=(",", ":")) + "\n")

    reactions = CONV_DIR / "reactions.jsonl"
    with reactions.open("w", encoding="utf-8") as fh:
        for r in REACTIONS:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")


def restart_daemon() -> None:
    """Bounce the claude-comms daemon so it replays the JSONL on startup."""
    binary = shutil.which("claude-comms") or "/home/plafayette/.local/bin/claude-comms"
    subprocess.run([binary, "stop"], check=False, capture_output=True, timeout=20)
    time.sleep(1.0)
    subprocess.Popen(
        [binary, "start", "--web", "--background"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    # Wait for daemon to come up (REST endpoint must respond).
    import http.client

    for _ in range(30):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", 9920, timeout=1.5)
            conn.request("GET", "/api/identity")
            resp = conn.getresponse()
            if resp.status == 200:
                conn.close()
                return
            conn.close()
        except Exception:
            pass
        time.sleep(0.5)
    print("[seed] WARNING: daemon /api/identity not reachable after 15s", file=sys.stderr)


# --- Main ------------------------------------------------------------------


def main() -> None:
    print("[seed] wiping conversation state...")
    # We must wipe AFTER stopping the daemon so the file isn't held open.
    binary = shutil.which("claude-comms") or "/home/plafayette/.local/bin/claude-comms"
    subprocess.run([binary, "stop"], check=False, capture_output=True, timeout=20)
    time.sleep(1.0)
    wipe_state()
    print(f"[seed] writing {len(MESSAGES)} messages + {len(REACTIONS)} reactions...")
    write_state()
    print("[seed] restarting daemon...")
    restart_daemon()
    print(
        "[seed] done. Note: the spec relies on ember/phoenix/sage/alex being\n"
        "       joined into the live registry via MCP. After running this\n"
        "       seed, call comms_join for each (the orchestrator does this)."
    )


if __name__ == "__main__":
    main()
