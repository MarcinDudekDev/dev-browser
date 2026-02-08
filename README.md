<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

> **Extended fork of [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser)** — multi-browser modes, stealth automation, YAML scenarios, and 40+ CLI commands.

A browser automation plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that lets Claude control your browser to test and verify your work as you develop. This fork turns a basic browser tool into a full automation platform.

## Why This Fork?

| Feature | Upstream | This Fork |
|---------|----------|-----------|
| CLI commands | ~5 (natural language) | **40+ dedicated commands** |
| Browser modes | 1 (dev) | **3 (dev, stealth, user)** |
| Anti-fingerprint | No | **Stealth mode** — bypasses bot detection |
| Scenarios | No | **YAML declarative automation** |
| Pattern library | No | **login, fillAndSubmit, modal, responsive** |
| Tab management | No | **--tabs, --cleanup, per-project isolation** |
| Crash recovery | No | **Auto-retry on browser crash** |
| Design comparison | No | **--watch-design with live scoring** |
| CSS/element inspector | No | **--styles, --element, --annotate** |
| Script auto-injection | No | **client + page auto-injected** — zero boilerplate |
| WordPress helpers | No | **--wplogin, auto-detect wp-test domains** |
| Configurable paths | Hardcoded | **DEV_BROWSER_HOME env var** |
| Architecture | Monolith | **Lazy-loaded lib/ modules** |

## Quick Start

```bash
# Navigate and auto-inspect the page
dev-browser.sh goto https://example.com

# Stealth mode — bypass bot detection on protected sites
dev-browser.sh --stealth goto https://protected-site.com

# Run a YAML scenario
dev-browser.sh --scenario wp-login
```

## Browser Modes

Three independent browser servers, each with its own profile and port:

| Mode | Flag | Port | Use Case |
|------|------|------|----------|
| **dev** | `--dev` (default) | 9222 | Normal testing and development |
| **stealth** | `--stealth` | 9224 | Anti-fingerprint — bypasses CAPTCHAs and bot detection |
| **user** | `--user` | 9226 | Your real browser session with existing cookies/logins |

```bash
dev-browser.sh --server              # Start dev server
dev-browser.sh --stealth --server    # Start stealth server
dev-browser.sh --status              # Show all running servers
dev-browser.sh --stop --all          # Stop everything
```

## CLI Reference

### Navigation & Interaction

```bash
dev-browser.sh goto <url>                  # Navigate + auto-inspect
dev-browser.sh click <text|ref|selector>   # Click by text, ARIA ref, or CSS selector
dev-browser.sh fill <field> <value>        # Fill input by name/ref/label
dev-browser.sh select <field> <value>      # Select dropdown option
dev-browser.sh text <ref|selector>         # Get element text content
dev-browser.sh eval '<js expression>'      # Evaluate JS in page context
dev-browser.sh scroll-to '<selector>'      # Scroll element into view
dev-browser.sh aria                        # Get ARIA accessibility snapshot with refs
dev-browser.sh upload <selector> <file>    # Upload file to input
dev-browser.sh dismiss-consent             # Auto-dismiss cookie consent overlays
```

### Screenshots & Inspection

```bash
dev-browser.sh --screenshot main           # Take screenshot (auto-resized for LLMs)
dev-browser.sh --inspect main              # Forms + ARIA snapshot with refs
dev-browser.sh --styles '.btn' main        # CSS cascade inspector for selector
dev-browser.sh --element '#submit' main    # Full element inspection (attrs, box model, events)
dev-browser.sh --annotate main             # Screenshot with ref labels + bounding boxes
dev-browser.sh --responsive main           # Multi-viewport screenshots (mobile/tablet/desktop)
dev-browser.sh --resize 1280x720           # Resize viewport to specific dimensions
```

### Visual Diff & Design Comparison

```bash
dev-browser.sh --snap main                 # Save baseline screenshot
dev-browser.sh --diff main                 # Compare current to baseline
dev-browser.sh --baselines                 # List saved baselines
dev-browser.sh --watch-design main design.png 5  # Live design comparison with scoring
```

### Tab & Server Management

```bash
dev-browser.sh --tabs                      # List all open browser tabs
dev-browser.sh --cleanup                   # Close orphaned about:blank tabs
dev-browser.sh --cleanup --all             # Close all unregistered tabs
dev-browser.sh --cleanup --project myproj  # Close specific project's pages
dev-browser.sh --status                    # List active servers
dev-browser.sh --server                    # Start server only
dev-browser.sh --stop                      # Stop current mode's server
```

### Debugging

```bash
dev-browser.sh --console main              # Watch console output (Ctrl+C to stop)
dev-browser.sh --console-snapshot main     # Get existing console messages (no wait)
dev-browser.sh --page-status main          # URL, title, page state
dev-browser.sh --debug                     # Show diagnostic info
dev-browser.sh --crashes                   # Show browser crash logs
```

### WordPress

```bash
dev-browser.sh --wplogin https://site.local/wp-admin/  # Auto-login (admin/admin123)
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--dev` / `--stealth` / `--user` | Select browser mode |
| `-p PAGE` / `--page PAGE` | Target page name (default: "main") |
| `--cachebust` | Add cache-busting query param |
| `-q` / `--quiet-console` | Suppress console error output |

## YAML Scenarios

Declarative multi-step browser automation. Define flows in YAML, execute with `--scenario`.

```yaml
name: wp-login
variables:
  WP_URL: ${WP_URL:-http://localhost:8080}
  WP_USER: ${WP_USER:-admin}
  WP_PASS: ${WP_PASS:-admin}
steps:
  - login:
      url: "{{WP_URL}}/wp-login.php"
      username: "{{WP_USER}}"
      password: "{{WP_PASS}}"
  - screenshot: dashboard.png
```

```bash
dev-browser.sh --scenario wp-login         # Run scenario
dev-browser.sh --scenarios                 # List available scenarios
```

Features: variable substitution with env fallbacks, pattern shortcuts, assertions, conditionals, error handling.

**Full schema reference:** [`scenarios/SCHEMA.md`](skills/dev-browser/scenarios/SCHEMA.md)

## Pattern Library

Reusable high-level helpers for common automation flows:

```typescript
// WordPress/form login
await login(page, {
  url: 'https://site.com/wp-login.php',
  user: 'admin', pass: 'password'
});

// Fill + submit (works cross-frame for Stripe/PayPal)
await fillAndSubmit(page, {
  fields: { 'email': 'user@test.com', 'message': 'Hello' },
  submit: 'button[type="submit"]',
  waitFor: '.success-message'
});

// Modal interaction
await modal(page, { open: '.open-settings', action: '.save-button' });

// Multi-viewport responsive screenshots
await responsive(page, { url: 'https://site.com', screenshots: '/tmp/responsive' });
```

**Full API reference:** [`PATTERNS.md`](skills/dev-browser/PATTERNS.md)

## Wait Helpers

Auto-imported in every script — no boilerplate needed:

| Function | Use When |
|----------|----------|
| `waitForPageLoad(page)` | After `goto()` — waits for document + network idle |
| `waitForElement(page, selector)` | Waiting for element to appear (modal, result) |
| `waitForElementGone(page, selector)` | Waiting for element to disappear (spinner, overlay) |
| `waitForURL(page, pattern)` | After navigation or form submit |
| `waitForNetworkIdle(page)` | After AJAX actions |
| `waitForCondition(page, fn)` | Custom JS condition (animations, app state) |

## Configuration

Set `DEV_BROWSER_HOME` to customize where dev-browser stores profiles, scripts, and screenshots:

```bash
export DEV_BROWSER_HOME=~/.dev-browser  # default: skill installation directory
```

## Installation

### Claude Code (from this fork)

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

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [Node.js](https://nodejs.org) (v18 or later) with npm

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
