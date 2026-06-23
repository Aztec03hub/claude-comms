"""Smoke test: one real Sonnet agent joins and sends one message (minimal $).

Run: .venv/bin/python tools/agent-harness/smoke_agent.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from anthropic import AsyncAnthropic  # noqa: E402

from cc_harness.agent import Agent, AgentSpec  # noqa: E402
from cc_harness.daemon import spawn_daemon, stop_daemon  # noqa: E402
from cc_harness.mcp_link import McpLink  # noqa: E402


async def _run(home: Path, url: str) -> None:
    client = AsyncAnthropic()
    link = McpLink(url)
    await link.connect()
    agent = Agent(
        spec=AgentSpec(
            name="alice",
            persona=(
                "You are Alice, a friendly engineer in a team chat called #general. "
                "Use the comms_send tool to post messages. Be concise."
            ),
        ),
        link=link,
        home=home,
        client=client,
    )
    await agent.setup()
    await agent.join("general")
    text = await agent.act(
        "Post a one-line hello to #general introducing yourself, then stop."
    )
    print(f"\n[alice final text] {text}\n")
    print("=== event trace ===")
    for e in agent.events:
        print(
            f"  {e['kind']:14} {json.dumps({k: v for k, v in e.items() if k not in ('t', 'kind', 'agent')})[:160]}"
        )
    print(f"\ntokens in/out: {agent.tokens_in}/{agent.tokens_out}")
    await link.aclose()


def main() -> int:
    h = spawn_daemon()
    print(f"[ok] daemon up: {h.mcp_url}")
    try:
        asyncio.run(_run(h.home, h.mcp_url))
        # Did the message land in the daemon's real log?
        log = h.logs_dir / "general.jsonl"
        lines = log.read_text().splitlines() if log.exists() else []
        print(f"[i] general.jsonl lines: {len(lines)}")
        for ln in lines[-3:]:
            print("   ", ln[:160])
    finally:
        stop_daemon(h)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
