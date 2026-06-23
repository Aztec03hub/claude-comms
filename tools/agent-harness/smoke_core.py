"""Smoke test: prove daemon spawn + MCP client + real comms tool round-trip.

No LLM/API calls here — this only validates the plumbing the agents ride on.
Run: .venv/bin/python tools/agent-harness/smoke_core.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cc_harness.daemon import spawn_daemon, stop_daemon  # noqa: E402
from cc_harness.mcp_link import McpLink  # noqa: E402


async def _exercise(url: str) -> None:
    a = McpLink(url)
    b = McpLink(url)
    await a.connect()
    await b.connect()

    tools = await a.list_tools()
    names = sorted(t.name for t in tools)
    print(f"[ok] MCP connected; {len(tools)} tools, e.g. {names[:6]}")
    assert "comms_join" in names and "comms_send" in names and "comms_read" in names

    ja, _ = await a.call_tool(
        "comms_join", {"name": "alice", "conversation": "general"}
    )
    jb, _ = await b.call_tool("comms_join", {"name": "bob", "conversation": "general"})
    ka, kb = ja["key"], jb["key"]
    print(f"[ok] joined: alice={ka} bob={kb}")

    sent, err = await a.call_tool(
        "comms_send",
        {"key": ka, "conversation": "general", "message": "hello bob, this is alice"},
    )
    assert not err, f"send errored: {sent}"
    print(f"[ok] alice sent: {sent}")

    read, _ = await b.call_tool("comms_read", {"key": kb, "conversation": "general"})
    print(f"[ok] bob read -> {read}")

    await a.aclose()
    await b.aclose()


def main() -> int:
    print("[*] spawning daemon...")
    h = spawn_daemon()
    print(f"[ok] daemon up: {h.mcp_url}  home={h.home}")
    try:
        asyncio.run(_exercise(h.mcp_url))
    finally:
        notif = list(h.notifications_dir.glob("*.jsonl"))
        logs = list(h.logs_dir.glob("*.jsonl"))
        print(f"[i] notifications/*.jsonl written by daemon: {[p.name for p in notif]}")
        print(f"[i] logs/*.jsonl written by daemon: {[p.name for p in logs]}")
        stop_daemon(h, keep_home=False)
        print("[ok] daemon stopped + cleaned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
