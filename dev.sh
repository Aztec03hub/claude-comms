#!/bin/bash
# Start Claude Comms in dev mode — daemon + Vite hot-reload
claude-comms stop 2>/dev/null
claude-comms start &
sleep 2
cd "$(dirname "$0")/web" && npx vite --host
