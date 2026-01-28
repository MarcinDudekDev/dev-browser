---
name: dev-browser
description: Browser automation with persistent page state for navigating sites, filling forms, taking screenshots, and web testing.
domain: browser
type: plugin
frequency: daily
commands: [goto, click, fill, text, aria, upload, dismiss-consent, --screenshot, --inspect, --stealth, --user, --styles, --element, --annotate, --watch-design, --console-snapshot, --responsive, --resize, --baselines, --wplogin, --list, --scenarios, --debug, --crashes, --tabs, --cleanup]
tools: [~/Tools/dev-browser.sh]
---

# Dev Browser Skill (v1.4.0)

Browser automation that maintains page state across script executions. Multi-server architecture supports running dev, stealth, and user modes simultaneously.

## Table of Contents
- [Quick Start](#quick-start)
- [Browser Modes](#browser-modes)
- [CLI Commands](#full-usage)
- [TypeScript Scripts](#writing-scripts)
- [YAML Scenarios](#yaml-scenarios)
- [Wait Patterns](#waiting)
- [Multi-Server Modes](#multi-server-architecture)
- [Debugging](#debugging-tips)

## Quick Start

```bash
# Quick commands (preferred - no --run prefix needed)
dev-browser.sh goto https://example.com    # Navigate + inspect
dev-browser.sh click "Submit"              # Click by text/ref
dev-browser.sh fill email test@example.com # Fill form field
dev-browser.sh text e5                     # Get text from ref
dev-browser.sh aria                        # Get ARIA snapshot with refs

# Stealth mode (bypasses bot detection)
dev-browser.sh --stealth goto https://allegro.pl

# Screenshots (path is in OUTPUT - don't pass it!)
dev-browser.sh --screenshot main
dev-browser.sh --screenshot main myshot.png  # optional filename
```

## Browser Modes

| Mode | Flag | Port | Use Case |
|------|------|------|----------|
| dev | `--dev` (default) | 9222 | Normal testing |
| stealth | `--stealth` | 9224 | Anti-fingerprint (bypasses CAPTCHAs) |
| user | `--user` | 9226 | Your real browser session |

**Multi-server:** Each mode runs independently - start all three if needed!

```bash
# Server management
dev-browser.sh --server              # Start dev server
dev-browser.sh --stealth --server    # Start stealth server
dev-browser.sh --status              # Show all servers
dev-browser.sh --stop                # Stop current mode
dev-browser.sh --stop --all          # Stop all servers

# Brave/Chrome setup for --user mode
dev-browser.sh --setup-brave         # Shows setup instructions
```

## Global Flags

- `--dev` / `--stealth` / `--user` - Select browser mode
- `-p PAGE` / `--page PAGE` - Target page name (default: "main")
- `--cachebust` - Add cache-busting query param
- `-q` / `--quiet-console` - Suppress console error output

```bash
dev-browser.sh --stealth -p checkout goto https://shop.com
dev-browser.sh --cachebust goto https://example.com
```

**⚠️ DO NOT add `2>&1`** - dev-browser handles stdout/stderr correctly. Just run commands directly:
```bash
# Correct
dev-browser.sh goto https://example.com

# Wrong - unnecessary stderr redirect
dev-browser.sh goto https://example.com 2>&1
```

## Full Usage

```bash
# Quick commands
dev-browser.sh goto <url>            # Navigate + auto-inspect
dev-browser.sh click <text|ref>      # Click button/link
dev-browser.sh fill <field> <value>  # Fill input by name/ref/label
dev-browser.sh text <ref>            # Get element text
dev-browser.sh aria                  # ARIA snapshot with refs

# Scripts
dev-browser.sh --run myproject/login # Run custom script
dev-browser.sh --scenario wp-login   # Run YAML scenario
dev-browser.sh --chain "goto url|click Submit"

# Inspection
dev-browser.sh --screenshot main     # Take screenshot
dev-browser.sh --inspect main        # Forms + ARIA snapshot
dev-browser.sh --page-status main    # URL, title, state
dev-browser.sh --console main        # Watch console (Ctrl+C to stop)
dev-browser.sh --console-snapshot main  # Get existing console messages
dev-browser.sh --styles '.btn' main  # CSS cascade inspector for selector
dev-browser.sh --element '#submit'   # Full element inspection (attrs, xpath, box model, events)
dev-browser.sh --annotate main       # Screenshot with ref labels + bounding box coords
dev-browser.sh --watch-design main design.png 5  # Live design comparison (score updates on change)
dev-browser.sh --tabs                # List all open browser tabs

# Visual diff & responsive
dev-browser.sh --snap main           # Save baseline
dev-browser.sh --diff main           # Compare to baseline
dev-browser.sh --baselines           # List saved visual diff baselines
dev-browser.sh --responsive main     # Multi-viewport screenshots (mobile/tablet/desktop)
dev-browser.sh --resize 1280x720     # Resize viewport to specific dimensions

# Scripts & scenarios
dev-browser.sh --list                # List available user scripts
dev-browser.sh --scenarios           # List available YAML scenarios

# WordPress
dev-browser.sh --wplogin https://site.local/wp-admin/  # Auto-login to WordPress

# Diagnostics & cleanup
dev-browser.sh --debug               # Show diagnostic info
dev-browser.sh --crashes             # Show browser crash logs
dev-browser.sh --cleanup             # Cleanup stale resources
```

**Script template** (`~/Tools/dev-browser-scripts/myproject/test.ts`):
```typescript
// client and page are AUTO-INJECTED - do NOT add connect()/page() boilerplate!
// Default page is "main", override with: dev-browser.sh -p other --run script
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log(await page.title());
```

**⚠️ IMPORTANT:** `client` and `page` are automatically available. Do NOT add:
- ~~`const client = await connect();`~~
- ~~`const page = await client.page("main");`~~
- ~~`await client.disconnect();`~~

**⚠️ Use script files, NOT heredocs** - better debugging/reusability.

---

## CRITICAL: Recon Before Action

**NEVER guess selectors. NEVER start with screenshots.**

**Decision tree:**
1. **Source code available?** → Read code, use exact selectors
2. **After navigation?** → `goto` output has forms/buttons/links (auto-inspect)
3. **Need more links?** → `--run links` or `--run links all`
4. **Complex/dynamic page?** → `--inspect` or `getAISnapshot()` (full ARIA tree)
5. **Visual verification?** → `--screenshot main` (NOT for selectors)

| Method | Token Cost | Output | Use Case |
|--------|-----------|--------|----------|
| Source code | 0 | Exact selectors | Local/project sites |
| `goto` output | Low | Forms, inputs, buttons, iframes, links (15) | After navigation |
| `--run links` | Low | All links (50 or unlimited) | Navigation discovery |
| `--inspect` | Medium | Forms + ARIA snapshot refs | Detailed inspection |
| `getAISnapshot()` | Medium | Full ARIA tree | Complex pages |
| `--screenshot` | High | Visual only | Verification |

## Setup

The server auto-starts when you run any command. For manual control:

```bash
dev-browser.sh --server              # Start dev server (port 9222)
dev-browser.sh --stealth --server    # Start stealth server (port 9224)
dev-browser.sh --status              # Check all servers
```

### Multi-Server Architecture

Each mode runs on its own port with separate browser profile:

| Mode | HTTP Port | CDP Port | Profile |
|------|-----------|----------|---------|
| dev | 9222 | 9223 | profiles/dev |
| stealth | 9224 | 9225 | profiles/stealth |
| user | 9226 | 9222* | Your browser |

*User mode connects to your browser's debugging port.

### User Mode Setup (Brave/Chrome)

To use `--user` mode with your real browser:

```bash
# Option 1: Start browser with debugging
open -a 'Brave Browser' --args --remote-debugging-port=9222
# or
open -a 'Google Chrome' --args --remote-debugging-port=9222

# Then use
dev-browser.sh --user goto https://example.com
```

Run `dev-browser.sh --setup-brave` for detailed instructions.

### Server Flags

- `--headless` - No visible browser window

## How It Works

1. **Server** launches a persistent Chromium browser and manages named pages via REST API
2. **Client** connects to the HTTP server URL and requests pages by name
3. **Pages persist** - the server owns all page contexts, so they survive client disconnections
4. **State is preserved** - cookies, localStorage, DOM state all persist between runs

## Writing Scripts

Save to `~/Tools/dev-browser-scripts/{project}/script.ts`, run with `--run {project}/script`.

**Principles:**
- **Small scripts**: ONE action per script (navigate, click, fill, check)
- **Log state**: Always output state at end to decide next step
- **Use -p flag for page names**: `dev-browser.sh -p checkout --run script` instead of hardcoding
- **Plain JS in evaluate()**: No TypeScript syntax in browser context

```typescript
// Template - client and page are auto-injected!
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log({ title: await page.title(), url: page.url() });
```

Run with different pages: `dev-browser.sh -p checkout --run myscript`

**Important:**
- `tsx` transpiles but doesn't type-check - errors ignored
- `page.evaluate()` runs in browser - use plain JS only:
  ```typescript
  ✅ await page.evaluate(() => document.body.innerText);
  ❌ await page.evaluate(() => { const el: HTMLElement = document.body; });
  ```

## Workflow Loop

Follow this pattern for complex tasks:

1. **Write a script** to perform one action
2. **Run it** and observe the output
3. **Evaluate** - did it work? What's the current state?
4. **Decide** - is the task complete or do we need another script?
5. **Repeat** until task is done

## Client API

```typescript
// client and page are auto-injected. Additional API:
const page2 = await client.page("other"); // Get/create additional pages
const pages = await client.list(); // List all page names
await client.close("name"); // Close a page

// ARIA Snapshot methods for element discovery and interaction
const snapshot = await client.getAISnapshot("main"); // Get ARIA accessibility tree
const element = await client.selectSnapshotRef("main", "e5"); // Get element by ref

// Frame-aware helpers for embedded widgets (Stripe, PayPal, etc.)
const result = await client.findInFrames("main", "input[name='card']"); // Find in any frame
const formResult = await client.fillForm("main", { "Card Number": "4242..." }); // Smart form fill
```

The `page` object is a standard Playwright Page—use normal Playwright methods.

## Pattern Library

Reusable high-level helpers for common flows. Import from `patterns.ts`:

```typescript
import { login, fillAndSubmit, modal, responsive } from "./patterns";

// WordPress/form login
await login(page, {
  url: 'https://site.com/wp-login.php',
  user: 'admin',
  pass: 'password'
});

// Fill + submit (works cross-frame for Stripe/PayPal)
await fillAndSubmit(page, {
  fields: { 'email': 'user@test.com', 'message': 'Hello' },
  submit: 'button[type="submit"]',
  waitFor: '.success-message'
});

// Modal interaction
await modal(page, {
  open: '.open-settings',
  action: '.save-button'
});

// Multi-viewport screenshots
await responsive(page, {
  url: 'https://site.com',
  screenshots: '/tmp/responsive'
});
```

**See [`PATTERNS.md`](PATTERNS.md) for full API reference.**

## YAML Scenarios

Declarative browser automation flows. Define multi-step workflows in YAML, execute with `--scenario`.

**Quick example** (`scenarios/examples/wp-login.yaml`):
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

**Run:** `~/Tools/dev-browser.sh --scenario wp-login`

**Features:**
- Variable substitution with env fallbacks
- Pattern shortcuts (`login`, `fillForm`, `modal`, `responsive`)
- Assertions, conditionals, error handling
- Auto-compiles to TypeScript

**See [`scenarios/SCHEMA.md`](scenarios/SCHEMA.md) for complete schema reference.**

## Waiting

### ❌ Anti-Pattern: setTimeout/sleep

**NEVER use `setTimeout`** - flaky, slow, unpredictable. Use event-based waits below.

### ✅ Event-Based Waiting (Use These Instead)

The wrapper auto-imports these helpers. Use them for reliable, fast waits:

```typescript
// After navigation - wait for page to fully load
await waitForPageLoad(page);

// After click - wait for result element to appear
await button.click();
await waitForElement(page, '.success-message');

// After action - wait for loading spinner to disappear
await submitBtn.click();
await waitForElementGone(page, '.loading-spinner');

// After form submit - wait for URL change
await form.submit();
await waitForURL(page, '**/thank-you');

// After AJAX action - wait for network to settle
await saveBtn.click();
await waitForNetworkIdle(page);

// Wait for JS condition (animation, app state, etc.)
await waitForCondition(page, () => window.appReady === true);
await waitForCondition(page, () => !document.querySelector('.animating'));
```

### Available Wait Functions

| Function | Use When |
|----------|----------|
| `waitForPageLoad(page)` | After `goto()` - waits for document + network |
| `waitForElement(page, selector)` | Waiting for element to appear (modal, result) |
| `waitForElementGone(page, selector)` | Waiting for element to disappear (spinner, overlay) |
| `waitForURL(page, pattern)` | After navigation/form submit |
| `waitForNetworkIdle(page)` | After AJAX actions |
| `waitForCondition(page, fn)` | Custom JS condition (animations, app state) |

### When setTimeout is Acceptable

Only use `setTimeout` for:
1. **Intentional delays** (rate limiting, debounce testing)
2. **Animation observation** (watching visual effects, not waiting for them)
3. **Debugging** (temporary, remove before commit)

```typescript
// ✅ OK - Intentional delay for rate limiting
await new Promise(r => setTimeout(r, 100)); // Rate limit API calls

// ✅ OK - Temporary debugging
await new Promise(r => setTimeout(r, 5000)); // TODO: remove - just watching animation
```

## Inspecting Page State

### Screenshots

> **⛔ CRITICAL: Read OUTPUT for the saved path!**
> ```
> ❌ WRONG: --screenshot main && Read(...)   # Can't chain!
> ❌ WRONG: Read("screenshots/main.png")     # Don't guess!
> ✅ RIGHT: Run command, use path from OUTPUT
> ```

**Via CLI:**
```bash
~/Tools/dev-browser.sh --screenshot main
~/Tools/dev-browser.sh --screenshot main myshot.png  # optional filename
# Output: Screenshot saved: /Users/.../screenshots/myshot.png
#         USE THIS PATH from the output!
```

**Via script:**
```typescript
await page.screenshot({ filename: "screenshot.png" });
await page.screenshot({ filename: "full.png", fullPage: true });
```

### ARIA Snapshot (Element Discovery)

`getAISnapshot()` returns YAML-formatted accessibility tree with semantic roles, names, states, and stable `[ref=eN]` for interaction.

```typescript
const snapshot = await client.getAISnapshot("main");
console.log(snapshot);
```

**Example output:**
```yaml
- banner:
  - link "Hacker News" [ref=e1]
  - navigation:
    - link "new" [ref=e2]
    - link "submit" [ref=e3]
- main:
  - list:
    - listitem:
      - link "Article Title" [ref=e4]
      - link "328 comments" [ref=e5]
```

**Attributes:**
- `[ref=eN]` - Interaction handle | `[checked]` - Checked | `[disabled]` - Disabled | `[level=N]` - Heading level
- `/url:` - Link URL | `/placeholder:` - Input placeholder

**Interact with refs:**
```typescript
const element = await client.selectSnapshotRef("main", "e2");
await element.click();
```

## Working with Iframes (Stripe, PayPal, etc.)

Payment widgets use iframes invisible to normal selectors.

**`findInFrames(pageName, selector, options?)`** - Search all frames:
```typescript
const result = await client.findInFrames("main", 'input[name="cardnumber"]');
if (result.element) await result.element.fill("4242424242424242");
```
Options: `timeout` (5000ms), `includeMainFrame` (true)

**`fillForm(pageName, fields, options?)`** - Smart fill by label/name/placeholder across frames:
```typescript
const result = await client.fillForm("main", {
  "Card Number": "4242424242424242",
  "CVC": "123"
}, { submit: true });
console.log(result.filled, result.notFound, result.submitted);
```
Options: `timeout` (5000ms), `submit` (false), `clear` (true)

## Gotchas

### Tally Forms (UUID selectors)
Tally forms use **random UUID `name` attributes** that change every session. Never use `input[name="uuid-here"]` selectors — they'll break next time.

**Instead**, use label-based selection:
```bash
dev-browser.sh fill "Your website" "https://example.com"  # by label text
dev-browser.sh fill e5 "https://example.com"               # by ARIA ref (run 'aria' first)
```

### Cookie Consent Overlays
Google CMP/FC, CookieBot, and OneTrust overlays can block form interaction. Dismiss them:
```bash
dev-browser.sh dismiss-consent  # auto-detects and dismisses
```

### File Uploads
Use the `upload` command instead of writing custom scripts:
```bash
dev-browser.sh upload 'input[type=file]' /tmp/logo.png
dev-browser.sh upload e5 /tmp/photo.jpg   # by ARIA ref
dev-browser.sh upload file /tmp/doc.pdf    # by name attr
```
Automatically searches iframes (Tally, embedded forms).

## Debugging Tips

1. **Use getAISnapshot** to see what elements are available and their refs
2. **Take screenshots** when you need visual context
3. **Use waitForSelector** before interacting with dynamic content
4. **Check page.url()** to confirm navigation worked
5. **Use findInFrames** when selectors work in DevTools but not in scripts (likely in iframe)

## Error Recovery

If a script fails, the page state is preserved. You can:

1. Take a screenshot: `~/Tools/dev-browser.sh --screenshot main`
2. Check status: `~/Tools/dev-browser.sh --page-status main`
3. Inspect elements: `~/Tools/dev-browser.sh --inspect main`

Or write a debug script (`~/Tools/dev-browser-scripts/{project}/debug.ts`):
```typescript
// client and page auto-injected
await page.screenshot({ filename: "debug.png" });
console.log({
  url: page.url(),
  title: await page.title(),
  bodyText: await page.textContent("body").then((t) => t?.slice(0, 200)),
});
```
