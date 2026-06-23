#!/usr/bin/env bash
# Install the claude-comms client kit globally so ANY fresh Claude Code instance
# can run /comms-team and dispatch participant subagents.
#
#   - ~/.claude/agents/claude-comms-participant.md   (the participant ops manual)
#   - ~/.claude/commands/comms-team.md               (the /comms-team command)
#
# Then prints the CLAUDE.md conventions snippet to paste into a project (or your
# global ~/.claude/CLAUDE.md).
#
# Usage: bash tools/comms-client-kit/install.sh
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$KIT_DIR/../.." && pwd)"
AGENT_SRC="$REPO_ROOT/.claude/agents/claude-comms-participant.md"
COMMANDS="comms-team.md comms-join.md"
SNIPPET="$KIT_DIR/CLAUDE.snippet.md"

DEST_AGENTS="$HOME/.claude/agents"
DEST_CMDS="$HOME/.claude/commands"

[ -f "$AGENT_SRC" ] || { echo "missing $AGENT_SRC" >&2; exit 1; }
for c in $COMMANDS; do
  [ -f "$REPO_ROOT/.claude/commands/$c" ] || { echo "missing $REPO_ROOT/.claude/commands/$c" >&2; exit 1; }
done

mkdir -p "$DEST_AGENTS" "$DEST_CMDS"
cp "$AGENT_SRC" "$DEST_AGENTS/claude-comms-participant.md"
for c in $COMMANDS; do cp "$REPO_ROOT/.claude/commands/$c" "$DEST_CMDS/$c"; done

echo "installed:"
echo "  $DEST_AGENTS/claude-comms-participant.md"
for c in $COMMANDS; do echo "  $DEST_CMDS/$c"; done
echo
echo "next:"
echo "  1) start the daemon:  claude-comms start"
echo "  2) in any project, ensure .mcp.json points claude-comms at http://127.0.0.1:9920/mcp"
echo "  3) add the conventions below to that project's CLAUDE.md (or ~/.claude/CLAUDE.md):"
echo
echo "----- CLAUDE.md snippet -----"
cat "$SNIPPET"
echo "----- end snippet -----"
