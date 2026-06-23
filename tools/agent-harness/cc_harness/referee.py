"""Opus referee: read the whole run and surface bugs + refinement insights.

This is the "useful for refining and improving claude-comms" half. It is given
the metrics, a compact per-agent transcript (inputs/outputs/tool I/O), the
daemon's own log sample, and the artifact lineage, and asked to behave like a
senior engineer reviewing a real multi-agent session.
"""

from __future__ import annotations

import json
from typing import Any

from anthropic import AsyncAnthropic

REFEREE_MODEL = "claude-opus-4-8"

SYSTEM = """You are a senior distributed-systems engineer reviewing a REAL run of \
"claude-comms" — an MQTT-backed multi-agent chat/coordination platform. Multiple \
live Sonnet agents just connected to a running daemon over MCP and exchanged \
messages / collaborated on artifacts. You are given (1) computed metrics, (2) a \
per-agent transcript of every input, model output, and tool call+result, (3) a \
sample of the daemon's own message log, (4) artifact version lineage.

Your job is to find what's WRONG or IMPROVABLE in claude-comms itself (not the \
agents' personalities). Look for: dropped/duplicated/mis-delivered messages, \
broken or misleading tool results, visibility/whisper leaks, presence errors, \
artifact clobbering or lost updates, latency problems, confusing tool ergonomics \
that made agents stumble, and any mechanism that silently no-ops. Distinguish \
real defects from agent mistakes. Be concrete and cite evidence from the data.

IMPORTANT — avoid false positives from harness truncation: the per-agent \
transcript fields are TRUNCATED by the test harness and end with the marker \
'…[+N]'. NEVER report harness truncation as a product bug. The \
'daemon_log_sample' contains the FULL, untruncated message bodies exactly as the \
daemon stored them — treat it as ground truth and verify any message-content or \
delivery claim against it before reporting.

Respond with ONLY a JSON object (no prose, no code fence):
{
  "summary": "2-3 sentence overall assessment",
  "findings": [
    {"severity": "high|medium|low", "title": "...", "detail": "...",
     "evidence": "specific event/metric/log reference",
     "category": "delivery|visibility|artifacts|presence|latency|ergonomics|other"}
  ],
  "refinements": [
    {"priority": "high|medium|low", "idea": "...", "why": "..."}
  ]
}"""


def _trunc(s: str, n: int) -> str:
    """Truncate with an explicit marker so the referee never mistakes harness
    truncation for a product defect."""
    if s is None:
        return ""
    if len(s) <= n:
        return s
    return s[:n] + f"…[+{len(s) - n}]"


def _compact_transcript(result: Any, per_agent_cap: int = 80) -> dict:
    out: dict[str, list] = {}
    for a in result.agents:
        rows = []
        for e in a.events:
            k = e["kind"]
            if k == "turn_input":
                rows.append({"in": _trunc(e["text"], 700)})
            elif k == "llm_response" and e.get("text"):
                rows.append({"say": _trunc(e["text"], 700)})
            elif k == "tool_call":
                rows.append(
                    {
                        "tool": e["tool"],
                        "args": e.get("args"),
                        "error": e.get("is_error"),
                        "result": _trunc(json.dumps(e.get("result")), 700),
                    }
                )
            elif k == "hook_run":
                rows.append({"hook_delivered": e.get("delivered")})
        out[a.name] = rows[:per_agent_cap]
    return out


def build_review_input(
    metrics: dict, result: Any, daemon_log_lines: list[str] | None = None
) -> dict:
    return {
        "metrics": metrics,
        "transcripts": _compact_transcript(result),
        "artifacts": result.artifacts,
        # FULL message bodies as stored by the daemon — ground truth for the
        # referee to verify content/delivery/visibility claims against.
        "daemon_log_sample": daemon_log_lines or [],
    }


async def review(review_input: dict, model: str = REFEREE_MODEL) -> dict:
    client = AsyncAnthropic()
    payload = json.dumps(review_input, default=str)[:120000]
    resp = await client.messages.create(
        model=model,
        max_tokens=4000,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"RUN DATA:\n{payload}"}],
    )
    text = " ".join(b.text for b in resp.content if b.type == "text").strip()
    # Be tolerant of an accidental code fence.
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{") :]
    try:
        parsed = json.loads(text[text.find("{") : text.rfind("}") + 1])
    except (json.JSONDecodeError, ValueError):
        parsed = {"summary": "referee returned unparseable output", "raw": text}
    parsed["_model"] = model
    parsed["_tokens"] = {"in": resp.usage.input_tokens, "out": resp.usage.output_tokens}
    return parsed
