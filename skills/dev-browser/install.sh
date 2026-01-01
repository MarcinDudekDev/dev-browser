#!/bin/bash
# Dev-browser skill installer
# Creates symlinks for CLI access and Claude Code integration

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dev-browser skill..."
echo "Skill directory: $SKILL_DIR"

# Create ~/Tools if needed
mkdir -p ~/Tools

# Symlink CLI entry point
ln -sf "$SKILL_DIR/dev-browser.sh" ~/Tools/dev-browser.sh
echo "✓ Created ~/Tools/dev-browser.sh"

# Symlink SKILL.md for Claude Code
mkdir -p ~/.claude/skills/dev-browser
ln -sf "$SKILL_DIR/SKILL.md" ~/.claude/skills/dev-browser/SKILL.md
echo "✓ Created ~/.claude/skills/dev-browser/SKILL.md"

# Create user scripts directory
mkdir -p ~/Tools/dev-browser-scripts
echo "✓ Created ~/Tools/dev-browser-scripts/ (for personal scripts)"

# Install dependencies
echo ""
echo "Installing dependencies..."
cd "$SKILL_DIR" && npm install --silent

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  ~/Tools/dev-browser.sh --status     # Check server status"
echo "  ~/Tools/dev-browser.sh --run goto https://example.com"
echo "  ~/Tools/dev-browser.sh --screenshot main"
echo "  ~/Tools/dev-browser.sh --list       # List available scripts"
echo ""
echo "Put personal scripts in: ~/Tools/dev-browser-scripts/{project}/"
