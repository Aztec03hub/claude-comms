## claude-comms team conventions

This project can run a claude-comms dev team (chat participants that do real work).

- **Daemon:** the claude-comms daemon must be running (`claude-comms start`); the
  `claude-comms` MCP server is at `http://127.0.0.1:9920/mcp` (see `.mcp.json`).
- **Spin up a team:** run `/comms-team` with a conversation + roster
  (`name | persona | task` lines). It does the daemon/MCP preflight, joins as the
  lead, captures Phil's chat identity as the dismissal authority, dispatches
  `claude-comms-participant` subagents into one shared conversation, and
  supervises them (auto-resume on budget checkpoints).
- **Participants act like devs:** they set/clear a status on every work block
  (badge amber↔green), report starts/milestones/completions (not every tool
  call), put long output in artifacts, and respond when addressed, @mentioned,
  whispered, or addressed collectively ("team", "everyone").
- **They STAY until Phil dismisses them.** Only Phil (the captured authority key)
  can stand an agent down, by posting in chat: `@<name> stand down` (one) or
  `@team stand down` / `@all stand down` (everyone). Stop-words from anyone else,
  and an agent finishing its task, do NOT end its presence.
- **Lead role:** if you are the lead Claude Code instance, you are also a chat
  participant and the supervisor — keep the roster, relay Phil's intent, and
  resume any participant that returns a `resume: true` checkpoint (reconnect it
  with its saved key). You must stay alive for resumes to happen.
- **Delivery is polling** for a participant TEAM, not the per-key PostToolUse hook
  (one instance runs many participant keys). Cadence is adaptive (~5s active → ~30s
  idle).

### If THIS instance is told to use claude-comms (not spawning a team)

Run `/comms-join` (or follow it): install your delivery hook and become a
persistent participant.

- **Install the hook PROPERLY:** `claude-comms hook install --key <your join key>`.
  It is a GLOBAL `~/.claude/settings.json` PostToolUse hook baked with that key —
  it fires in every Claude Code session and injects new chat messages mid-turn.
  `claude-comms hook uninstall --key <same key>` removes it. The hook only fires
  during your tool-call turns, so ALSO `comms_read` a catchup at the start of each
  turn.
- **Do NOT install the hook if you will also run `/comms-team` here** — a per-key
  hook injects YOUR messages into your subagents' turns; rely on `comms_read`.
- **ALWAYS in chat, NEVER time out:** once told to use claude-comms, stay a member
  for the whole session. Never `comms_leave` on your own; never decide you're "done
  with claude-comms"; finishing a task does NOT mean disengage. When asked to
  watch/monitor the channel, poll with NO iteration cap and NO timeout until Phil
  says stop or the watch condition is met. Leave only when Phil explicitly says so
  (then clear status → farewell → `comms_leave` → optional `hook uninstall`).
