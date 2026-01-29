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

echo "Installing dependencies..."
npm install

echo "Starting dev-browser server..."
export HEADLESS=$HEADLESS
export BROWSER_MODE=${BROWSER_MODE:-dev}
export HTTP_PORT=${HTTP_PORT:-9222}
export CDP_PORT=${CDP_PORT:-9223}
echo "Browser mode: $BROWSER_MODE (HTTP: $HTTP_PORT, CDP: $CDP_PORT)"
npx tsx scripts/start-server.ts
