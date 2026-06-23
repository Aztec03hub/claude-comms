"""Deterministic F1 notification-delivery probe (no LLM, real daemon).

Proves the WIRING end to end: a real whisper/mention published over the broker
makes the daemon write per-recipient cue files, the hook drains them, and there
is no visibility leak or self-cue. The unit tests cover NotificationWriter in
isolation; this covers the live daemon subscriber path that unit tests can't.

Run: .venv/bin/python tools/agent-harness/probe_notify.py
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cc_harness.daemon import spawn_daemon, stop_daemon  # noqa: E402
from cc_harness.hooks import install_hook_script, run_hook  # noqa: E402
from cc_harness.mcp_link import McpLink  # noqa: E402


def _lines(p: Path) -> list[str]:
    return p.read_text().splitlines() if p.exists() else []


async def _wait_for(path: Path, timeout: float = 4.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if path.exists() and path.read_text().strip():
            return True
        await asyncio.sleep(0.1)
    return False


async def _run(handle) -> int:
    url = handle.mcp_url
    notif = handle.notifications_dir
    links = {n: McpLink(url) for n in ("alice", "bob", "carol")}
    for lk in links.values():
        await lk.connect()
    keys = {}
    for n, lk in links.items():
        j, _ = await lk.call_tool("comms_join", {"name": n, "conversation": "general"})
        keys[n] = j["key"]

    failures = []

    # 1) alice whispers to bob.
    await links["alice"].call_tool(
        "comms_send",
        {
            "key": keys["alice"],
            "conversation": "general",
            "message": "secret for bob",
            "recipients": ["bob"],
        },
    )
    bob_file = notif / f"{keys['bob']}.jsonl"
    if not await _wait_for(bob_file):
        failures.append("whisper: bob cue file not written")
    # leak guard: carol (not a recipient) must NOT get the whisper
    if _lines(notif / f"{keys['carol']}.jsonl"):
        failures.append("LEAK: carol got a cue for a whisper not addressed to her")
    # self-cue guard: alice must not cue herself
    if _lines(notif / f"{keys['alice']}.jsonl"):
        failures.append("self-cue: alice cued herself")

    # 2) alice mentions carol in a broadcast.
    await links["alice"].call_tool(
        "comms_send",
        {
            "key": keys["alice"],
            "conversation": "general",
            "message": "broadcast with a nod",
            "mentions": ["carol"],
        },
    )
    carol_file = notif / f"{keys['carol']}.jsonl"
    if not await _wait_for(carol_file):
        failures.append("mention: carol cue file not written")

    # 3) bob's REAL hook drains the whisper cue and surfaces additionalContext.
    hook_path = install_hook_script(keys["bob"], handle.home)
    hook = run_hook(hook_path, handle.home)
    if not hook.get("delivered"):
        failures.append(f"hook: bob's hook delivered nothing (raw={hook.get('raw')!r})")
    else:
        print(f"[ok] bob hook delivered: {hook['context'][:80]!r}")

    print(
        f"[i] bob cue lines: {len(_lines(bob_file))}; carol cue lines: {len(_lines(carol_file))}; "
        f"alice cue lines: {len(_lines(notif / (keys['alice'] + '.jsonl')))}"
    )

    for lk in links.values():
        await lk.aclose()

    if failures:
        print("\n=== PROBE FAILED ===")
        for f in failures:
            print("  -", f)
        return 1
    print(
        "\n=== PROBE PASSED: cues delivered, no leak, no self-cue, hook surfaced context ==="
    )
    return 0


def main() -> int:
    h = spawn_daemon()
    print(f"[ok] daemon up: {h.mcp_url}")
    try:
        return asyncio.run(_run(h))
    finally:
        stop_daemon(h)


if __name__ == "__main__":
    raise SystemExit(main())
