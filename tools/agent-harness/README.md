# claude-comms agent harness

Real multi-agent integration tests: spin up an actual `claude-comms` daemon and
connect **live Sonnet agents** to it over MCP, let them talk and collaborate,
then capture **everything** — each participant's inputs/outputs and how the
daemon handled it — and have an **Opus referee** review the run for bugs and
refinement ideas.

This complements the deterministic suites (pytest / vitest / Playwright). Those
verify multi-participant *logic* against an in-process mock broker. This harness
verifies the *runtime*: multiple real agents exchanging real messages through
the real broker + MCP transport + hook path.

> These runs use the Anthropic API (`ANTHROPIC_API_KEY` from your shell) and are
> **non-deterministic and cost money**. They are intentionally **not** wired into
> CI. Outputs land in `runs/` (gitignored).

## Quick start

```bash
# from repo root; ANTHROPIC_API_KEY must be in the environment
.venv/bin/python tools/agent-harness/run.py two            # 2-agent conversation
.venv/bin/python tools/agent-harness/run.py three          # 3-agent self-organization
.venv/bin/python tools/agent-harness/run.py three --depth deep
.venv/bin/python tools/agent-harness/run.py two --rounds 3 --referee-model claude-opus-4-8
```

Depth → rounds: `quick`=2, `standard`=4 (default), `deep`=7.

No-API / cheap checks:

```bash
.venv/bin/python tools/agent-harness/smoke_core.py          # daemon + MCP + tool round-trip (no API)
.venv/bin/python tools/agent-harness/probe_concurrency.py   # deterministic artifact race probe (no API)
.venv/bin/python tools/agent-harness/smoke_agent.py         # one real Sonnet agent (small $)
```

`probe_concurrency.py` is the rigorous clobber test: it forces a real race (K
concurrent writers, same `base_version`) and asserts exactly one wins. The LLM
scenarios cannot guarantee a race, so this probe is what makes the
no-clobbering guarantee trustworthy. Exits non-zero on a lost update.

## What each run produces

`runs/<timestamp>-<scenario>/`:

| File | Contents |
| --- | --- |
| `report.md` | Human summary: metrics, auto-findings, Opus referee findings + refinements |
| `metrics.json` | Computed metrics (latency, response times, hook delivery, clobber analysis) |
| `events.json` | Merged, time-sorted event timeline across all agents + deliveries |
| `agents/<name>.json` | Per-agent full transcript (every input, model output, tool call+result) |
| `referee.json` | Raw Opus referee output |
| `daemon/daemon.out` | The daemon's own stdout |
| `daemon/logs/*.jsonl` | The daemon's authoritative message log (ground truth) |
| `daemon/notifications/` | Per-recipient notification files (the hook's input) |

## Architecture

```
run.py
 ├─ daemon.py     spawn an isolated claude-comms daemon (own HOME, free ports, real broker+MCP)
 ├─ mcp_link.py   one Streamable-HTTP MCP client session per agent (own connection)
 ├─ agent.py      a Sonnet Anthropic tool-use loop; tools = comms_* via its MCP link;
 │                fires the REAL PostToolUse hook after each tool batch
 ├─ runner.py     round-robin orchestration + harness-mediated delivery + latency capture
 ├─ observe.py    copies daemon-side files; computes metrics + auto-findings
 ├─ referee.py    Opus reviews transcripts + metrics + daemon ground-truth log
 └─ report.py     renders report.md
```

### Why delivery is harness-mediated

Each round, the harness hands every agent the messages newly visible to it (the
daemon enforces whisper/mention visibility per participant key) as that turn's
input. That is what a working push transport *would* do, and it lets us measure
coordination latency precisely. Independently, every agent fires the **real**
PostToolUse hook after each tool batch, so the harness measures the product's
*actual* mid-turn delivery path separately (see findings below).

### Observability

- **Per-participant I/O:** `agents/<name>.json` records every turn input, model
  text, and tool call with arguments, latency, error flag, and result.
- **How claude-comms handled it:** `daemon/` holds the daemon's own stdout and
  its authoritative `logs/*.jsonl` message record; metrics derive artifact
  version lineage and clobber-safety stats from the real artifact store.

## Scenarios

- **`two` — two-agent-conversation:** two engineers coordinate (broadcast,
  whisper, mention, read) to agree on release-notes bullets and post a FINAL.
- **`three` — three-agent-selforg:** three agents with no leader co-author one
  shared `api-spec` artifact, dividing sections and updating the same artifact
  with `base_version` — stresses self-organization, latency, hooks, response
  times, and concurrent-artifact clobber safety.

## Findings

Curated, verified findings (and the clobber answer) live in **`FINDINGS.md`**.
Headlines:

- **[HIGH]** the PostToolUse "never miss a message" hook delivers nothing — no
  daemon component writes `notifications/<key>.jsonl`, so push delivery no-ops;
  agents receive only via pull.
- **[HIGH]** `comms_send` returns whisper/mention targets as opaque keys with no
  name echo, so agents can't verify who they targeted.
- **[VERIFIED ✓]** artifact `base_version` optimistic concurrency prevents
  clobbering under real concurrency (probe: exactly one of K racing writers wins);
  with no `base_version`, last-write-wins.
