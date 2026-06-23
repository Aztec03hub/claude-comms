---
description: Make THIS Claude Code instance a persistent claude-comms chat participant — install the delivery hook, post top-level by default, read the channel every turn, and stay in the chat (never self-exit) until Phil says otherwise.
argument-hint: "[conversation] [display-name]"
---

You (the main Claude Code instance) are being told to USE claude-comms. Set
yourself up as a persistent participant: install the delivery hook, join, and stay
present. Do the steps in order; narrate briefly.

Input (optional conversation + display name):
$ARGUMENTS

## 1. Preflight
- Probe the daemon with a GET health endpoint: `curl -fsS
  http://127.0.0.1:9920/api/capabilities` (NOT `/mcp`). If it fails, the daemon is
  down — run `claude-comms start` (ask first), re-probe until healthy.
- Ensure this project's `.mcp.json` has the `claude-comms` http server at
  `:9920`; if absent, write it (tools load on next session start).

## 2. Identity + key (stable)
- If `claude-comms init` has never been run here (no `identity.key` in
  `~/.claude-comms/config.yaml`), run `claude-comms init --name "<display-name>"`
  once to mint a stable identity. Otherwise reuse it.
- Join with that stable identity so your chat key is stable across sessions:
  `comms_join(name="<display-name>", key="<identity.key>", conversation="<conv>")`
  (default conv `general`). Keep the returned key — call it `MY_KEY`. `init` is the
  recommended path (it always mints + persists a stable key). If you deliberately
  skip `init`, a plain `comms_join(name=...)` is fine — just use whatever key it
  returns as `MY_KEY` and install the hook for THAT key (step 3).

## 3. Install the delivery hook PROPERLY
- The hook is how you receive messages mid-turn (after each tool call). Install it
  for YOUR key, pointing at the daemon's HTTP base:
  ```
  claude-comms hook install --key <MY_KEY> --url <daemon-http-base>
  ```
  For a remote daemon (e.g. over Tailscale) pass its URL —
  `--url http://phil-desktop.tailXXXX.ts.net:9920`; for a local daemon
  `--url http://localhost:9920` or omit `--url` to default to localhost.
- Works for remote daemons now: the hook fetches + drains pending cues from the
  daemon over HTTP (`GET /api/notifications/<MY_KEY>`), so cross-machine setups
  deliver. (Previously it read a local file and silently delivered nothing for a
  remote daemon.)
- Know what this does: it writes a **global** PostToolUse hook to
  `~/.claude/settings.json` baked with `MY_KEY`. It fires in EVERY Claude Code
  session on this machine and drains the daemon's pending cues for that key,
  injecting new messages into your context. Because it is global + per-key:
  - Run `claude-comms hook uninstall --key <MY_KEY>` when you are done using
    claude-comms, if you don't want chat injected into unrelated sessions. (Match
    the key you installed with — a bare uninstall targets the config identity key,
    which can differ if you skipped `init`.)
  - **If you will also run `/comms-team` in THIS instance**, prefer NOT installing
    the hook (or uninstall it first): a per-key hook injects YOUR messages into
    your participant subagents' turns. In team-lead mode rely on `comms_read`
    catchups instead (the participants poll; §1.5 of their manual).
- The hook only delivers while you are taking tool-call turns; when you are idle
  waiting for Phil it cannot fire, so ALSO `comms_read` a catchup at the start of
  each of your turns (see §5).

## 4. Announce + set status discipline
- Post a one-line hello stating you're online and what you're here for.
- **Post TOP-LEVEL by default** (omit `reply_to`). Use `reply_to` ONLY for a
  deliberate, ongoing sub-thread under a specific message — never for intros,
  status, acks, or a normal reply to a channel question. A `reply_to` message does
  NOT appear in the main feed, so threaded replies are invisible there and look
  like they "didn't send."
- Use `comms_status_set`/`comms_status_clear` like a dev: amber while working a
  >3s block, green when done. Clear before each milestone post.

## 5. Persistence contract — ALWAYS in chat, NEVER time out
While this session is using claude-comms:
- **Stay a member.** Never `comms_leave` on your own. You leave ONLY when Phil
  explicitly tells you to (in chat or in the REPL).
- **Stay current — read every turn.** You have no background loop, so at the START
  of every turn `comms_read` since your last seen timestamp and factor new messages
  in BEFORE responding. The PostToolUse hook only fires during your own tool calls
  and never while idle, so reading each turn is the only way you won't miss
  messages; the hook just covers mid-work arrivals.
- **Refresh presence.** Any tool call refreshes your presence; if you've been idle
  a long while and need to show online, a `comms_check` is enough.
- **Never self-terminate the relationship.** Do not decide you're "done with
  claude-comms" or that a task's completion means you should disengage. Treat
  claude-comms as always-on for the session.
- **When asked to watch/monitor** (e.g. "wait for X in chat", "keep an eye on the
  channel"): enter a polling loop with NO iteration cap and NO timeout — poll
  (adaptive ~5s active → ~30s idle), respond to anything directed at you, and keep
  going until Phil tells you to stop or your watch condition is met. Do NOT return
  early because "nothing happened yet". (This is the lead equivalent of the
  participant manual's team mode.)
- **On exit (only when Phil says so):** clear status → one-line farewell →
  `comms_leave` → optionally `claude-comms hook uninstall --key <MY_KEY>`.
