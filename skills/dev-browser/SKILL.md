---
name: dev-browser
description: Browser automation with persistent page state for navigating sites, filling forms, taking screenshots, and web testing.
domain: browser
type: plugin
frequency: daily
commands: [goto, click, fill, text, aria, eval, scroll-to, select, upload, dismiss-consent, --screenshot, "--screenshot --selector", "--screenshot --scroll-to", --inspect, --stealth, --user, --styles, --element, --annotate, --watch-design, --console-snapshot, --responsive, --resize, --baselines, --wplogin, --list, --scenarios, --debug, --crashes, --tabs, --cleanup]
tools: [dev-browser.sh]
---

# Dev Browser (v1.5.0)

Browser automation with persistent page state. Run `dev-browser.sh --help` for the quick reference.

## Rules

1. **Screenshot path is in OUTPUT.** Run command, read the path, then Read() it. Never pass a path. Never chain with &&. Never guess.
2. **Never use sleep or setTimeout.** Use event-based waits in scripts.
3. **Never add 2>&1.** Stdout/stderr are handled correctly.
4. **Never declare client/page in scripts.** They are auto-injected.
5. **Recon first.** Never guess selectors. Use: goto -> aria -> --inspect -> screenshot.
6. **One command per Bash() call.** Do not chain with && or ;.
7. **If broken after 1 retry:** `msg tools "dev-browser issue: <description>"`

## Quick Start

```bash
dev-browser.sh goto https://example.com          # Navigate (outputs forms/buttons/links)
dev-browser.sh fill "log=admin pwd=secret"       # Fill multiple fields
dev-browser.sh fill "Medium=on Bacon=on"         # Check radio/checkbox by label
dev-browser.sh click "Submit"                    # Click by text/ref/selector
dev-browser.sh select country US                 # Select dropdown option
dev-browser.sh text e5                           # Get text from ref/selector
dev-browser.sh eval 'document.title'             # Evaluate JS in page
dev-browser.sh aria                              # ARIA snapshot with refs
dev-browser.sh --screenshot main                 # Full page screenshot
dev-browser.sh --inspect main                    # Forms + ARIA snapshot
```

## Commands

| Command | Description |
|---------|-------------|
| `goto <url>` | Navigate and inspect (forms, buttons, links) |
| `click <text\|ref\|selector>` | Click element (text match, ARIA ref, or CSS) |
| `fill "f1=v1 f2=v2"` | Fill form fields (auto-detects text/checkbox/radio/select) |
| `fill '{"f":"v"}'` | Fill with JSON (for values containing =) |
| `select <field> <value>` | Select dropdown option |
| `text <ref\|selector>` | Get element text content |
| `eval '<js>'` | Execute JavaScript in page |
| `aria` | ARIA accessibility tree with [ref=eN] |
| `scroll-to <selector>` | Scroll element into view |
| `upload <selector> <path>` | Upload file (searches iframes) |
| `dismiss-consent` | Close GDPR/cookie overlays |

## Inspection

```bash
dev-browser.sh --screenshot <page>                     # Full-page screenshot
dev-browser.sh --screenshot <page> --selector '.css'   # Element screenshot (clipped)
dev-browser.sh --screenshot <page> --scroll-to '.css'  # Scroll + viewport screenshot
dev-browser.sh --inspect <page>                        # Forms + ARIA snapshot with refs
dev-browser.sh --page-status <page>                    # URL/title + page messages
dev-browser.sh --console-snapshot <page>               # Console messages
dev-browser.sh --annotate <page>                       # Screenshot with ref labels + bounding boxes
dev-browser.sh --responsive <page>                     # 4 viewport screenshots + overflow check
dev-browser.sh --resize <WxH> [page]                   # Resize viewport
dev-browser.sh --styles <selector> [page]              # CSS cascade inspector
dev-browser.sh --element <ref|selector> [page]         # Full element inspection
```

## Modes & Server

| Mode | Flag | Port | Use Case |
|------|------|------|----------|
| dev | `--dev` (default) | 9220 | Normal testing |
| stealth | `--stealth` | 9224 | Anti-fingerprint (bypasses bot detection) |
| user | `--user` | 9226 | Your real browser session |

Mode persists across commands. First `--stealth` sets mode until `--dev` resets.

```bash
dev-browser.sh --server              # Start server for current mode
dev-browser.sh --stop [--all]        # Stop server(s) — REFUSES if other sessions have open pages
dev-browser.sh --stop --force        # Kill everything, including other sessions' tabs (last resort)
dev-browser.sh --status              # Show all server states
```

**The server is SHARED by all Claude sessions** — its browser holds other sessions' tabs.
- End of session / done with browser: `dev-browser.sh --cleanup --mine` (closes only YOUR pages). Never `--stop`.
- Server problems: just run `--server` — it detects zombies and restarts itself. `--stop --force` only if `--server` fails twice.

## Flags

| Flag | Description |
|------|-------------|
| `-p <page>` | Target page name (default: "main") |
| `--cachebust` | Add cache-busting query param |
| `-q` | Suppress console error output |
| `--force` | Force click on hidden elements |

## Scripts

```bash
dev-browser.sh --run <name>              # Run custom TypeScript script
dev-browser.sh --chain "cmd|cmd|cmd"     # Chain commands
dev-browser.sh --list                    # List available scripts
dev-browser.sh --scenario <name>         # Run YAML scenario
dev-browser.sh --scenarios               # List available scenarios
```

Auto-injected globals (no imports needed):
- `page`, `client` — Playwright page and client
- `resolveField(page, target)` — ARIA-first field resolution
- `smartFill(resolved, value)` — Auto-detects input type
- `waitForPageLoad`, `waitForElement`, `waitForElementGone`, `waitForCondition`, `waitForURL`, `waitForNetworkIdle`

Script template (`$DEV_BROWSER_HOME/scripts/myproject/test.ts`):
```typescript
// client and page are AUTO-INJECTED - do NOT add connect()/page() boilerplate!
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log(await page.title());
```

Rules: plain JS in `evaluate()`. Use `-p` flag for page names. Never use heredocs.

## Output Formats

| Command | Output |
|---------|--------|
| `goto` | `URL: <url>` / `Title: <title>` / `<pageState>` |
| `click` | `Clicked <type>: <target>` / `URL: ...` / `Title: ...` / `<pageState>` |
| `fill` | `Filled: f1, f2` / `<pageState>` — on error: `Not found: f` (stderr, exit 1) |
| `screenshot` | `Screenshot saved: /full/path/to/file.png` |
| `inspect` | Forms + ARIA refs (e1, e2, ... for use with click/text) |

`<pageState>` includes forms, buttons, links, iframes detected on page.

## Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `ECONNREFUSED` / `ECONNRESET` | Server down (auto-retries once) | `--server` (self-recovers; do NOT `--stop --all` — kills other sessions' tabs) |
| `Cannot redeclare client` | Script has connect()/page() boilerplate | Remove those lines — they're auto-injected |
| `Page 'X' not found` | No page by that name | Navigate first: `goto <url>` |
| `Field 'X' not found` | Wrong field name | Use `--inspect` or `aria` to find correct name |
| `browser-dead` | Chrome crashed | `--server` (auto-recovers the zombie). Last resort: `--stop --force` then `--server` |
| exit 141 with correct output | (historical) SIGPIPE from audit tee | Fixed — treat as success if output looks right |

## Examples

### WordPress Login
```bash
dev-browser.sh goto https://site.com/wp-login.php
# Output: Form #loginform: log[text], pwd[password], wp-submit[submit]
dev-browser.sh fill "log=admin pwd=secret123"
# Output: Filled: log, pwd
dev-browser.sh click "Log In"
# Output: URL: .../wp-admin/, Title: Dashboard
```

### Complete Form (text + radio + checkbox + dropdown)
```bash
dev-browser.sh goto https://site.com/checkout
dev-browser.sh fill "first_name=John last_name=Doe email=j@test.com Medium=on Bacon=on"
dev-browser.sh select country Poland
dev-browser.sh click "Place Order"
```

### Values Containing = (JSON mode)
```bash
dev-browser.sh fill '{"password":"P@ss=w0rd","comments":"token: abc=="}'
```

### Stealth Mode
```bash
dev-browser.sh --stealth goto https://protected-site.com
dev-browser.sh fill "email=test@example.com"
dev-browser.sh --screenshot main
```

### Screenshot Variants
```bash
dev-browser.sh --screenshot main                              # Full page
dev-browser.sh --screenshot main --selector '.hero'           # Element only
dev-browser.sh --screenshot main --scroll-to '.faq-section'   # Scroll + viewport
dev-browser.sh --screenshot main --scroll-to 3000             # Scroll to pixel offset
```

## Fill Resolution Order (ARIA-first)

`fill` uses `resolveField` which searches in this order:

1. **CSS passthrough** — target starts with `.`, `#`, `[` -> used as raw selector
2. **ARIA by role** — `getByRole(textbox|searchbox|spinbutton|combobox|checkbox|radio, { name: target })` — finds by accessible name
3. **Exact `[name="target"]`** — CSS attribute selector
4. **Exact `#target`** — CSS ID selector

`fill email test@x.com` finds by ARIA name first (matching labels like "Email Address"), then falls back to `name` attr, then `id`. No fuzzy matching.

Auto-detection per type: text inputs get `.fill()`, checkboxes/radios get `.check()`, selects get `.selectOption()`. Use `=off` to uncheck.

## Gotchas

### Tally Forms (UUID selectors)
Tally forms use random UUID `name` attributes that change every session. Never use `input[name="uuid"]` selectors.

Use label-based selection instead:
```bash
dev-browser.sh fill "Your website" "https://example.com"  # ARIA finds by label
dev-browser.sh fill e5 "https://example.com"               # by ARIA ref
```

### React / SPA Forms
React forms may not have standard `name` attributes. Use ARIA refs:
```bash
dev-browser.sh aria                    # Find refs
dev-browser.sh fill e3 "value"         # Fill by ref
```

### Cookie Consent Overlays
Overlays can block form interaction:
```bash
dev-browser.sh dismiss-consent  # Auto-detects and dismisses
```

### Iframe Widgets (Stripe, PayPal)
Payment widgets use iframes invisible to normal selectors. In scripts:
```typescript
const result = await client.findInFrames("main", 'input[name="cardnumber"]');
if (result.element) await result.element.fill("4242424242424242");
```

Or use `fillForm` for cross-frame smart fill:
```typescript
const result = await client.fillForm("main", {
  "Card Number": "4242424242424242",
  "CVC": "123"
}, { submit: true });
```

## Wait Patterns

**Never use `setTimeout` or `sleep`.** Use these event-based waits:

```typescript
await waitForPageLoad(page);                                    // After goto
await waitForElement(page, '.success-message');                 // Element appears
await waitForElementGone(page, '.loading-spinner');             // Element disappears
await waitForURL(page, '**/thank-you');                         // URL changes
await waitForNetworkIdle(page);                                 // AJAX settles
await waitForCondition(page, () => window.appReady === true);   // Custom JS condition
```

## Client API

```typescript
const page2 = await client.page("other");          // Get/create additional pages
const pages = await client.list();                   // List all page names
await client.close("name");                          // Close a page
const snapshot = await client.getAISnapshot("main"); // ARIA accessibility tree
const el = await client.selectSnapshotRef("main", "e5"); // Element by ref
const result = await client.findInFrames("main", selector); // Cross-frame search
const fill = await client.fillForm("main", fields);  // Cross-frame smart fill
```

## Diagnostics

```bash
dev-browser.sh --tabs                    # List all browser tabs
dev-browser.sh --cleanup --mine          # Close only THIS session's pages (use at end of session)
dev-browser.sh --cleanup [--all]         # Close orphaned tabs
dev-browser.sh --cleanup --project <n>   # Close specific project's pages
dev-browser.sh --debug                   # Show debug log
dev-browser.sh --crashes                 # Show crash logs
dev-browser.sh --wplogin <url>           # WordPress auto-login
dev-browser.sh --setup-brave             # User-mode setup instructions
```

## Recon Decision Tree

1. **Source code available?** -> Read code, use exact selectors
2. **After navigation?** -> `goto` output has forms/buttons/links (auto-inspect)
3. **Need more links?** -> `--run links` or `--run links all`
4. **Complex/dynamic page?** -> `--inspect` or `aria` (full ARIA tree)
5. **Visual verification?** -> `--screenshot main` (NOT for finding selectors)

## YAML Scenarios

Declarative multi-step workflows:
```yaml
name: wp-login
variables:
  WP_URL: ${WP_URL:-http://localhost:8080}
steps:
  - login:
      url: "{{WP_URL}}/wp-login.php"
      username: admin
      password: admin
  - screenshot: dashboard.png
```

Run: `dev-browser.sh --scenario wp-login`

See [`scenarios/SCHEMA.md`](scenarios/SCHEMA.md) for complete schema.
See [`PATTERNS.md`](PATTERNS.md) for reusable pattern library.
