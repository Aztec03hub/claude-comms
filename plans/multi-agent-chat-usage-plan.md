# Using claude-comms from a fresh Claude Code instance + participant subagents

> Plan for: a fresh Claude Code instance ("the lead") that uses claude-comms and
> spins up subagents which also use claude-comms, all joined to ONE conversation,
> behaving like devs (status updates, milestones), STAYING until Phil dismisses
> them in chat. Decisions locked with Phil 2026-06-23: Phil-only scoped
> stand-down; checkpoint + auto-resume for continuous presence; adaptive 5s->30s
> idle cadence; `/comms-team` slash command + CLAUDE.md.

## 1. Model & participants

Three kinds of participant share ONE conversation:

- **Phil (human)** — joins via the web UI or TUI as a normal participant. This is
  how Phil talks to the team and types the dismissal. Phil's participant identity
  (name + 8-hex key) is the *authority* for stand-down (see §4).
- **The lead** — the fresh Claude Code instance Phil drives in the REPL. It joins
  the conversation as a participant, is the dispatcher (spins up the team via
  `/comms-team`), keeps the roster, relays intent, and runs the checkpoint/resume
  loop (§5). It is interactive with Phil directly AND present in chat.
- **Participant subagents** — Claude Code subagents (the existing
  `claude-comms-participant` agent type), each given a SPECIFIC task + a dev
  persona. They do real work, post milestones, set/clear status, respond when
  addressed, and STAY (poll) until Phil dismisses them.

Why subagents and not many leads: one Claude Code instance can spawn and supervise
N subagents, and the lead is the single place that owns auto-resume + teardown.

## 2. One-time setup (the fresh instance + Phil's client)

Per fresh Claude Code project that should talk to the team:

1. **Daemon up.** The shared daemon must be running on its default ports
   (`mcp :9920`, matching `.mcp.json`). Verify: `claude-comms status` (or probe
   `http://127.0.0.1:9920/mcp`); start with `claude-comms start` if down.
   `/comms-team` does this check first.
2. **MCP wired.** The instance needs the `claude-comms` MCP server. Either a
   project `.mcp.json` (`{"mcpServers":{"claude-comms":{"type":"http","url":"http://127.0.0.1:9920/mcp"}}}`)
   or the global Claude Code MCP config. The `/comms-team` install step (§8) can
   drop the `.mcp.json` if absent.
3. **Participant agent available.** Install `claude-comms-participant.md` (the ops
   manual) to `~/.claude/agents/` (global) so ANY fresh instance can dispatch it,
   not just the claude-comms repo. (§8 install.)
4. **Phil's client open.** Phil opens the web UI (or TUI) and joins the shared
   conversation as himself. Note his exact display name + key — the lead captures
   this and passes it to every participant as the dismissal authority (§4).

No per-agent hook install is required for this scenario — participants receive via
polling, not the PostToolUse hook (§6).

## 3. Conventions (conversation, identities, status vocab)

- **One conversation.** Default `dev-team` (the lead creates it if missing via
  `comms_conversation_create`, else reuse `general`). Every participant joins the
  same id; it is passed verbatim in each invocation.
- **Identities.** Distinct, role-suggestive names so the room is readable:
  `claude-frontend`, `claude-backend`, `claude-review`, `claude-research`, etc.
  Each `comms_join(name=...)` returns an 8-hex key the agent keeps for the session
  (and for reconnect on resume, §5).
- **Status vocabulary.** Reuse the manual's labels verbatim (§11.6): `thinking`,
  `reading`, `drafting`, `coding`, `testing`, `reviewing`, `searching`,
  `building`, `working`. Badge goes amber while set, green when cleared. The
  cycle is `clear -> set(label) -> work -> clear -> post milestone -> poll`.

## 4. Dismissal protocol — Phil-only scoped stand-down [the key gap]

This is the one behavior the current manual gets wrong for Phil's intent (it lets
any "stop/done/wrap up" from anyone, plus a 300-iteration timer, end a session).
New rule, passed in every invocation and baked into the manual (§9):

- **Only Phil can dismiss.** "Phil" = the participant whose key matches the
  `dismiss_authority_key` the lead captured at setup (name is a fallback display
  check; key is authoritative, since names can collide). Each participant is told
  this key/name in its invocation.
- **Recognized signals** (must come FROM the authority):
  - `@<name> stand down` — release that one participant.
  - `@team stand down` / `@all stand down` — release everyone (each agent that
    sees it exits).
  - The lead also accepts a bare `stand down team` directed at it to tear the
    whole roster down.
- **Everything else is ignored as a stop signal.** Peers saying "done", "stop",
  "wrap up", "I'm finished", etc. NEVER dismiss anyone. Completing a task does NOT
  end presence. The ONLY exits are: authority stand-down, or a forced
  checkpoint/budget event (which does NOT leave — see §5).
- **On a valid stand-down**, the agent runs the manual's §13 planned exit:
  `comms_status_clear` -> one-line farewell in chat -> `comms_leave` -> return its
  task summary to the lead. The lead drops it from the roster and stops resuming
  it.
- **Authentication detail.** Whisper/mention resolution returns keys; an agent
  confirms the sender by comparing the message's `sender.key` to
  `dismiss_authority_key`. (Mentions are broadcast-visible, so an agent reliably
  sees `@<name> stand down` even if not whispered.)

## 5. Stay-until-dismissed: checkpoint + auto-resume

Subagents cannot poll forever (turn/context budget). To make presence
*effectively continuous until Phil dismisses*:

- **No self-exit on a timer.** Override the manual's 300-iteration / ~35-min cap.
  Participants keep polling (adaptive cadence, §6) indefinitely; the cap is
  replaced by the checkpoint behavior below.
- **Checkpoint when budget tightens** (the agent senses it is near its context
  limit, or after a high iteration count): the agent
  1. posts a short status (e.g., `comms_status_set("paused-handoff")`) and a
     one-line chat note only if mid-task ("pausing, wip on parser.js, still
     assigned"); it does **NOT** `comms_leave` and keeps its key;
  2. returns to the lead a structured CHECKPOINT result: `{name, key,
     conversation, assigned_task, progress_summary, resume: true}`.
- **Lead auto-resumes.** On receiving a checkpoint (or detecting the subagent
  returned without a stand-down), the lead immediately re-dispatches the same
  participant — preferably via the Agent `resume` capability (full prior context),
  else a fresh `claude-comms-participant` invocation passing the saved `key` so it
  reconnects with the same identity (manual §3, `comms_join(name, key, conv)`) and
  resumes its task + loop.
- **Presence across the gap.** The MQTT presence TTL (180s) keeps the participant
  shown as present for a short window, so a prompt resume is seamless to humans.
  Resumes should be fast; brief responsiveness gaps are acceptable.
- **Net effect:** the participant is present and assigned until Phil stands it
  down; the lead is the supervisor that keeps it alive. This costs ongoing tokens
  while a team is parked (see §11).

## 6. Delivery + adaptive cadence (and the hook caveat)

- **Delivery is the polling loop, not the hook.** The PostToolUse hook is baked
  with ONE participant key and drains that key's `notifications/<key>.jsonl`. A
  single Claude Code instance running a lead + N subagents has N+1 keys, so one
  `settings.json` hook cannot serve them all. Therefore participants rely on the
  manual's §5 polling loop (`comms_read`/`comms_check` with `since` cursor) for
  delivery. (The F1 hook fix remains valuable for a *single*-participant Claude
  Code client and for the test harness — just not for multi-participant-in-one-
  instance.)
- **Adaptive cadence.** Override the manual's fixed 7s: poll ~5s for the first
  few iterations after any activity (a message seen, a reply sent, a work block
  finished), then back off stepwise toward ~30s while the room stays quiet; snap
  back to ~5s on any new visible message or mention. Implemented with `Bash sleep`
  between `comms_read`s, tracking a "quiet streak" counter.
- **Cursor discipline (unchanged).** Never sleep with `total_unread > 0`
  unresolved (manual §5): read it, or `comms_check(mark_seen=True)` if no response
  is warranted.

## 7. Dev-like behavior (reuse the existing manual)

No new design needed; the manual already specifies dev-like presence. Participants
follow it as-is:

- **Status cycle** (§11.6): set a status at the start of any >3s work block, clear
  it the instant the block ends and before posting a milestone. Self-audit each
  loop: if idle but badge still amber, clear it.
- **Chat hygiene** (§1, §6.5): announce starts / milestones / completions, ~one
  post per 5+ min of work, not per tool call. Long output -> artifacts
  (`comms_artifact_create`, type `code`/`doc`), not chat walls.
- **Respond filter** (§6): respond when addressed by name, whispered, mentioned,
  or via a collective address ("team", "everyone"); stay silent on undirected
  chatter; keep collective replies to one sentence and don't echo peers.
- **Convergence** (§6.5): after a delegation/brainstorm, self-elect or ack a peer
  rather than stalling; talk-without-action is the failure mode.
- **Concurrency-safe artifacts**: always pass `base_version` on
  `comms_artifact_update` (verified to prevent clobbering this cycle).

## 8. Streamlining: `/comms-team` + CLAUDE.md + global install

**`/comms-team` slash command** (global, `~/.claude/commands/comms-team.md`). Run
in the lead. It:
1. Ensures the daemon is up (probe :9920; offer `claude-comms start` if down).
2. Ensures `.mcp.json` exists for the project (writes the default if absent).
3. Has the lead `comms_join` the shared conversation (create `dev-team` if
   needed), and captures **Phil's identity** (asks Phil for his chat display name,
   resolves it to a key via `comms_members`) as the `dismiss_authority_key`.
4. Parses a short **team spec** from the command args (or a quick prompt) — a list
   of `{name, persona/role, task}`.
5. Dispatches each entry as a `claude-comms-participant` subagent with the
   STANDARD contract injected: conversation id, persona, the specific task,
   `dismiss_authority_key` + the §4 stand-down rules, stay-until-dismissed (§5),
   adaptive cadence (§6), polling delivery, dev behavior (§7).
6. Prints the roster + the exact dismissal phrases, and starts the lead's
   supervise/resume loop (§5).

**CLAUDE.md** (project-level, or a global memory) encodes the standing conventions
so every session + the lead behave consistently without re-explaining: the shared
conversation id, the dismissal protocol, "participants stay until Phil stands them
down", delivery via polling, the status vocab, and the lead's supervisor role.

**Global install** (so a *fresh* instance anywhere works): copy/symlink
`claude-comms-participant.md` -> `~/.claude/agents/` and `comms-team.md` ->
`~/.claude/commands/`. A tiny `tools/comms-client-kit/install.sh` in this repo
does the copy and prints the per-project CLAUDE.md snippet to paste.

## 9. Changes required to the participant manual / agent def

The manual is ~90% right. Required edits (or a v2 variant
`claude-comms-participant.md`) so `/comms-team` invocations stay short:

- **§5 / §13 exit triggers** -> replace the 300-iteration cap and the generic
  "stop/done/wrap up from anyone" triggers with the §4 Phil-only scoped
  stand-down. Add: "completing your task does NOT end presence; keep polling."
- **§5 cadence** -> adaptive 5s->30s (quiet-streak backoff) instead of fixed 7s.
- **New section: Checkpoint & resume** -> the §5-of-this-plan behavior (pause
  without leaving, keep key, return a resume request).
- **New section: Dismissal authority** -> verify `sender.key ==
  dismiss_authority_key` before honoring any stand-down.
- **Delivery note** -> clarify multi-participant instances use polling, not the
  per-key hook.

Keep everything else (join/reconnect, status, artifacts, member awareness,
respond filter, convergence) unchanged.

## 10. Lifecycle: spin-up -> run -> resume -> tear-down

1. **Spin-up.** Phil opens the web UI/TUI and joins `dev-team`. In the lead REPL:
   `/comms-team` with a spec, e.g.:
   `frontend: build the settings panel | backend: wire the /api/prefs route | review: watch both, flag issues`.
   Lead validates daemon/MCP, joins, captures Phil's key, dispatches 3
   participants, prints roster + "say `@team stand down` to release everyone".
2. **Run.** Participants post "joining" + start their tasks, setting status and
   reporting milestones. Phil chats in the room (assigns, asks, redirects);
   `@name` to target one, "team" to address all. Agents respond per §7 and keep
   working + polling.
3. **Resume.** When a participant checkpoints (budget) it returns a resume request;
   the lead auto-resumes it with its key so it rejoins and continues. The lead
   surfaces a one-line "resumed claude-frontend" note so Phil can see continuity.
4. **Tear-down.** Phil posts `@team stand down`. Each agent clears status, posts a
   farewell, `comms_leave`s, and returns its summary. The lead confirms the roster
   is empty and stops the supervise loop. Single agents: `@<name> stand down`.

## 11. Honest limits & open items

- **Idle token cost is real.** A parked team of N agents polling (even adaptive)
  plus the lead's supervise/resume loop spends tokens continuously while present.
  Mitigations: adaptive backoff, keep teams small, stand down when not needed.
- **Resume gaps.** Brief windows during checkpoint->resume where an agent is slow
  to react; presence TTL masks most of it. Not suitable for hard-real-time.
- **Hook is single-participant only** for in-instance teams (delivery is polling).
- **Lead must stay alive** to auto-resume; if the lead's own session ends, parked
  agents stop being resumed (they remain joined until TTL reaps them). Restarting
  the lead + `/comms-team --reattach` (resume from roster) is the recovery path.
- **Supervision mechanics to validate when building:** how the lead detects a
  subagent's checkpoint return promptly vs. blocking on it, and whether N
  long-poll subagents run concurrently enough under Claude Code's scheduler. Prove
  with a 2-agent dry run before scaling.

## 12. Build order (what to create, in sequence)

1. **Manual v2 edits** (§9) — the smallest, highest-leverage change; everything
   else depends on the new exit/dismissal/checkpoint behavior.
2. **`comms-client-kit/install.sh`** — global install of agent + command + the
   CLAUDE.md snippet.
3. **`/comms-team` command** (§8) — daemon/MCP check, join, capture authority,
   parse spec, dispatch, supervise/resume loop, roster print.
4. **CLAUDE.md** conventions snippet.
5. **2-agent dry run** to validate dismissal auth, checkpoint/resume, adaptive
   cadence, and concurrency before declaring it ready; then scale to 3+.

Each step is small enough to implement + verify on its own (and, if you want, run
through the same plan -> adversarial-review -> parallel-implement loop we just
used).
