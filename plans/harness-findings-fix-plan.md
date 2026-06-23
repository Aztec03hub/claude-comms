# claude-comms — Harness Findings Fix Plan

> Status: DRAFT v1 (pre-review). Drives implementation of fixes for every finding
> surfaced by the multi-agent harness (`tools/agent-harness/`, see `FINDINGS.md`).
> This plan is iterated by a single-agent both-lens adversarial review until it
> converges to zero critical / high / medium findings.

## 1. Context & goal

The multi-agent harness (`tools/agent-harness/`) ran real Sonnet agents against a
live `claude-comms` daemon and surfaced concrete defects (`tools/agent-harness/FINDINGS.md`).
This plan fixes all of them. Every fix must ship with tests, and the
behavioral fixes must be re-verified by re-running the harness / probe.

Source of truth for code locations is the current tree under `src/claude_comms/`.
Line numbers in this plan are guides; implementers and reviewers MUST re-grep and
read the actual function before editing (APIs drift).

Non-goals: any "Jeremy / external review prep" work; UI redesign; new features
beyond what a finding requires.

## 2. Convergence criteria & review process

- A single review agent applies BOTH lenses (correctness + risk) per round,
  surfacing findings at critical / high / medium / low / nit, and edits THIS plan
  to resolve every critical/high/medium finding it raises.
- Loop until a round yields **zero critical, zero high, zero medium**. Low/nit are
  then resolved at the orchestrator's discretion.
- Review agents must verify each cited API against the actual source before
  trusting this plan's pseudocode (no fabricated signatures).
- Iteration log kept in §16 and in `.worklogs/harness-fixes/`.

## 3. Findings → fixes summary

| ID | Finding (severity) | Fix | Verified by |
| --- | --- | --- | --- |
| F1 | PostToolUse hook delivers nothing — no notif writer (HIGH) | Add notification writer in the MQTT subscriber; gate on config | harness re-run: `hook.delivered > 0`; new unit tests |
| F2 | comms_send returns opaque keys, no name echo (HIGH) | Add `recipient_names`/`mention_names` (additive) | unit test on return shape |
| F3 | 30s activity TTL hardcoded + expires mid-turn; `/activity` event ships but isn't consumed (MEDIUM) | Configurable TTL default+cap (config dict); document existing `/activity` event; new consumer out of scope | unit + harness check |
| F4 | whisper body doubled `[@name]` prefix (LOW) | Idempotent prefix (skip if already present) | unit test |
| F5 | self-authored `[system]` artifact echoes returned to actor (LOW) | Add `actor_key` to artifact create/update/delete system msgs (3 sites); harness skips own; web already self-suppresses | unit test |
| F6 | artifact result ergonomics (LOW) | add `latest_version`, author; conflict adds `latest_version`+`latest_author` (web-banner names) | unit test + web edit-flow |
| F7 | blind (no base_version) overwrite has no guard (LOW/NIT) | optional warn/flag in result | unit test |
| — | high coordination latency (MEDIUM) | consequence of F1 + harness scheduling; no separate code change | harness re-run after F1 |

## 4. F1 — Wire notification delivery so the PostToolUse hook works [HIGH]

**Problem.** The hook (`hook_installer._generate_unix_script`) drains
`~/.claude-comms/notifications/<key>.jsonl`, but no daemon component ever writes
that file (confirmed by source search + harness behavior: hook fired 14/30/22×,
delivered 0). Push delivery silently no-ops.

**Where to write.** The MQTT message subscriber `_mqtt_subscriber()` lives in
`mcp_server.py` (def at line 642). It already (a) receives every message dict,
(b) gates on the module-level `_deduplicator` (line 701, `is_duplicate` check —
runs BEFORE persistence) and (c) calls `log_exporter.write_message(data)`
(verified line 755, inside `if log_exporter is not None:` at 753). Add the
notification write **in its OWN block immediately after the `if log_exporter is
not None:` block** (i.e. still after the dedup gate at 701 and after the
thread-metadata / `_touch` handling, but NOT nested inside the log-exporter `if`),
wrapped in its own `try/except`. Do NOT place it inside the `if log_exporter is
not None:` guard — in standalone mode `log_exporter` is `None`, so a notifier
nested there would never fire, silently re-creating the dead-push bug this finding
fixes (and defeating the standalone-parity requirement below). Do NOT put this in
`LogExporter` (no registry access, and notification fan-out is a distinct
concern). Sketch:
```python
# after the `if log_exporter is not None: ... write_message(...)` block, same
# post-dedup scope:
if notifier is not None:
    try:
        notifier.write(data)
    except Exception:
        logger.warning("Failed to write notification cue", exc_info=True)
```

**IMPORTANT — two launch sites.** `_mqtt_subscriber` is started in TWO places:
1. `cli.py` line ~1509 — the **daemon** path, which passes `log_exporter=_log_exporter`
   (this is what the harness exercises). The notifier MUST be wired here.
2. `mcp_server.py` `run_mcp_server()` line ~2011 — the **standalone** MCP-server
   path, which today passes NO `log_exporter`. Wire the notifier here too (or
   document explicitly that standalone mode has no push delivery). Pick the daemon
   path as the primary fix and the harness gate; extend `run_mcp_server` for parity
   so push isn't silently dead in standalone mode.
The notifier is threaded through `_mqtt_subscriber`'s signature as a new optional
kwarg (`notifier: NotificationWriter | None = None`), mirroring `log_exporter`.

**Message dict shape** (verified against `message.py` + a live publish): `{id, ts,
sender:{key,name,type}, recipients:[keys]|None, mentions:[keys]|None, body, conv,
reply_to, ...}`. The hook parser only consumes `conv`, `sender.name`,
`sender.key`, `body` (verified `hook_installer.py:89-91`), so the cue line maps
exactly those four; missing keys must degrade gracefully (`.get(..., "")`).

**Notification line shape the hook expects** (from the hook script's parser):
```json
{"conversation": "<conv>", "sender_name": "<name>", "sender_key": "<key>", "body": "<body>"}
```
The writer maps `conv→conversation`, `sender.name→sender_name`, `sender.key→sender_key`,
`body→body`.

**Who gets notified (delivery policy).** Mirror the documented "named users get a
notification cue" semantics, all derivable from the message itself:
- **whisper**: every key in `recipients` (the send path already drops the sender
  from `recipients`).
- **mention**: every key in `mentions`, excluding `sender.key` (no self-cue).
- **plain broadcast** (no recipients, no mentions): no cue by default.
- **system messages** (`sender.key == "00000000"`): never generate cues.
- De-dupe: a participant who is both whispered and mentioned in one message gets
  exactly one line.

**Optional broadcast mode.** Add config `notifications.cue_on_broadcast` (default
`false`). When `true`, plain broadcasts also notify all *other* conversation
members (resolved via `_registry.members(conv)`), enabling the agent-coordination
"see everything" mode. This is why the writer lives in the subscriber (registry
access), not the exporter.

**Proposed component.**
```python
# new: src/claude_comms/notifier.py
from collections.abc import Callable

class NotificationWriter:
    def __init__(self, notif_dir: Path, enabled: bool, cue_on_broadcast: bool,
                 registry_provider: Callable[[], "ParticipantRegistry | None"] | None = None):
        ...
    @classmethod
    def from_config(cls, config: dict, registry_provider=None) -> "NotificationWriter":
        notifs = config.get("notifications", {})
        return cls(
            notif_dir=_notification_dir(),           # imported from hook_installer
            enabled=notifs.get("hook_enabled", True),
            cue_on_broadcast=notifs.get("cue_on_broadcast", False),
            registry_provider=registry_provider,
        )
    def write(self, msg: dict) -> int:
        """Append a cue line to notifications/<key>.jsonl for each cued recipient.
        Returns the number of cue lines written. No-op if disabled.
        Resolves the registry lazily via registry_provider() (only needed for the
        broadcast-cue path; whisper/mention cues are derivable from msg alone)."""
```
Note `ParticipantRegistry` is defined in `mcp_tools.py` (verified `class
ParticipantRegistry` at line 127), not `participant.py` — import accordingly (or
keep it as a forward-ref string to avoid an import cycle, since `mcp_tools` is
heavy).
- `notif_dir`: REUSE `hook_installer._notification_dir()` (returns
  `Path.home()/".claude-comms"/"notifications"`, verified line 35-37) — import and
  call it rather than re-deriving the path, so the writer and the hook can never
  drift. (Promote it to a non-underscore public helper if a private import feels
  wrong; keep the body identical.)
- `enabled`: config is a plain **dict** (no attribute access — verified
  `config.py`). Read it as `config.get("notifications", {}).get("hook_enabled", True)`.
  `cue_on_broadcast` is `config.get("notifications", {}).get("cue_on_broadcast", False)`.
- Create the dir if missing (mkdir parents, exist_ok).
- Append one JSON line per cued key (newline-terminated). Open in append mode per
  write; keep it simple and crash-safe.
- **One `json.dumps()` per line (mandatory).** The hook parses the file with a
  per-line `json.load` (`hook_installer.py:88-91`), so each cue MUST be a single
  physical line. Use `json.dumps({...})` (which escapes embedded `\n`, tabs, and
  non-ASCII) — never f-string-interpolate the raw `body` into the line. A
  multi-line or quote-bearing body would otherwise split into multiple lines and
  corrupt the hook's JSON parse. The filename is `<key>.jsonl` where `<key>` is the
  recipient's 8-char lowercase-hex key (verified `generate_key` →
  `secrets.token_hex(4)` at `participant.py:71-77`, and `hook_installer` names the
  file `{participant_key}.jsonl` at line 62/118), so recipient/mention keys in the
  message dict match the cue filename exactly with no case-folding needed.

**Wiring.** Add `NotificationWriter.from_config(config, registry_provider=...)`
(mirroring `LogExporter.from_config(config)`, verified to exist at
`cli.py:1495`). In `cli.py` daemon startup (next to the LogExporter creation at
~1488-1517), build the notifier and pass it into the `_mqtt_subscriber(...)` call
at ~1509 as `notifier=...`. Inside the subscriber, call `notifier.write(data)` in
its OWN `try/except` in a SEPARATE block right after the `if log_exporter is not
None:` block (NOT nested inside it — see the sketch in "Where to write"), so it
fires regardless of whether logging is enabled and a notif failure never drops
logging. Also pass `notifier=` into the standalone launch site
(`mcp_server.py:2012`) for parity; there the registry provider is the bare module
global, so pass `registry_provider=lambda: _registry` (no `_mcp_mod` alias inside
the module itself).
- **Registry reference, lazily.** In `cli.py` the registry is `_mcp_mod._registry`
  (NOT a bare `_registry`), and the module global is reassigned during startup
  (`mcp_server.py:975`). Do NOT capture the registry object at construction time —
  pass a provider `registry_provider=lambda: _mcp_mod._registry` (the exact pattern
  the other consumers use, e.g. `cli.py:1403`) and resolve it lazily inside
  `write()`. This avoids a stale-registry capture and a `None` capture if the
  subscriber is built before the registry global is set.

**Edge cases / risks (address in tests):**
- **Visibility leak**: a whisper cue must ONLY be written to whisper recipients —
  never to non-recipients. Test that a non-recipient's notif file stays empty.
- **Self-cue**: sender never cues itself (recipients already excludes sender;
  mentions must filter `sender.key`).
- **Hook/writer race**: VERIFIED the unix hook reads then truncates with
  `CONTENT=$(cat "$NOTIF_FILE"); > "$NOTIF_FILE"` (`hook_installer.py:78-79`); the
  windows hook does the equivalent `Get-Content` + `Set-Content '' -NoNewline`
  (lines 138-140). A cue appended between the `cat`/`Get-Content` and the truncate
  is lost. Acceptable for v1 (cues are best-effort; full history is always in
  `comms_read`); note it, don't block on it.
- **File growth**: hook reads last 5 + count; unbounded file if hook never runs.
  Acceptable for v1; optionally cap lines (e.g., keep last 200) — defer unless review insists.
- **Replay on restart**: VERIFIED this is *already* covered by placement, as long
  as the notifier call sits after the dedup gate. On startup `replay_jsonl_logs`
  pre-registers every logged message id into the shared `_deduplicator`
  (`broker.py:283`). The live subscriber checks `_deduplicator.is_duplicate(msg_id)`
  at `mcp_server.py:701` and `continue`s on a hit BEFORE reaching
  `write_message`/the notifier (line 755). So MQTT redelivery of already-logged
  messages never reaches the notifier — no re-cue. The notifier MUST be called
  inside that same post-dedup block (it already will be, since it sits next to
  `write_message`); do NOT call it before the dedup check. Residual (acceptable for
  v1, note it): an MQTT-retained message that was delivered while the daemon was
  down but is NOT in any JSONL log would not be pre-registered and could cue once on
  reconnect — but normal `messages` topic publishes are non-retained
  (`tool_comms_send` → `publish_fn(msg.topic, ...)` with no `retain=True`, verified
  `mcp_tools.py:767`), so there is no retained message backlog to re-cue. No extra
  startup-cutoff logic needed.

**Tests (`tests/test_notifier.py` new + extend `test_notification_hook.py`):**
- whisper → cue files for each recipient only; non-recipients empty.
- mention → cue for mentioned non-sender; sender file empty.
- broadcast default → no cue files; with `cue_on_broadcast=true` → other members cued.
- system message → no cues.
- disabled config → no-op.
- line shape exactly matches what the hook parses; end-to-end: write a real
  message, run the real hook (as `test_notification_hook` does), assert it emits
  `additionalContext`.
- dedup/replay: a duplicate message id does not write a second cue.
- **No-exporter cue**: with `log_exporter=None` (standalone path), a whisper still
  produces a cue file (guards against re-nesting the notifier inside the log-exporter
  `if`).
- **Multi-line/non-ASCII body**: a body containing `\n`, quotes, and unicode yields
  exactly ONE physical line that the real hook's per-line `json.load` parses without
  error.
- **Behavioral**: re-run `tools/agent-harness/run.py three` and confirm at least
  one `hook_run` log event with `delivered=true`. (There is no aggregate
  `metrics.hook.delivered` field — the harness logs per-turn `hook_run` events with
  `delivered` (bool) + `context`, verified `cc_harness/agent.py:180-181`,
  `cc_harness/hooks.py:79`. Grep the run's events/JSONL for a delivered=true
  `hook_run`.)

## 5. F2 — Echo human names in comms_send results [HIGH]

**Problem.** `tool_comms_send` returns `recipients`/`mentions` as resolved 8-hex
KEYS (verified `mcp_tools.py:795-802`). An agent that whispered to "bob" gets back
`["c583254d"]` and can't confirm it targeted bob.

**Fix (additive, back-compat safe).** A `key_to_name` map is already built but ONLY
inside the whisper branch (`if resolved_recipients:` at line 744-746,
`key_to_name = {m.key: m.name for m in registry.members(conversation)}`). Hoist it
above the return so both keys-paths can reuse it (cheap: one
`registry.members(conversation)` call, verified to return `list[Participant]` with
`.key`/`.name` at `mcp_tools.py:272`). Note mentions are validated against the
GLOBAL registry (`resolve_for_mentions`), so a mentioned participant not in
`members(conversation)` resolves via the `.get(k, k)` key-fallback. Add two fields
to the return:
```python
return {
    "status": "sent", "id": msg.id, "conversation": conversation,
    "recipients": resolved_recipients,            # unchanged (keys) — 7 consumers depend on this
    "mentions": resolved_mentions,                # unchanged (keys)
    "recipient_names": [key_to_name.get(k, k) for k in resolved_recipients] if resolved_recipients else None,
    "mention_names":   [key_to_name.get(k, k) for k in resolved_mentions]   if resolved_mentions   else None,
    "reply_to": reply_to,
}
```
- DO NOT change the shape of `recipients`/`mentions` — verified 7 web/test
  consumers read them as key arrays (mqtt-store, App, MessageBubble, notifications,
  + 3 specs). Additive fields collide with nothing.
- Fallback to the key when a name can't be resolved.

**Tests:** extend `test_integration.py` / `test_gaps_mcp_tools.py`: whisper to a
named recipient returns `recipient_names` with the human name; mention returns
`mention_names`; unresolved → key fallback; existing key fields unchanged.

## 6. F3 — Status/presence: configurable TTL + reach peers [MEDIUM]

**Problem (nuanced — VERIFIED, be precise).** `tool_comms_status_set`
(`mcp_tools.py:1199`) DOES store an `Activity` on each
`Participant.connections[*].activity` (line 1261-1262), AND it DOES broadcast an
activity event to `claude-comms/conv/{conv}/activity` when `publish_fn` is provided
(lines 1268-1288) — and the daemon DOES pass `_publish_fn` to it
(`mcp_server.py:1300-1306`). So the FINDINGS/earlier-draft claim "never surfaced /
no push to peers" is **partly stale**: a push event already exists. The real,
verified issues are:
1. **TTL is hardcoded** `DEFAULT_ACTIVITY_TTL_SECONDS = 30`, cap
   `MAX_ACTIVITY_TTL_SECONDS = 300` — both defined in **`mcp_tools.py:1158-1159`**
   (NOT `presence.py`), not configurable. A 30s TTL expires mid-turn for 4-26s LLM
   turns, so by the time a peer reads `comms_members`, `activity` is often already
   swept to null (sweep in `presence.py:237-250`). This is timing, not a structural
   bug.
2. **Activity event is not consumed everywhere.** The event IS published, but the
   harness never subscribed to the `/activity` topic and `comms_members` polling is
   the only path the harness used — hence "activity: null" at end-of-run. No web
   `/activity` subscriber was found either (grep of `web/src` for the activity topic
   came up empty). So the gap is consumption/rendering, not publication.

**Fix.**
- Make default + cap configurable: add `presence.activity_ttl_seconds` (default
  120) and `presence.activity_ttl_max_seconds` (default 300) to `config.py`
  defaults. Config is a plain dict — access as
  `config.get("presence", {}).get("activity_ttl_seconds", 120)` (NO attribute
  access). Two mechanics must BOTH change, because the default and the clamp live
  in different places (VERIFIED):
  1. **Default substitution (in the wrapper).** The MCP wrapper `comms_status_set`
     (`mcp_server.py:1269`) declares `ttl_seconds ... = 30` as a literal default in
     its `Field` annotation (line 1285) — a bound default the LLM sees. To honor
     the configured default WITHOUT silently overriding an explicit caller value,
     change the wrapper's default to a sentinel (`ttl_seconds: ... = -1`, or `0`)
     and, inside the wrapper body before delegating, substitute the configured
     default when the caller left it at the sentinel:
     `if ttl_seconds < 1: ttl_seconds = config_activity_ttl_default`. Update the
     `Field` description text to say the configured default, not "Default 30".
  2. **Clamp ceiling (in the tool).** The `[1, MAX]` clamp lives INSIDE
     `tool_comms_status_set` at `mcp_tools.py:1242-1245` reading the MODULE constant
     `MAX_ACTIVITY_TTL_SECONDS`, NOT in the wrapper. Reading config in the wrapper
     therefore cannot move the ceiling. Add an optional `max_ttl_seconds: int =
     MAX_ACTIVITY_TTL_SECONDS` parameter to `tool_comms_status_set` (back-compat
     default = current constant) and clamp against it (`if ttl_seconds >
     max_ttl_seconds: ttl_seconds = max_ttl_seconds`); have the wrapper pass
     `max_ttl_seconds=config.get("presence", {}).get("activity_ttl_max_seconds",
     300)`. The wrapper must clamp the substituted default through the SAME ceiling
     (passing it to the tool achieves this). Keep `< 1 → 1` lower-bound behavior.
- Surface status: the publish path already exists; the lowest-risk, in-scope fix is
  (a) the configurable longer default so the existing `comms_members` read works
  within a turn, and (b) document the existing `/activity` event for consumers.
  Building a NEW notification/cue consumer for activity is OUT OF SCOPE (see §15) —
  do not add it under this finding.

**Tests (`test_status.py`, verified to exist):** TTL default honors config; clamp
at configured max; status set within TTL visible via `comms_members`; expiry clears
it. Do not assert on a brand-new consumer.

**Honesty note:** do not claim "activity always null" as a hard bug, and do not
claim "no push to peers" — an `/activity` broadcast already ships. Frame as "TTL
too short + not configurable + the event isn't consumed/rendered."

## 7. F4 — Stop doubling the whisper `[@name]` prefix [LOW]

**Problem.** For whispers (`recipients` non-empty), the server unconditionally
prepends `build_mention_prefix(mentioned_names)` to the body (verified
`mcp_tools.py:744-751`). When the agent ALSO types `[@bob] ...`, the delivered body
shows `[@bob] [@bob] ...`.

**Fix (idempotent prefix).** Before prepending, check whether `message` already
starts with a `[@...]` prefix using the existing parser in `mention.py`:
`MENTION_PATTERN.match(message)` (verified `mention.py:21-23`) detects a leading
`[@name, ...]` block, and `extract_mentions(message)` (line 29) returns the typed
names. Skip the server prepend ONLY when a leading prefix is present whose name set
equals the resolved recipient name set (case-insensitive compare of
`extract_mentions(message)` vs `mentioned_names`); otherwise prepend as today (so a
mismatched/partial agent prefix still gets the authoritative whisper marker —
prepending then yields the correct marker even if the body now carries the agent's
stray tag, which is strictly better than silently trusting a wrong prefix). Keep
behavior byte-identical when the agent did not type any prefix.
- Lower-risk alternative: leave the body alone and rely on the `recipients` wire
  field + client rendering for the whisper marker. Bigger blast radius (client
  rendering, log formatting, existing tests assert the prefix) — prefer the
  idempotent-prefix fix unless review shows the prefix is pure presentation.

**Tests:** whisper where agent typed no prefix → exactly one prefix (unchanged);
whisper where agent typed `[@bob]` → not doubled; multi-recipient prefix matched
correctly. Check `test_message_*` / mention tests for existing prefix assertions
and update them.

## 8. F5 — Don't echo self-authored system messages to the actor [LOW]

**Problem.** Artifact create/update/delete publish a broadcast `[system]` message
(`sender.key == "00000000"`, `recipients: None`) such as `[artifact] bob updated
'…' to v2`. With no self-exclusion, the actor (bob) receives a system echo of the
action he just performed and already announced.

**Scope (verified).** The artifact system messages are published at THREE sites:
create (`mcp_tools.py` ~1887), update (~1970), delete (~2130) — each system-msg
dict carries an `artifact_ref` key (verified `artifact_ref` at lines 1892/1975/2135).
Each builds a dict with `sender:{key:"00000000",name:"system",type:"system"}`,
`recipients:None`, and that `artifact_ref`. Add `actor_key` to all THREE (the tools
have `participant.key` in scope — verified used at line 1946). Do NOT touch the many
OTHER `00000000` system messages (join/leave/invite/etc. at lines
537/583/2198/2421/2546/2685) — they're out of scope for this finding; note that
reaction events ALREADY carry an `actor_key` field (lines 2952/2962), so the field
name is consistent with prior art.

**Fix.** Tag the artifact system message with `actor_key = participant.key` so
clients/agents can suppress self-echo without losing the broadcast for others.
Consumers skip a system message whose `actor_key` equals the reader's key. This
keeps visibility (still broadcast `recipients:None`) while removing self-echo noise.
- Do NOT make it a whisper-excluding-actor (that would hide it from everyone else).
  Keep broadcast + `actor_key` tag.
- Primary consumer = the harness/agent path. The drop MUST happen at the message
  INTAKE loop, NOT in `_fmt_messages`. VERIFIED `_fmt_messages(msgs)`
  (`runner.py:66`) takes only the message list and has NO reader key in scope, so
  it cannot filter by `actor_key == reader key`. The intake loop at
  `runner.py:157-166` DOES have `agent.key` in scope and already skips self-sends
  (`if m.get("sender", {}).get("key") == agent.key: continue`, line 164-165) — but
  artifact system messages have `sender.key == "00000000"`, not the actor's key, so
  they slip through. Add, right next to that skip (~line 164): `if
  m.get("actor_key") == agent.key: continue` to drop the reader's own artifact
  system echo. (Do NOT touch `_fmt_messages`.)
- Web UI needs NO change: it ALREADY self-suppresses artifact-update echoes via
  `markSelfUpdate`/`isOurRecentUpdate` (name+version match, verified
  `web/tests/edit-flow.spec.js:481-490`). `actor_key` is additive and ignored by
  the web; do not claim a web fix under this finding.

**Tests:** artifact update/create/delete system messages include `actor_key`; a
non-actor still receives it; (harness) actor does not re-receive its own system
echo. Add a test that the existing web self-suppress path is unaffected (the new
field is ignored).

## 9. F6 — Artifact result ergonomics (latest_version, author, conflict fields) [LOW]

**Problem (verified).** `comms_artifact_get` returns `version` = the requested (or
latest) version and `versions` (a list of metadata dicts, `mcp_tools.py:2039-2059`);
when a specific version is requested there's no explicit "latest" hint.
`comms_artifact_update` success returns only `{status,name,version}` (line 1980),
no author/base. The conflict path returns `_error(...)` = `{error:True, message}`
only (lines 1939-1944), with the current version embedded in the message STRING.

**Conflict-field naming — IMPORTANT (verified).** The HTTP POST edit-in-place
handler returns the MCP update result dict DIRECTLY as the 409 body
(`cli.py:585-588`: `if "conflict" in msg.lower(): return JSONResponse(result,
status_code=409)`). The web's conflict handler reads `body.latest_version` and
`body.latest_author` off that 409 (verified `ArtifactPanel.svelte:583-584`), but
those fields don't exist yet, so the remote-update banner currently always shows
"Someone" / v0. Therefore the conflict fields MUST be named **`latest_version`** and
**`latest_author`** (NOT `current_version`) so this addition also fixes the existing
web banner. Build the conflict return directly (NOT via `_error`, which only emits
`{error,message}`):
```python
return {
    "error": True,
    "message": (f"Version conflict: you based your edit on v{base_version}, "
                f"but current version is v{current_version}. "
                "Re-read the artifact and try again."),
    "latest_version": current_version,                  # web reads body.latest_version
    "latest_author": artifact.versions[-1].author.name, # web reads body.latest_author (STRING)
}
```
where the latest author is `artifact.versions[-1].author.name` — a **bare name
string, NOT a dict**. VERIFIED the web assigns `body.latest_author` directly into
a string-typed banner field: `remoteBannerSender = body.latest_author ?? 'Someone'`
(`ArtifactPanel.svelte:583`, `remoteBannerSender` is `$state('')` at line 228) and
renders it as `senderName={remoteBannerSender}` (line 757). Returning a
`{key,name,type}` dict would render `[object Object]` in the banner and defeat the
whole point of this fix. `ArtifactVersion.author` is a `Sender` (verified at update
path line 1946: `Sender(key=..., name=..., type=...)`), and at the conflict point
the new version has not been appended yet (append is at line 1955, after the
conflict check at 1939), so `versions[-1]` is the current latest version's author.
`latest_version` parallels `current_version` (the in-scope var at line 1938). The
web reads `latest_version` into a numeric field (`remoteBannerVersion`, line 584),
so keep it the integer `current_version`.

**Fix (additive).**
- `comms_artifact_get`: add `latest_version`. The returned `versions` is a list of
  DICTs, so compute from the source objects:
  `latest_version = max((v.version for v in artifact.versions), default=0)`
  (same pattern as the existing concurrency check at line 1938 — do NOT write
  `max(v.version for v in versions)` against the returned dict list).
- `comms_artifact_update` success: add `author` (the updater, `sender.model_dump()`
  — `sender` already built at line 1946) and `base_version` (echo what was accepted,
  may be null).
- conflict return: add `latest_version` + `latest_author` as above.

**Tests (`test_artifact.py`, verified to exist):** get returns `latest_version`;
update success includes author/base_version; conflict includes `latest_version`
(int) + `latest_author` (a NAME STRING — assert `isinstance(..., str)`, NOT a dict,
so the web banner renders a name not `[object Object]`). Verify the deterministic
probe (`probe_concurrency.py`) still
passes, and that `test_artifact_post_endpoint.py` / the web edit-flow specs that
read the 409 body are updated to the new fields.

## 10. F7 — Optional: guard blind (no base_version) overwrites [LOW/NIT]

**Context.** The probe verified: with `base_version` exactly one concurrent writer
wins (no clobber); without it, last-write-wins (all accepted). That is a
documented contract, not a bug — but blind overwrites are a footgun for agents.

**Fix (minimal, non-breaking).** When `comms_artifact_update` is called WITHOUT
`base_version`, include an advisory in the success return, e.g.
`"unguarded": true` (and document that passing `base_version` is recommended).
Do NOT reject blind updates by default (would break callers + the probe's
contrast case). A config `artifacts.require_base_version` (default false) MAY be
proposed to opt into strict mode — keep optional/deferred.

**Tests:** update without base_version → `unguarded: true`; with base_version →
absent/false. (Additive-safe: the probe only checks `res.get("status") ==
"updated"`, verified `probe_concurrency.py:41`, so a new `unguarded` key won't
break it.)

## 11. Coordination latency (resolved by F1 — note)

No separate code change. The high coordination latency was a consequence of (a) the
unwired push (F1) and (b) the harness's turn-based scheduling. After F1, re-run
`tools/agent-harness/run.py three` and record the new coordination latency; expect
it to drop once mid-turn cues are delivered. Document the harness-scheduling caveat
so the number isn't misread as a pure transport metric.

## 12. Consolidated config additions

All new keys are optional with back-compat defaults. Add them to the
`_DEFAULT_CONFIG` dict in `config.py` (verified plain-dict config merged via
`_deep_merge`, lines 21-100/134-146) — adding to defaults means existing user
configs auto-inherit them. Access in code is dict-style (`config.get(...)`),
NEVER attribute-style. Document in README/config sample:
- `notifications.cue_on_broadcast: false` — F1 optional broadcast cues. Add under
  the existing `notifications` block (which already has `hook_enabled`,
  `sound_enabled`, lines 76-81).
- `presence.activity_ttl_seconds: 120` — F3; was hardcoded 30. Add under the
  existing `presence` block (which has `connection_ttl_seconds`,
  `sweep_interval_seconds`, lines 82-89).
- `presence.activity_ttl_max_seconds: 300` — F3 cap, keep current ceiling.
- `artifacts.require_base_version: false` — F7 optional strict mode, NEW top-level
  block — **DEFERRED** (do not implement this round; listed only so the key name is
  reserved).

## 13. Testing strategy

- Unit tests per fix (see each section); follow existing patterns in the cited
  test files. No tautological tests — assert behavior, not implementation.
- The behavioral fixes (F1, F3, F5) are re-verified with the harness/probe:
  - F1: `run.py three` → at least one `hook_run` event with `delivered=true`
    (no aggregate `metrics.hook.delivered` field exists); whisper cue isolation.
  - F5: actor does not re-receive own system echo.
  - probe still PASSES after F6 return-shape changes.
- Run the full existing suites as the gate: `pytest` (3.10/3.11/3.12 in CI),
  `vitest`, Playwright e2e. F2/F4/F5 wire-shape changes must not break the 7 web
  consumers — run `vitest` + e2e.
- CI: these are normal unit/integration tests and DO go in CI. The agent harness
  itself stays out of CI (real $ / non-deterministic).

## 14. Rollout order & dependencies

1. F2 (isolated, additive, high value, low risk) — warm-up.
2. F6 + F7 (artifact returns, additive) — together; re-run probe.
3. F1 (notifier) — the big one; new module + subscriber wiring at BOTH launch
   sites (daemon `cli.py:~1509` is the gate; standalone `mcp_server.py:~2011` for
   parity) + tests; harness re-run.
4. F5 (system self-echo `actor_key`) — small, touches artifact publish + harness filter.
5. F4 (idempotent whisper prefix) — touches composer + existing prefix tests.
6. F3 (status TTL config) — config plumbing + status tests.
Each step: implement → unit tests → run suites → (behavioral) harness/probe → commit.

## 15. Out of scope / deferred

- A NEW consumer/renderer for the existing `/activity` status event (web
  subscriber, notification cue, etc.) — out of scope (F3). The event already
  publishes; building a consumer is a separate feature.
- `artifacts.require_base_version` strict mode (F7) — propose only.
- Notification file size capping / rotation (F1) — defer unless review insists.
- Any non-claude-comms / external-review work.

## 16. Adversarial review iteration log

- v1 (pre-review): initial plan drafted from FINDINGS.md + verified source fact
  sheet. Awaiting round 1.
- 2026-06-22 round 1 (single-agent both-lens): verified every cited API against
  source. Fixed: (F1) config dict access not attribute access; named BOTH
  `_mqtt_subscriber` launch sites (daemon `cli.py:1509` + standalone
  `mcp_server.py:2011`, latter passes no log_exporter today); registry must be
  passed as a lazy `registry_provider` (global reassigned at `mcp_server.py:975`,
  `cli.py` ref is `_mcp_mod._registry`); `from_config` classmethod added mirroring
  `LogExporter.from_config`; reuse `hook_installer._notification_dir()`; replay-cue
  concern downgraded — already covered by the pre-persistence dedup gate
  (`mcp_server.py:701` before `write_message` at 755), residual retained-msg case
  is non-issue (sends are non-retained, `mcp_tools.py:767`); corrected the
  nonexistent `metrics.hook.delivered` to the real per-turn `hook_run delivered`
  event. (F2) hoist `key_to_name` out of the whisper-only branch; cites tightened.
  (F3) MAJOR: `/activity` push event ALREADY ships (`mcp_tools.py:1268-1288`, wired
  `mcp_server.py:1300-1306`) — corrected the stale "no push to peers" claim; TTL
  constants are in `mcp_tools.py:1158-1159` not `presence.py`; config dict access;
  new consumer moved out of scope. (F4) tighten idempotency to name-set match using
  existing `MENTION_PATTERN`/`extract_mentions`. (F5) THREE artifact publish sites
  (create/update/delete) not one; web already self-suppresses via
  `markSelfUpdate`/`isOurRecentUpdate` so no web change; reaction events already use
  `actor_key` (prior art). (F6) MAJOR: conflict fields must be `latest_version` +
  `latest_author` (NOT `current_version`) to match what the web 409 banner already
  reads (`ArtifactPanel.svelte:583-584`, HTTP passthrough `cli.py:585-588`) — this
  additionally fixes a live web bug; fixed `latest_version` computation to use
  source objects not the returned dict list. (F7) confirmed additive-safe vs probe
  (`probe_concurrency.py:41`). §12 config block locations + dict-access rule.
  Remaining tally after edits: critical=0 high=0 medium=0 low=0 nit=0.
- 2026-06-22 round 2 (independent confirmation, single-agent both-lens): re-verified
  every round-1 claim against source (all held: `_mqtt_subscriber` def 642, dedup
  gate 701 before `write_message` 753-755, launch sites cli.py:1510 + mcp_server.py:2012,
  registry global reassigned 975-976, `registry_provider=lambda: _mcp_mod._registry`
  cli.py:1403, `ParticipantRegistry` mcp_tools.py:127, `_notification_dir` 35-37,
  send return 795-802, `key_to_name` whisper-only 745-746, TTL consts 1158-1159,
  `/activity` publish 1282, 3 artifact sites 1887/1970/2130 w/ `actor_key` reaction
  prior art 2952/2962, 409 passthrough cli.py:585-589, hook parser keys 88-91,
  `_error` 428-430, mention APIs 21/29/58, replay pre-register broker.py:283,
  non-retained send 767, config blocks 76-81/82-89). Fixed NEW issues round 1 missed:
  (F1, HIGH) notifier must sit in its OWN block AFTER the `if log_exporter is not
  None:` guard, not nested inside it — else standalone mode (and any None-exporter
  daemon) silently writes zero cues, re-creating the dead-push bug; rewrote "Where
  to write" + wiring with a sketch. (F6, HIGH) `latest_author` MUST be a bare name
  STRING not a `.model_dump()` dict — web assigns it straight into string-typed
  `remoteBannerSender` (`ArtifactPanel.svelte:583`, `$state('')` @228, rendered
  @757); a dict renders `[object Object]`; made the decision instead of leaving
  "prefer the dict / verify." (F3, MEDIUM) TTL config mechanism was underspecified —
  the clamp ceiling lives INSIDE `tool_comms_status_set` (mcp_tools.py:1242-1245)
  reading the module constant, and the wrapper default is a bound literal `= 30`
  (mcp_server.py:1285); reading config "in the wrapper" alone cannot move the
  ceiling or substitute the default. Specified sentinel-default substitution in the
  wrapper + a new `max_ttl_seconds` param on the tool. (F5, MEDIUM) filter location
  was wrong — `_fmt_messages` (runner.py:66) has no reader key; the drop belongs at
  the intake loop (runner.py:164, beside the existing self-send skip) where
  `agent.key` is in scope; system msgs carry `sender.key=="00000000"` so the
  existing skip misses them. (F1, LOW) added mandatory `json.dumps()`-per-line rule
  so multi-line/non-ASCII bodies don't corrupt the hook's per-line `json.load`;
  confirmed keys are lowercase 8-hex matching the `<key>.jsonl` filename. (F5, NIT)
  corrected do-not-touch system-msg line cites to 537/583/2198/2421/2546/2685.
  Remaining tally after edits: critical=0 high=0 medium=0 low=0 nit=0.
- 2026-06-22 round 3 (independent confirmation, single-agent both-lens): re-verified
  ALL FOUR of round 2's edits against source — each held: (F1) dedup gate
  `is_duplicate` at `mcp_server.py:701` `continue`s before `store.add`/`write_message`
  (753-759); the proposed notifier sits in its OWN block after the
  `if log_exporter is not None:` guard (753-759) and before the presence
  `_touch` block (760-766), all inside the post-dedup `parts[3]=="messages"` scope,
  so it IS reachable when `log_exporter is None` (standalone `mcp_server.py:2011`
  passes no exporter; daemon `cli.py:1509` passes `log_exporter=_log_exporter`
  kwarg). Hook drains via per-line shell `read -r` + `json.load`
  (`hook_installer.py:86-94`) so the `json.dumps()`-per-line rule is mandatory —
  confirmed. (F6) `remoteBannerSender` is `$state('')` (string) @228, assigned
  `body.latest_author ?? 'Someone'` @583, rendered `senderName={remoteBannerSender}`
  @757; `remoteBannerVersion` numeric @229/@584 — so `latest_author` MUST be the bare
  name string (`artifact.versions[-1].author.name`) and `latest_version` the int;
  append is at `mcp_tools.py:1955` AFTER the conflict check at 1939, so `versions[-1]`
  is the current latest, and since versions append sequentially `versions[-1].version
  == current_version` (= `max(v.version ...)`) — consistent. (F3) clamp lives INSIDE
  `tool_comms_status_set` (`mcp_tools.py:1242-1245`) reading module const
  `MAX_ACTIVITY_TTL_SECONDS`; wrapper default is bound literal `ttl_seconds ... = 30`
  (`mcp_server.py:1285`) — sentinel-default + new `max_ttl_seconds` tool param is the
  correct (and only) way config moves BOTH default and ceiling; wrapper substitution
  precedes the tool's `<1→1` lower clamp, no contradiction. (F5) `_fmt_messages`
  (`runner.py:66`) has no reader key; intake loop (`runner.py:152-166`) has
  `agent.key` and skips self-sends @164, but artifact system msgs carry
  `sender.key=="00000000"` (not actor key) so they pass — the `actor_key`-drop at
  intake is needed and correct. Cross-checked: mentions are NOT sender-key dedup'd
  in the send path (`mcp_tools.py:730-732` + docstring), so the F1 notifier's
  explicit `excluding sender.key` on the mention-cue path is load-bearing (a
  self-@mention would otherwise self-cue) — confirmed present in §4. F6 success
  `author` uses `sender.model_dump()` (dict, no existing consumer) while conflict
  `latest_author` is a string (web banner) — intentional, different consumers, not a
  contradiction; `Sender(BaseModel)` has `model_dump` (`message.py:44`). NO new
  critical/high/medium found; round 2's edits are sound. Remaining tally after edits:
  critical=0 high=0 medium=0 low=0 nit=0. CONVERGED.
- 2026-06-22 IMPLEMENTED by 2 parallel portion-owners (file-disjoint: Owner A
  mcp_tools.py+runner.py = F2/F3-tool/F4/F5/F6/F7; Owner B notifier.py+mcp_server.py
  +cli.py+config.py = F1/F3-wrapper). F3 cross-agent signature contract held.
  Gates green: full pytest 1267, vitest 1122, `probe_notify.py` PASS, `probe_concurrency.py`
  PASS 5/5; live 2-agent run hook.delivered 0→3. NEW during impl: **F8** — the
  generated hook step-5 crashed on newline/quote bodies and was a command-injection
  vector; fixed (`hook_installer._generate_unix_script` now passes bodies via env to
  one python pass) + regression test. Worklogs: `.worklogs/harness-fixes/impl-*.md`.
