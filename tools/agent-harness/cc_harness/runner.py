"""Round-robin orchestration of real Sonnet agents over a live daemon.

Each round, every agent is handed the messages newly visible to it (the daemon
enforces whisper/mention visibility per key) as its turn input, then runs its
tool-use loop. Delivery is harness-mediated on purpose: that is what a working
push transport WOULD do, and it lets us measure coordination latency precisely
while the in-loop real hook independently measures the product's actual
(currently unwired) mid-turn delivery path.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime

from anthropic import AsyncAnthropic

from .agent import Agent, AgentSpec
from .daemon import DaemonHandle, spawn_daemon
from .mcp_link import McpLink

PROTOCOL_NOTE = (
    "\n\nTEAM CHAT PROTOCOL:\n"
    "- The conversation id is '{conv}' (use it verbatim, no '#').\n"
    "- To say something to the team, call comms_send.\n"
    "- Messages from teammates are delivered to you at the start of each turn.\n"
    "- For shared documents use comms_artifact_create / comms_artifact_update. "
    "When updating, pass base_version (the version you last saw) so the system "
    "can reject conflicting concurrent edits instead of silently clobbering.\n"
    "- Keep messages short. Do real work; don't just chat."
)


@dataclass
class RunConfig:
    scenario: str
    objective: str
    agent_specs: list[AgentSpec]
    conversation: str = "general"
    rounds: int = 5
    burst_rounds: int = 0  # rounds where ALL agents act concurrently (race testing)
    allowlist: list[str] | None = None


@dataclass
class RunResult:
    config: RunConfig
    handle: DaemonHandle
    agents: list[Agent]
    links: list[McpLink]
    deliveries: list[dict] = field(default_factory=list)
    artifacts: list[dict] = field(default_factory=list)
    members: list[dict] = field(default_factory=list)
    started_at: str = ""

    def all_events(self) -> list[dict]:
        evs: list[dict] = []
        for a in self.agents:
            evs.extend(a.events)
        evs.extend(self.deliveries)
        return sorted(evs, key=lambda e: e["t"])


def _fmt_messages(msgs: list[dict]) -> str:
    out = []
    for m in msgs:
        sender = m.get("sender", {}).get("name", "?")
        tag = ""
        if m.get("recipients"):
            tag = " (whisper to you)"
        elif m.get("mentions"):
            tag = " (mentions you)"
        out.append(f"[{sender}]{tag}: {m.get('body', '')}")
    return "\n".join(out)


async def _capture_artifacts(link: McpLink, key: str, conversation: str) -> list[dict]:
    """Capture full artifact lineage. comms_artifact_get (latest) returns a
    `versions` list with per-version author/timestamp/summary — the authoritative
    lineage — so one get per artifact is enough."""
    listing, err = await link.call_tool(
        "comms_artifact_list", {"key": key, "conversation": conversation}
    )
    if err or not isinstance(listing, dict):
        return []
    arts = []
    for meta in listing.get("artifacts", []) or []:
        name = meta.get("name")
        got, gerr = await link.call_tool(
            "comms_artifact_get",
            {"key": key, "conversation": conversation, "name": name},
        )
        if gerr or not isinstance(got, dict):
            arts.append({"name": name, "list_meta": meta, "versions": []})
            continue
        versions = [
            {
                "version": v.get("version"),
                "author": (v.get("author") or {}).get("name"),
                "summary": v.get("summary"),
                "timestamp": v.get("timestamp"),
            }
            for v in (got.get("versions", []) or [])
        ]
        arts.append(
            {
                "name": name,
                "latest_version": got.get("version"),
                "title": got.get("title"),
                "content_len": got.get("total_chars"),
                "content_head": (got.get("content", "") or "")[:600],
                "versions": versions,
            }
        )
    return arts


async def run_scenario(cfg: RunConfig) -> RunResult:
    """Run the scenario end to end. Leaves the daemon RUNNING (caller captures
    daemon-side files, then stops it)."""
    handle = spawn_daemon()
    client = AsyncAnthropic()
    agents: list[Agent] = []
    links: list[McpLink] = []

    for spec in cfg.agent_specs:
        link = McpLink(handle.mcp_url)
        await link.connect()
        persona = spec.persona + PROTOCOL_NOTE.format(conv=cfg.conversation)
        agent = Agent(
            spec=AgentSpec(name=spec.name, persona=persona, model=spec.model),
            link=link,
            home=handle.home,
            client=client,
        )
        await agent.setup(cfg.allowlist)
        await agent.join(cfg.conversation)
        agents.append(agent)
        links.append(link)

    result = RunResult(
        config=cfg,
        handle=handle,
        agents=agents,
        links=links,
        started_at=datetime.now().isoformat(timespec="seconds"),
    )

    seen: dict[str, set] = {a.name: set() for a in agents}

    async def _turn(agent: Agent, link: McpLink, rnd: int) -> None:
        read, err = await link.call_tool(
            "comms_read",
            {"key": agent.key, "conversation": cfg.conversation, "count": 100},
        )
        new_msgs: list[dict] = []
        if not err and isinstance(read, dict):
            for m in read.get("messages", []) or []:
                mid = m.get("id")
                if mid in seen[agent.name]:
                    continue
                seen[agent.name].add(mid)
                if m.get("sender", {}).get("key") == agent.key:
                    continue
                # F5: artifact system messages (sender.key == "00000000") carry
                # the acting participant's key in `actor_key`. Drop the actor's
                # own artifact echo so it doesn't re-receive what it just did.
                if m.get("actor_key") == agent.key:
                    continue
                new_msgs.append(m)
                # coordination latency: daemon store-ts -> delivery now
                lat = None
                try:
                    send_ts = datetime.fromisoformat(m["ts"]).timestamp()
                    lat = round(time.time() - send_ts, 3)
                except (KeyError, ValueError, TypeError):
                    pass
                result.deliveries.append(
                    {
                        "t": time.time(),
                        "kind": "delivery",
                        "agent": agent.name,
                        "to": agent.name,
                        "from": m.get("sender", {}).get("name"),
                        "msg_id": mid,
                        "latency_s": lat,
                    }
                )

        parts = []
        if rnd == 0:
            parts.append(f"YOUR OBJECTIVE:\n{cfg.objective}")
        if new_msgs:
            parts.append("NEW MESSAGES:\n" + _fmt_messages(new_msgs))
        elif rnd > 0:
            parts.append(
                "(No new messages.) Continue making progress on the objective."
            )
        await agent.act("\n\n".join(parts))

    # Sequential rounds: clean turn-taking, precise per-message coordination latency.
    for rnd in range(cfg.rounds):
        for agent, link in zip(agents, links):
            await _turn(agent, link, rnd)

    # Burst rounds: ALL agents act CONCURRENTLY (separate MCP connections), so
    # simultaneous edits to the same artifact race for real — this is the
    # clobber / optimistic-concurrency stress test.
    for b in range(cfg.burst_rounds):
        rnd = cfg.rounds + b
        await asyncio.gather(*[_turn(a, lk, rnd) for a, lk in zip(agents, links)])

    # End-of-run authoritative capture via the first agent's link.
    if agents:
        result.artifacts = await _capture_artifacts(
            links[0], agents[0].key, cfg.conversation
        )
        members, merr = await links[0].call_tool(
            "comms_members", {"key": agents[0].key, "conversation": cfg.conversation}
        )
        if not merr and isinstance(members, dict):
            result.members = members.get("members", []) or []

    return result


async def teardown(result: RunResult) -> None:
    for link in result.links:
        try:
            await link.aclose()
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass
