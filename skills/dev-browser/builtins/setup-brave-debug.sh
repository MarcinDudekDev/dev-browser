#!/bin/bash
# Setup Brave browser for dev-browser --user mode
# This script helps configure Brave to accept remote debugging connections

BRAVE_APP="/Applications/Brave Browser.app"
BRAVE_BIN="$BRAVE_APP/Contents/MacOS/Brave Browser"
DEBUG_PORT=9222

echo "=== Brave Browser Debug Setup ==="
echo ""

# Check if Brave is installed
if [[ ! -d "$BRAVE_APP" ]]; then
    echo "Error: Brave Browser not found at $BRAVE_APP"
    exit 1
fi

# Check if Brave is already running
if pgrep -f "Brave Browser" > /dev/null; then
    RUNNING=true
    echo "Brave is currently running."

    # Check if it already has debugging enabled
    if lsof -i:$DEBUG_PORT -sTCP:LISTEN 2>/dev/null | grep -q "Brave"; then
        echo "✓ Brave is already running with remote debugging on port $DEBUG_PORT"
        echo ""
        echo "You can use: dev-browser.sh --user goto <url>"
        exit 0
    else
        echo "✗ Brave is running WITHOUT remote debugging enabled"
        echo ""
    fi
else
    RUNNING=false
    echo "Brave is not running."
    echo ""
fi

echo "To use dev-browser --user mode with Brave, you have two options:"
echo ""
echo "OPTION 1: Restart Brave with debugging (recommended)"
echo "----------------------------------------------"
if [[ "$RUNNING" == "true" ]]; then
    echo "1. Close all Brave windows (or run: pkill -f 'Brave Browser')"
    echo "2. Run this command to start Brave with debugging:"
else
    echo "Run this command to start Brave with debugging:"
fi
echo ""
echo "  open -a 'Brave Browser' --args --remote-debugging-port=$DEBUG_PORT"
echo ""
echo "Or add to ~/.zshrc for permanent debugging support:"
echo ""
echo '  alias brave="open -a '\''Brave Browser'\'' --args --remote-debugging-port=9222"'
echo ""

echo "OPTION 2: Create a debug profile (keeps sessions separate)"
echo "----------------------------------------------"
echo "This launches Brave with a separate profile for debugging."
echo "Your main session stays untouched, but you won't have your cookies/extensions."
echo ""
echo "  \"$BRAVE_BIN\" --remote-debugging-port=$DEBUG_PORT --user-data-dir=~/Library/Application\\ Support/BraveSoftware/Brave-Browser-Debug &"
echo ""

echo "After enabling debugging, verify with:"
echo "  curl -s http://localhost:$DEBUG_PORT/json/version"
echo ""
echo "Then use:"
echo "  dev-browser.sh --user goto https://example.com"
