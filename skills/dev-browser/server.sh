#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to the script directory
cd "$SCRIPT_DIR"

# Parse command line arguments
HEADLESS=false
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --headless) HEADLESS=true ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

# Only run install if node_modules is missing
if [[ ! -d node_modules ]]; then
    echo "Installing dependencies..."
    if command -v bun &>/dev/null; then
        bun install
    else
        npm install
    fi
fi

# Ensure node/homebrew is in PATH when launched via nohup (which strips PATH)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "Starting dev-browser server..."
export HEADLESS=$HEADLESS
export BROWSER_MODE=${BROWSER_MODE:-dev}
export HTTP_PORT=${HTTP_PORT:-9220}
export CDP_PORT=${CDP_PORT:-9221}
echo "Browser mode: $BROWSER_MODE (HTTP: $HTTP_PORT, CDP: $CDP_PORT)"

# Server must use tsx (not bun) — bun has Playwright CDP/WebSocket issues
# that cause SIGKILL during launchPersistentContext inside serve()
# Use local tsx (228ms) instead of npx tsx (638ms)
# exec: replace this shell so the PID file points at the real server —
# otherwise `kill <pidfile>` kills only this wrapper and orphans the node
# process, which keeps the port bound with a dead browser (zombie state)
if [[ -x ./node_modules/.bin/tsx ]]; then
    exec ./node_modules/.bin/tsx builtins/start-server.ts
else
    exec npx tsx builtins/start-server.ts
fi
