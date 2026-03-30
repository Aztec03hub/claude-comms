#!/bin/bash
# Rebuild web UI and restart the daemon
cd "$(dirname "$0")/web" && npm run build && cd .. && claude-comms stop 2>/dev/null; claude-comms start --web
