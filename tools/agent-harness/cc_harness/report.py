"""Render a human-readable markdown report from metrics + referee output."""

from __future__ import annotations


def _lat(d: dict | None) -> str:
    if not d:
        return "n/a"
    return f"mean {d['mean']}s / p50 {d['p50']}s / max {d['max']}s (n={d['count']})"


def render_markdown(metrics: dict, referee: dict) -> str:
    m = metrics
    t = m["totals"]
    lines: list[str] = []
    lines.append(f"# Agent harness run — {m['scenario']}")
    lines.append("")
    lines.append(f"- **Started:** {m['started_at']}")
    lines.append(
        f"- **Agents:** {', '.join(m['agents'])}  |  **Rounds:** {m['rounds']}"
    )
    lines.append(f"- **Objective:** {m['objective']}")
    lines.append(
        f"- **Tokens:** {t['tokens_in']:,} in / {t['tokens_out']:,} out "
        f"(participants Sonnet; referee {referee.get('_model', '?')})"
    )
    lines.append("")

    lines.append("## Metrics")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Messages sent | {t['messages_sent']} |")
    lines.append(f"| Tool calls (errors) | {t['tool_calls']} ({t['tool_errors']}) |")
    lines.append(f"| Agent response time | {_lat(m['response_time_s'])} |")
    lines.append(f"| Send transport latency | {_lat(m['transport_latency_s'])} |")
    lines.append(f"| Coordination latency | {_lat(m['coordination_latency_s'])} |")
    lines.append(
        f"| PostToolUse hook | delivered {m['hook']['delivered']} / {m['hook']['runs']} runs |"
    )
    cl = m["clobber"]
    lines.append(
        f"| Artifact updates | {cl['update_calls']} "
        f"({cl['updates_with_base_version']} w/ base_version, "
        f"{cl['conflict_rejections']} conflict-rejected) |"
    )
    lines.append("")

    lines.append("## Per-agent")
    lines.append("")
    lines.append(
        "| Agent | Turns | Tool calls | Errors | Tokens (in/out) | Response time |"
    )
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for name, pa in m["per_agent"].items():
        lines.append(
            f"| {name} | {pa['turns']} | {pa['tool_calls']} | {pa['errors']} | "
            f"{pa['tokens_in']:,}/{pa['tokens_out']:,} | {_lat(pa['response_time_s'])} |"
        )
    lines.append("")

    if m["artifacts"]:
        lines.append("## Artifacts")
        lines.append("")
        for art in m["artifacts"]:
            lines.append(
                f"- **{art['name']}** — {art['versions']} version(s); "
                f"authors: {', '.join(art['distinct_authors']) or 'none'}; "
                f"sequence: {' -> '.join(art['author_sequence']) or 'n/a'}"
            )
        lines.append("")

    lines.append("## Auto-detected findings")
    lines.append("")
    if m["auto_findings"]:
        for f in m["auto_findings"]:
            lines.append(f"- {f}")
    else:
        lines.append("- (none)")
    lines.append("")

    lines.append("## Referee review (Opus)")
    lines.append("")
    lines.append(f"> {referee.get('summary', '(no summary)')}")
    lines.append("")
    findings = referee.get("findings", [])
    if findings:
        order = {"high": 0, "medium": 1, "low": 2}
        for f in sorted(findings, key=lambda x: order.get(x.get("severity"), 3)):
            lines.append(
                f"### [{f.get('severity', '?').upper()}] {f.get('title', '')} "
                f"({f.get('category', '')})"
            )
            lines.append("")
            lines.append(f.get("detail", ""))
            if f.get("evidence"):
                lines.append("")
                lines.append(f"*Evidence:* {f['evidence']}")
            lines.append("")
    refs = referee.get("refinements", [])
    if refs:
        lines.append("## Referee refinement ideas")
        lines.append("")
        order = {"high": 0, "medium": 1, "low": 2}
        for r in sorted(refs, key=lambda x: order.get(x.get("priority"), 3)):
            lines.append(
                f"- **[{r.get('priority', '?')}]** {r.get('idea', '')} — {r.get('why', '')}"
            )
        lines.append("")

    return "\n".join(lines)
