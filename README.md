<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

> **Fork of [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser)** with additional conveniences for daily automation workflows.

A browser automation plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that lets Claude control your browser to test and verify your work as you develop.

## Fork Features

This fork adds:

- **Event-based wait helpers** - Replace fragile `setTimeout` with proper event waits
- **Built-in scripts** - Ready-to-use scripts for common tasks
- **Wrapper conveniences** - One-liner CLI commands
- **Auto-imports** - `connect`, `waitForPageLoad`, and wait helpers pre-imported
- **Project-prefixed pages** - Prevents page name collisions across projects

### CLI Commands

```bash
# Navigation & interaction
dev-browser.sh --run goto https://example.com    # Navigate to URL
dev-browser.sh --run click "Submit"              # Click by text
dev-browser.sh --run fill "email=test@test.com"  # Fill input field

# Screenshots & inspection
dev-browser.sh --screenshot [page] [path]        # Take screenshot (auto-resizes for Claude)
dev-browser.sh --inspect [page]                  # Show forms, inputs, buttons with refs
dev-browser.sh --page-status [page]              # Detect error/success messages

# Viewport & responsive
dev-browser.sh --resize 375 [page]               # Mobile viewport
dev-browser.sh --responsive [page]               # Screenshots at all breakpoints

# Visual diff
dev-browser.sh --snap [page]                     # Save baseline screenshot
dev-browser.sh --diff [page]                     # Compare current to baseline
dev-browser.sh --baselines                       # List saved baselines

# Server management
dev-browser.sh --status                          # List active pages
dev-browser.sh --server                          # Start server only
dev-browser.sh --stop                            # Stop server

# Debugging
dev-browser.sh --console [page] [timeout]        # Watch console output
dev-browser.sh --wplogin [url]                   # WordPress auto-login (admin/admin123)
dev-browser.sh --list                            # List all available scripts
```

### Built-in Scripts

| Script | Usage | Description |
|--------|-------|-------------|
| `goto` | `--run goto <url>` | Navigate to URL |
| `click` | `--run click "<text>"` | Click element by text/selector |
| `fill` | `--run fill "name=value"` | Fill form field |
| `screenshot` | `--run screenshot` | Take screenshot |
| `snap` | `--run snap` | Get ARIA accessibility snapshot |
| `fullpage` | `--run fullpage` | Full page screenshot |
| `eval` | `--run eval "<js>"` | Evaluate JS in page context |
| `hard-refresh` | `--run hard-refresh` | Hard refresh (clear cache) |

### Wait Functions (auto-imported)

```typescript
await waitForPageLoad(page);              // After goto() - waits for document + network
await waitForElement(page, '.modal');     // Wait for element to appear
await waitForElementGone(page, '.spinner'); // Wait for element to disappear
await waitForURL(page, '**/thank-you');   // Wait for URL change
await waitForNetworkIdle(page);           // Wait for AJAX to settle
await waitForCondition(page, () => window.appReady === true); // Custom condition
```

**Key features:**

- **Persistent pages** - Navigate once, interact across multiple scripts
- **Flexible execution** - Full scripts when possible, step-by-step when exploring
- **LLM-friendly DOM snapshots** - Structured page inspection optimized for AI

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [Node.js](https://nodejs.org) (v18 or later) with npm

## Installation

### Claude Code (from this fork)

Clone the skill to your skills directory:

```bash
SKILLS_DIR=~/.claude/skills
mkdir -p $SKILLS_DIR
git clone https://github.com/MarcinDudekDev/dev-browser /tmp/dev-browser-skill
cp -r /tmp/dev-browser-skill/skills/dev-browser $SKILLS_DIR/dev-browser
rm -rf /tmp/dev-browser-skill
cd $SKILLS_DIR/dev-browser && npm install
```

Restart Claude Code after installation.

### Amp / Codex

Copy the skill to your skills directory:

```bash
# For Amp: ~/.claude/skills | For Codex: ~/.codex/skills
SKILLS_DIR=~/.claude/skills  # or ~/.codex/skills

mkdir -p $SKILLS_DIR
git clone https://github.com/MarcinDudekDev/dev-browser /tmp/dev-browser-skill
cp -r /tmp/dev-browser-skill/skills/dev-browser $SKILLS_DIR/dev-browser
rm -rf /tmp/dev-browser-skill
```

**Amp only:** Start the server manually before use:

```bash
cd ~/.claude/skills/dev-browser && npm install && npm run start-server
```

## Permissions

To skip permission prompts, add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Skill(dev-browser:dev-browser)", "Bash(npx tsx:*)"]
  }
}
```

Or run with `claude --dangerously-skip-permissions` (skips all prompts).

## Usage

Just ask Claude to interact with your browser:

> "Open localhost:3000 and verify the signup flow works"

> "Go to the settings page and figure out why the save button isn't working"

## Benchmarks

| Method                  | Time    | Cost  | Turns | Success |
| ----------------------- | ------- | ----- | ----- | ------- |
| **Dev Browser**         | 3m 53s  | $0.88 | 29    | 100%    |
| Playwright MCP          | 4m 31s  | $1.45 | 51    | 100%    |
| Playwright Skill        | 8m 07s  | $1.45 | 38    | 67%     |
| Claude Chrome Extension | 12m 54s | $2.81 | 80    | 100%    |

_See [dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval) for methodology._

### How It's Different

| Approach                                                         | How It Works                                      | Tradeoff                                               |
| ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp)    | Observe-think-act loop with individual tool calls | Simple but slow; each action is a separate round-trip  |
| [Playwright Skill](https://github.com/lackeyjb/playwright-skill) | Full scripts that run end-to-end                  | Fast but fragile; scripts start fresh every time       |
| **Dev Browser**                                                  | Stateful server + agentic script execution        | Best of both: persistent state with flexible execution |

## License

MIT

## Authors

**Original:** [Sawyer Hood](https://github.com/sawyerhood)

**Fork:** [Marcin Dudek](https://github.com/MarcinDudekDev)
