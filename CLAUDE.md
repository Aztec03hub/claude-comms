# Claude Comms — Development & Agent Guide

Claude Comms is an MQTT-backed multi-participant messaging system for AI agents and humans. It exposes an MCP server so Claude Code agents can join conversations, send/receive messages, create artifacts, and maintain persistent presence across sessions.

---

## Architecture in 60 seconds

- **Daemon**: Python service (FastAPI + MQTT broker). Single process, single origin. Start/stop via `dev.sh` or `docker-compose`.
- **MCP server**: mounted at `http://127.0.0.1:9920/mcp` by default. Tools listed in `src/claude_comms/mcp_tools.py`.
- **Participant registry**: in-memory dict of `name → {key, conversation_memberships, ...}`. Survives within a daemon run; clears on restart.
- **Web UI**: Svelte, built into `web/`. Served at `http://127.0.0.1:9920/`.
- **TUI**: Python textual, `claude-comms tui`.
- **CLI**: `claude-comms` entrypoint.

Key source files:
- `src/claude_comms/mcp_tools.py` — all MCP tool implementations
- `src/claude_comms/server.py` — FastAPI routes + MQTT broker
- `src/claude_comms/notification_hook.sh` — PostToolUse hook template
- `.claude/agents/claude-comms-participant.md` — stock participant agent
- `.claude/agents/claude-comms-facilitator.md` — stock facilitator agent (lead for structured sessions)

---

## Running locally

```bash
./dev.sh            # starts daemon in dev mode (hot-reload)
claude-comms tui    # TUI client (separate terminal)
```

MCP server URL for Claude Code: `http://127.0.0.1:9920/mcp`

**Updating a source install:** `claude-comms update` = git pull + web build (pnpm/npm) + reinstall-if-needed + restart daemon (background, web UI). One command replaces the manual pull/build/`pip install -e`/stop/start cycle; refuses on a PyPI/wheel install. (`claude-comms --update` is the same.)

---

## Key operational patterns (learned in production)

### Participant keys

Keys are 8 lowercase hex chars, server-assigned on first `comms_join(name=...)`. They persist as long as the daemon's in-memory registry is alive. On restart, agents rejoin with `comms_join(name=..., key=...)` to reclaim the same key.

**Phil's key is `36451798` and is assigned at the daemon level — it never changes** (reinstate via `restart.sh` which seeds the admin participant). This key is the dismiss authority for all Aletheia team-mode sessions.

### First join pattern (standard)

```python
comms_join(name="AgentName", conversation="general")   # no key — server assigns
# save returned key for all subsequent calls
```

Never hardcode keys in agent files. The server tells the agent its key on first join.

### Reconnect pattern (after daemon restart or resume)

```python
comms_join(name="AgentName", key="<saved_key>", conversation="general")
```

### Polling: `unread=True` is standard going forward

```python
comms_read(key=key, conversation="general", unread=True, count=50)
```

Uses the server's per-participant read cursor. No timestamp bookkeeping. All agents with unique names/keys should use this. The old `since=<last_seen_ts>` approach is a fallback for shared-key scenarios only.

### Orchestrator two-tier pattern (desktop-claude / interactive)

Background agents poll. Desktop-claude (interactive) uses a two-tier pattern:

1. **PostToolUse hook** (`~/.claude/hooks/claude-comms-notify-<key>.sh`) fires after every tool call, injects up to 5 unread messages as `additionalContext` with a 📬 prefix. This is a preview — it does NOT advance the read cursor.
2. **Manual `comms_read(unread=True)`** to consume and advance cursor. Call at the start of every turn, and whenever you see a 📬 preview.

Install hook with: `python -m claude_comms.setup_hook --key <your_key>` or manually from `src/claude_comms/notification_hook.sh` (replace `%%PARTICIPANT_KEY%%`).

### Hello message convention

In the first `comms_send` after joining, agents announce their key:
> `"Hey — [Name] here (key: abc123de). [First action]."`

This lets the orchestrator and Phil identify participants across restarts without relying on fragile name-matching.

### Name casing

The server stores exactly what you register. `Aria` ≠ `aria`. Join with the capitalization you want persisted. Title case is the convention for all Aletheia agents.

---

## Agent files

Two stock agents in `.claude/agents/`:

| Agent | Use when |
|-------|----------|
| `claude-comms-participant.md` | Generic worker or pure chat participant |
| `claude-comms-facilitator.md` | Lead for a structured multi-agent agenda session (manages agenda, names consensus, mediates disagreements, produces decision brief) |

**When to use facilitator vs participant:** Any session with a fixed agenda and specialist agents → facilitator. Freeform collaboration, single-agent workers → participant.

Aletheia-specific agents (Aria, Marcus, Zara, etc.) live in `~/.claude/agents/aletheia-*.md`. They embed the ops manual from the participant stock agent plus an Aletheia-specific persona. Aria's persona is effectively an instance of the facilitator pattern.

---

## Versioning

Version single source of truth: `pyproject.toml [project] version`.

Bump with:
```bash
python scripts/bump_version.py X.Y.Z   # bumps, commits, tags
git push && git push --tags            # triggers PyPI publish workflow
```

`claude-comms update` reinstalls the editable package whenever the post-pull `[project] version` differs from the installed `importlib.metadata` version (or `pyproject.toml` changed in the pull), which is what unsticks metadata pinned at an old version after a source update.

---

## Testing

```bash
pytest tests/                     # full suite
pytest tests/test_mcp_tools.py    # MCP tool unit tests
```

No live daemon required for unit tests. Integration tests spin up a test daemon.
