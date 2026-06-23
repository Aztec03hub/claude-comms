"""Deterministic artifact-concurrency probe (no LLM, real stack).

The agent scenarios can't GUARANTEE a real race — agents serialize by timing
luck, so the conflict-rejection path may never fire (a known source of false
confidence). This probe forces the race: K separate MCP clients read the same
version, then fire comms_artifact_update CONCURRENTLY with the SAME base_version.

Correct optimistic concurrency => exactly ONE update wins per race and the rest
are rejected with a version conflict. If more than one wins, a write was lost
(clobber). We also show the no-base_version path (last-write-wins) for contrast.

Run: .venv/bin/python tools/agent-harness/probe_concurrency.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cc_harness.daemon import spawn_daemon, stop_daemon  # noqa: E402
from cc_harness.mcp_link import McpLink  # noqa: E402

K = 4  # concurrent writers
ROUNDS = 5  # forced races
CONV = "general"
ART = "race-doc"


def _is_conflict(res: object) -> bool:
    return bool(
        isinstance(res, dict)
        and res.get("error")
        and "conflict" in str(res.get("message", "")).lower()
    )


def _is_success(res: object) -> bool:
    return isinstance(res, dict) and res.get("status") == "updated"


async def _latest_version(link: McpLink, key: str) -> int:
    got, _ = await link.call_tool(
        "comms_artifact_get", {"key": key, "conversation": CONV, "name": ART}
    )
    return int(got.get("version", 0)) if isinstance(got, dict) else 0


async def _run(url: str) -> int:
    links = [McpLink(url) for _ in range(K)]
    for lk in links:
        await lk.connect()
    keys = []
    for i, lk in enumerate(links):
        j, _ = await lk.call_tool("comms_join", {"name": f"w{i}", "conversation": CONV})
        keys.append(j["key"])

    # Creator makes v1.
    await links[0].call_tool(
        "comms_artifact_create",
        {
            "key": keys[0],
            "conversation": CONV,
            "name": ART,
            "title": "Race Doc",
            "type": "doc",
            "content": "v1 seed",
        },
    )

    print(
        f"\n[A] base_version race: {K} concurrent writers, same base_version, {ROUNDS} rounds"
    )
    failures = 0
    for r in range(ROUNDS):
        base = await _latest_version(links[0], keys[0])

        async def _upd(i: int):
            return await links[i].call_tool(
                "comms_artifact_update",
                {
                    "key": keys[i],
                    "conversation": CONV,
                    "name": ART,
                    "content": f"writer {i}, round {r}",
                    "summary": f"w{i}",
                    "base_version": base,
                },
            )

        results = await asyncio.gather(*[_upd(i) for i in range(K)])
        res = [r0 for r0, _ in results]
        wins = sum(_is_success(x) for x in res)
        conflicts = sum(_is_conflict(x) for x in res)
        after = await _latest_version(links[0], keys[0])
        verdict = "OK" if wins == 1 and after == base + 1 else "CLOBBER/BUG"
        if verdict != "OK":
            failures += 1
        print(
            f"  round {r}: base=v{base} -> wins={wins} conflicts={conflicts} "
            f"other={K - wins - conflicts} latest=v{after}  [{verdict}]"
        )

    print(f"\n[B] no base_version (last-write-wins contract): {K} concurrent writers")
    base = await _latest_version(links[0], keys[0])

    async def _upd_nb(i: int):
        return await links[i].call_tool(
            "comms_artifact_update",
            {
                "key": keys[i],
                "conversation": CONV,
                "name": ART,
                "content": f"nb writer {i}",
                "summary": f"nb{i}",
            },
        )

    results = await asyncio.gather(*[_upd_nb(i) for i in range(K)])
    wins = sum(_is_success(r0) for r0, _ in results)
    after = await _latest_version(links[0], keys[0])
    print(
        f"  base=v{base} -> wins={wins} latest=v{after} "
        f"(no base_version => all accepted; versions advance by {after - base})"
    )

    for lk in links:
        await lk.aclose()

    print(
        f"\n=== PROBE {'PASSED' if failures == 0 else 'FAILED'}: "
        f"{ROUNDS - failures}/{ROUNDS} base_version races correctly allowed exactly one writer ==="
    )
    return 1 if failures else 0


def main() -> int:
    h = spawn_daemon()
    print(f"[ok] daemon up: {h.mcp_url}")
    try:
        return asyncio.run(_run(h.mcp_url))
    finally:
        stop_daemon(h)


if __name__ == "__main__":
    raise SystemExit(main())
