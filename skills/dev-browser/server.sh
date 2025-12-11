#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to the script directory
cd "$SCRIPT_DIR"

echo "Installing dependencies..."
bun i

echo "Starting dev-browser server..."
bun x tsx scripts/start-server.ts
