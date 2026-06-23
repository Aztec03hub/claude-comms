# Agent-harness findings — claude-comms

Curated, de-duplicated findings from real multi-agent runs (2-agent conversation,
3-agent self-organization, 3-agent concurrent-clobber) plus the deterministic
concurrency probe. Each is tagged **verified** (confirmed in source AND/OR
reproducibly observed) or **observed** (strong transcript/metric evidence; worth
a source confirm before fixing).

Generated 2026-06-22. Re-run any scenario to refresh: see `README.md`.

## Resolution status (2026-06-22) — ALL FIXED

Fixed per `plans/harness-findings-fix-plan.md` (converged over 3 adversarial
review rounds) and implemented by 2 parallel portion-owners. Gates: full pytest
1267 passed, vitest 1122 passed, `probe_notify.py` PASS (F1 end-to-end),
`probe_concurrency.py` PASS 5/5.

- **F1** push-delivery unwired → FIXED: new `NotificationWriter` writes per-recipient
  cues; wired into the MQTT subscriber on both launch sites. Hook now delivers.
- **F2** opaque-key recipients → FIXED: `comms_send` adds `recipient_names`/`mention_names`.
- **F3** hardcoded 30s status TTL → FIXED: configurable `presence.activity_ttl_seconds`
  (default 120) + `activity_ttl_max_seconds` (300).
- **F4** doubled whisper prefix → FIXED: idempotent prefix.
- **F5** self-echoed system messages → FIXED: `actor_key` on artifact system msgs + intake filter.
- **F6** artifact result ergonomics → FIXED: `latest_version`/author/`latest_author` (also fixes
  the live web 409 remote-update banner that showed "Someone"/v0).
- **F7** blind-overwrite footgun → FIXED: `unguarded` advisory flag.
- **F8** (found during impl) hook step-5 crashed on newline/quote bodies and was a
  command-injection vector → FIXED: bodies passed via env var, parsed in python (inert).
- Coordination latency: addressed by F1 (push now delivers).

---

## Verified defects

### 1. [HIGH] The PostToolUse "never miss a message" hook delivers nothing — push delivery is unwired
The hook installer writes a hook that drains `~/.claude-comms/notifications/<key>.jsonl`
and injects pending messages as `additionalContext`. **No daemon component ever
writes that file.** `log_exporter.py` writes only `logs/<conv>.{log,jsonl}`; the
daemon startup wires broker + MCP + log-exporter and nothing else; `install_hook`
merely creates the empty `notifications/` dir.

- **Evidence (source):** grep of `src/claude_comms/**` finds no writer for
  `notifications/<key>.jsonl` outside the hook installer.
- **Evidence (behavior):** across all three agent runs the real hook fired
  14 / 30 / 22 times and delivered **0**; the daemon's `notifications/` dir was
  empty every time. Confirmed even in the no-LLM `smoke_core.py` after a real send.
- **Impact:** mid-turn push delivery is a dead path. Agents only receive via pull
  (`comms_read`). The mechanism the product advertises silently no-ops.
- **Fix options:** (a) have the message/delivery path append per-recipient lines
  to `notifications/<key>.jsonl` on send, or (b) deliver over MCP, or (c) remove
  the hook so it doesn't imply a capability that isn't there.

### 2. [HIGH] `comms_send` returns recipients/mentions as opaque keys with no name echo
A whisper to `recipients=["bob"]` returns `recipients: ["c583254d"]`; a mention of
`["bob"]` returns `mentions: ["c583254d"]`. The human name the caller supplied is
replaced by an internal 8-hex key with no name echoed back, so an agent cannot
easily confirm it targeted the right participant (a mis-resolved name would
silently target the wrong key or none, with no readable confirmation).

- **Evidence (source):** `mcp_tools.py` `tool_comms_send` returns
  `"recipients": resolved_recipients` / `"mentions": resolved_mentions` (key
  lists, ~lines 799-800). A `key_to_name` map is already computed nearby (~line
  744) but isn't surfaced in the return.
- **Fix:** return `[{key, name}]` (or add `recipient_names`) — the mapping already
  exists, so this is low-effort and high-value for any non-human client.

---

## Verified positive — the clobber question, answered

### 3. [VERIFIED] `base_version` optimistic concurrency DOES prevent artifact clobbering under real concurrency
`probe_concurrency.py` forces the race the LLM scenarios couldn't: 4 separate MCP
clients read the same version, then fire `comms_artifact_update` with the **same
`base_version` concurrently**.

- **Result:** 5/5 rounds, **exactly one writer wins and the other three are
  rejected with a version conflict** — no lost updates. The read-modify-write in
  `tool_comms_artifact_update` is effectively atomic (single-threaded asyncio; no
  `await` between the version check and the append).
- **Contract corollary (also verified):** with **no** `base_version`, all 4
  concurrent writes are accepted (last-write-wins, versions advanced v6→v10).
- **Takeaway / recommendation:** clobber protection is real **but opt-in**. Agents
  MUST pass `base_version`. Consider warning (or optionally rejecting) blind
  overwrites, and returning the current version in the conflict error (it already
  includes it in the message string — surface it as a field).

> Note: the 3-agent burst scenario alone reported "0 conflicts / no clobbering,"
> which the Opus referee correctly flagged as **false confidence** — the agents
> serialized by timing luck and never actually raced. The probe is what makes the
> clobber guarantee trustworthy. Keep both.

---

## Observed (worth a source confirm before fixing)

### 4. [MEDIUM] `comms_status_set` looks write-only; presence `activity` is always null
Agents set status labels (reading/drafting/thinking) repeatedly with 30s TTLs, but
nothing in any transcript shows a peer ever seeing them, and `comms_members` /
`members_at_end` report `activity: null` for every connection. The 30s TTL also
expires mid-turn (Sonnet turns ran 4-26s), so the signal is stale exactly when it
matters. Verify whether statuses are ever delivered/surfaced and whether
`activity` is meant to be populated.

### 5. [MEDIUM] Coordination latency is high — but read the caveat
Transport latency is excellent (`comms_send` round-trip mean ~6ms). Coordination
latency (sender → recipient actually consumes it) was mean 16-24s, max ~77s.
**Caveat:** this number is inflated by (a) the unwired push (finding #1) and (b)
the harness's deliberately turn-based scheduling, so it is not purely a
claude-comms defect. The real, harness-independent takeaway: with push dead,
agents can only learn of a message on their next pull/turn — wiring #1 is the
lever that would cut this.

### 6. [LOW] Whisper bodies carry doubled `[@name] [@name]` prefixes; authors get system echoes of their own actions
Delivered whisper bodies show duplicated bracketed prefixes (platform tag +
agent-typed tag), and `[system]` artifact-event lines (`[artifact] bob updated …`)
are re-delivered to the actor who just performed and announced the action. Minor
cognitive/token overhead; no data loss.

### 7. [LOW] Artifact tool ergonomics
`comms_artifact_get` returns the latest version number and the full `versions`
lineage (so staleness *is* derivable), but there's no explicit "you are N versions
behind" hint; `comms_artifact_update`'s success return (`{status, name, version}`)
omits the author/base it accepted. Small additions would make lineage/audit
tooling and safe concurrent editing easier.

---

## Harness self-correction (transparency)

An earlier run surfaced a HIGH "artifact version lineage broken
(`distinct_authors: []`, `author: null`, `versions: 1`)" finding. On verification
this was a **bug in the harness's own capture code** (it defaulted current-version
to 1 and read the wrong author field), **not** a claude-comms defect. Fixed in
`runner._capture_artifacts`; the clobber re-run shows correct lineage
(`versions: 4`, `distinct_authors: [alice, bob, carol]`). Recorded here because
distinguishing test-tool artifacts from real defects is the whole point.
