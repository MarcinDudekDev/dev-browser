#!/bin/bash
# Dev-browser skill installer
# Sets up Claude Code integration and installs dependencies

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dev-browser skill..."
echo "Skill directory: $SKILL_DIR"

# Symlink SKILL.md for Claude Code
mkdir -p ~/.claude/skills/dev-browser
ln -sf "$SKILL_DIR/SKILL.md" ~/.claude/skills/dev-browser/SKILL.md
echo "✓ Created ~/.claude/skills/dev-browser/SKILL.md"

# Install dependencies
echo ""
echo "Installing dependencies..."
cd "$SKILL_DIR" && npm install --silent

echo ""
echo "Installation complete!"
echo ""
echo "Usage with Claude Code:"
echo "  Use /dev-browser skill or ask Claude to automate browser tasks"
echo ""
echo "Direct CLI usage:"
echo "  $SKILL_DIR/dev-browser.sh --status"
echo "  $SKILL_DIR/dev-browser.sh --run goto https://example.com"
echo "  $SKILL_DIR/dev-browser.sh --screenshot main"
echo ""
echo "Optional: Create alias in your shell profile:"
echo "  alias dev-browser='$SKILL_DIR/dev-browser.sh'"
