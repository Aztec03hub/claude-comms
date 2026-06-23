"""Run a claude-comms multi-agent harness scenario end to end.

Examples:
  .venv/bin/python tools/agent-harness/run.py two
  .venv/bin/python tools/agent-harness/run.py three --depth standard
  .venv/bin/python tools/agent-harness/run.py three --rounds 6 --referee-model claude-opus-4-8

Real Sonnet agents connect to a real daemon over MCP; costs API tokens.
Output lands in tools/agent-harness/runs/<timestamp>-<scenario>/.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from cc_harness.daemon import stop_daemon  # noqa: E402
from cc_harness.observe import capture_daemon_state, compute_metrics, write_json  # noqa: E402
from cc_harness.referee import REFEREE_MODEL, build_review_input, review  # noqa: E402
from cc_harness.report import render_markdown  # noqa: E402
from cc_harness.runner import run_scenario, teardown  # noqa: E402
from scenarios import DEPTH_ROUNDS, SCENARIOS  # noqa: E402


async def _main(args: argparse.Namespace) -> int:
    rounds = args.rounds or DEPTH_ROUNDS[args.depth]
    cfg = SCENARIOS[args.scenario](rounds)
    run_dir = HERE / "runs" / f"{datetime.now():%Y%m%d-%H%M%S}-{cfg.scenario}"
    run_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"[*] scenario={cfg.scenario} agents={[s.name for s in cfg.agent_specs]} rounds={rounds}"
    )
    print(f"[*] output -> {run_dir}")

    result = await run_scenario(cfg)
    print("[ok] scenario complete; capturing daemon state + computing metrics")

    daemon_summary = capture_daemon_state(result.handle, run_dir)
    metrics = compute_metrics(result, daemon_summary)

    # Persist raw artifacts before the (potentially failing) referee call.
    write_json(run_dir / "metrics.json", metrics)
    write_json(run_dir / "events.json", result.all_events())
    agents_dir = run_dir / "agents"
    agents_dir.mkdir(exist_ok=True)
    for a in result.agents:
        write_json(
            agents_dir / f"{a.name}.json",
            {
                "name": a.name,
                "key": a.key,
                "tokens_in": a.tokens_in,
                "tokens_out": a.tokens_out,
                "events": a.events,
            },
        )

    # Ground-truth daemon log (full message bodies) for referee verification.
    daemon_log_lines: list[str] = []
    glog = run_dir / "daemon" / "logs" / "general.jsonl"
    if glog.exists():
        daemon_log_lines = glog.read_text().splitlines()

    print(f"[*] referee review via {args.referee_model} ...")
    try:
        referee = await review(
            build_review_input(metrics, result, daemon_log_lines),
            model=args.referee_model,
        )
    except Exception as exc:  # noqa: BLE001 - never lose the run over a referee error
        referee = {
            "summary": f"referee call failed: {exc}",
            "findings": [],
            "refinements": [],
        }
    write_json(run_dir / "referee.json", referee)

    (run_dir / "report.md").write_text(render_markdown(metrics, referee))

    await teardown(result)
    stop_daemon(result.handle)

    print(f"\n[ok] report -> {run_dir / 'report.md'}")
    print(
        f"[i] auto-findings: {len(metrics['auto_findings'])} | "
        f"referee findings: {len(referee.get('findings', []))}"
    )
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="claude-comms multi-agent harness")
    p.add_argument("scenario", choices=sorted(SCENARIOS), help="which scenario to run")
    p.add_argument("--depth", choices=sorted(DEPTH_ROUNDS), default="standard")
    p.add_argument("--rounds", type=int, default=0, help="override depth's round count")
    p.add_argument("--referee-model", default=REFEREE_MODEL)
    args = p.parse_args()
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
