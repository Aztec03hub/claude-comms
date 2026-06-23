"""Capture daemon-side state and compute run metrics.

This is the "check over how claude-comms handles everything" half: it copies
the daemon's own logs/notifications into the run directory and derives metrics
from both the agent event traces and the daemon artifacts (latency, response
times, hook delivery, artifact version lineage / clobber safety).
"""

from __future__ import annotations

import json
import shutil
import statistics
from pathlib import Path
from typing import Any

from .daemon import DaemonHandle
from .runner import RunResult


def _stats(values: list[float]) -> dict | None:
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return {
        "count": len(vals),
        "mean": round(statistics.mean(vals), 3),
        "p50": round(statistics.median(vals), 3),
        "max": round(max(vals), 3),
    }


def capture_daemon_state(handle: DaemonHandle, run_dir: Path) -> dict:
    """Copy the daemon's own files into run_dir/daemon and summarize them."""
    ddir = run_dir / "daemon"
    (ddir / "logs").mkdir(parents=True, exist_ok=True)
    (ddir / "notifications").mkdir(parents=True, exist_ok=True)

    if handle.log_path.exists():
        shutil.copy(handle.log_path, ddir / "daemon.out")
    log_summary = {}
    for f in handle.logs_dir.glob("*.jsonl"):
        shutil.copy(f, ddir / "logs" / f.name)
        log_summary[f.name] = len(f.read_text().splitlines())
    notif_files = {}
    for f in handle.notifications_dir.glob("*.jsonl"):
        shutil.copy(f, ddir / "notifications" / f.name)
        notif_files[f.name] = len(f.read_text().splitlines())

    return {
        "log_jsonl_lines": log_summary,
        "notification_files": notif_files,  # expected empty: see hook finding
    }


def compute_metrics(result: RunResult, daemon_summary: dict) -> dict[str, Any]:
    events = result.all_events()
    agents = result.agents

    llm_lat = [e["latency_s"] for e in events if e["kind"] == "llm_response"]
    send_lat = [
        e["latency_s"]
        for e in events
        if e["kind"] == "tool_call" and e.get("tool") == "comms_send"
    ]
    coord_lat = [e["latency_s"] for e in events if e["kind"] == "delivery"]

    tool_calls = [e for e in events if e["kind"] == "tool_call"]
    tool_errors = [e for e in tool_calls if e.get("is_error")]
    sends = [e for e in tool_calls if e.get("tool") == "comms_send"]
    hook_runs = [e for e in events if e["kind"] == "hook_run"]
    hook_delivered = [e for e in hook_runs if e.get("delivered")]

    per_agent = {}
    for a in agents:
        a_tool = [e for e in a.events if e["kind"] == "tool_call"]
        by_tool: dict[str, int] = {}
        for e in a_tool:
            by_tool[e["tool"]] = by_tool.get(e["tool"], 0) + 1
        per_agent[a.name] = {
            "turns": len([e for e in a.events if e["kind"] == "turn_output"]),
            "tool_calls": len(a_tool),
            "by_tool": by_tool,
            "errors": len([e for e in a_tool if e.get("is_error")]),
            "tokens_in": a.tokens_in,
            "tokens_out": a.tokens_out,
            "response_time_s": _stats(
                [e["latency_s"] for e in a.events if e["kind"] == "llm_response"]
            ),
        }

    # Artifact / clobber analysis.
    update_calls = [e for e in tool_calls if e.get("tool") == "comms_artifact_update"]
    updates_with_base = [
        e for e in update_calls if "base_version" in (e.get("args") or {})
    ]
    conflict_rejections = [e for e in update_calls if e.get("is_error")]
    artifact_report = []
    for art in result.artifacts:
        authors = [v.get("author") for v in art.get("versions", []) if v.get("author")]
        artifact_report.append(
            {
                "name": art.get("name"),
                "versions": len(art.get("versions", [])),
                "latest_version": art.get("latest_version"),
                "distinct_authors": sorted(set(authors)),
                "author_sequence": authors,
                "content_len": art.get("content_len"),
            }
        )

    auto: list[str] = []
    if hook_runs and not hook_delivered:
        auto.append(
            f"PostToolUse hook fired {len(hook_runs)}x and delivered 0 messages; "
            f"daemon wrote {sum(daemon_summary.get('notification_files', {}).values())} "
            f"notification lines. Mid-turn push delivery appears unwired "
            f"(no component writes notifications/<key>.jsonl) — agents only "
            f"receive via pull (comms_read)."
        )
    if tool_errors:
        kinds = {}
        for e in tool_errors:
            kinds[e["tool"]] = kinds.get(e["tool"], 0) + 1
        auto.append(f"{len(tool_errors)} tool call(s) returned errors: {kinds}")
    if update_calls and not updates_with_base:
        auto.append(
            f"{len(update_calls)} artifact update(s) made WITHOUT base_version — "
            f"last-write-wins, no concurrency protection (clobber risk)."
        )
    if conflict_rejections:
        auto.append(
            f"{len(conflict_rejections)} artifact update(s) rejected for version "
            f"conflict — optimistic-concurrency protection engaged (good)."
        )

    return {
        "scenario": result.config.scenario,
        "objective": result.config.objective,
        "agents": [a.name for a in agents],
        "rounds": result.config.rounds,
        "started_at": result.started_at,
        "totals": {
            "messages_sent": len(sends),
            "tool_calls": len(tool_calls),
            "tool_errors": len(tool_errors),
            "llm_calls": len(llm_lat),
            "tokens_in": sum(a.tokens_in for a in agents),
            "tokens_out": sum(a.tokens_out for a in agents),
        },
        "response_time_s": _stats(llm_lat),
        "transport_latency_s": _stats(send_lat),
        "coordination_latency_s": _stats(coord_lat),
        "hook": {
            "runs": len(hook_runs),
            "delivered": len(hook_delivered),
        },
        "per_agent": per_agent,
        "artifacts": artifact_report,
        "clobber": {
            "update_calls": len(update_calls),
            "updates_with_base_version": len(updates_with_base),
            "conflict_rejections": len(conflict_rejections),
        },
        "members_at_end": result.members,
        "daemon": daemon_summary,
        "auto_findings": auto,
    }


def write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, indent=2, default=str))
