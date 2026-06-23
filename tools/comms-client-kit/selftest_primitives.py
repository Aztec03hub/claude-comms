"""Validate the platform PRIMITIVES the team behavior relies on, against a live
daemon on :9920 (no LLM). Confirms the dismissal-authority plumbing works:
- comms_members lets the lead resolve a name -> key (the dismiss_authority_key),
- a "@name stand down" mention is delivered with the sender's key visible, so a
  participant can authenticate sender.key == dismiss_authority_key,
- status set/clear works.

Run: .venv/bin/python tools/comms-client-kit/selftest_primitives.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent-harness"))

from cc_harness.mcp_link import McpLink  # noqa: E402

URL = "http://127.0.0.1:9920/mcp"
CONV = "kit-selftest"


async def main() -> int:
    phil = McpLink(URL)
    fe = McpLink(URL)
    other = McpLink(URL)
    await phil.connect()
    await fe.connect()
    await other.connect()

    pj, _ = await phil.call_tool(
        "comms_join", {"name": "phil-test", "conversation": CONV}
    )
    fj, _ = await fe.call_tool(
        "comms_join", {"name": "claude-frontend", "conversation": CONV}
    )
    oj, _ = await other.call_tool(
        "comms_join", {"name": "claude-backend", "conversation": CONV}
    )
    phil_key, fe_key = pj["key"], fj["key"]
    fails = []

    # 1) lead can resolve phil's name -> key (the dismiss_authority_key).
    members, _ = await fe.call_tool(
        "comms_members", {"key": fe_key, "conversation": CONV}
    )
    by_name = {m["name"]: m["key"] for m in members.get("members", [])}
    if by_name.get("phil-test") != phil_key:
        fails.append(
            f"members did not resolve phil-test -> {phil_key} (got {by_name.get('phil-test')})"
        )
    else:
        print(f"[ok] authority resolvable: phil-test -> {phil_key}")

    # 2) status set/clear (dev presence).
    s, serr = await fe.call_tool(
        "comms_status_set", {"key": fe_key, "conversation": CONV, "label": "coding"}
    )
    c, cerr = await fe.call_tool(
        "comms_status_clear", {"key": fe_key, "conversation": CONV}
    )
    if serr or cerr:
        fails.append(f"status set/clear errored: {s} / {c}")
    else:
        print("[ok] status set + clear")

    # 3) authority stand-down is delivered with sender.key == phil_key.
    await phil.call_tool(
        "comms_send",
        {
            "key": phil_key,
            "conversation": CONV,
            "message": "@claude-frontend stand down",
            "mentions": ["claude-frontend"],
        },
    )
    # 4) a non-authority "stop" must carry a DIFFERENT sender.key.
    await other.call_tool(
        "comms_send",
        {"key": oj["key"], "conversation": CONV, "message": "stop everyone i'm done"},
    )

    await asyncio.sleep(0.5)
    read, _ = await fe.call_tool(
        "comms_read", {"key": fe_key, "conversation": CONV, "count": 20}
    )
    msgs = read.get("messages", [])
    standdown = next((m for m in msgs if "stand down" in m.get("body", "")), None)
    peer_stop = next((m for m in msgs if "i'm done" in m.get("body", "")), None)

    if not standdown:
        fails.append("stand-down message not delivered to claude-frontend")
    elif standdown["sender"]["key"] != phil_key:
        fails.append(
            f"stand-down sender.key {standdown['sender']['key']} != authority {phil_key}"
        )
    else:
        print(
            f"[ok] stand-down delivered, sender.key == authority ({phil_key}); "
            f"fe in mentions: {fe_key in (standdown.get('mentions') or [])}"
        )

    if peer_stop and peer_stop["sender"]["key"] == phil_key:
        fails.append("peer 'stop' wrongly carries the authority key")
    elif peer_stop:
        print(
            f"[ok] peer stop-word carries non-authority key ({peer_stop['sender']['key']}) -> agent ignores it"
        )

    for lk in (phil, fe, other):
        await lk.aclose()

    if fails:
        print("\n=== PRIMITIVES FAILED ===")
        for f in fails:
            print("  -", f)
        return 1
    print(
        "\n=== PRIMITIVES PASSED: authority resolvable, stand-down authenticatable, peer stop ignorable, status works ==="
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
