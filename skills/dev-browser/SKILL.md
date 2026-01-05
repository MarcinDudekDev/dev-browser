---
name: dev-browser
description: Browser automation with persistent page state for navigating sites, filling forms, taking screenshots, and web testing.
domain: browser
type: plugin
frequency: daily
commands: [--run, --snap, --screenshot, --inspect]
tools: [~/Tools/dev-browser.sh]
---

# Dev Browser Skill

Browser automation that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally.

## Getting Started

**ALWAYS use `~/Tools/dev-browser.sh` wrapper** - auto-imports helpers, prefixes page names, resizes screenshots, manages server.

### Installation

```bash
cd skills/dev-browser && ./install.sh
```

### Usage

```bash
# Built-in commands
~/Tools/dev-browser.sh --run goto https://example.com
~/Tools/dev-browser.sh --run click "Submit"
~/Tools/dev-browser.sh --screenshot main
~/Tools/dev-browser.sh --inspect main  # Show forms/elements

# Custom scripts: ~/Tools/dev-browser-scripts/{project}/script.ts
~/Tools/dev-browser.sh --run myproject/login

# YAML scenarios: Declarative flows
~/Tools/dev-browser.sh --scenario wp-login
~/Tools/dev-browser.sh --scenarios  # List available
```

Script template (`~/Tools/dev-browser-scripts/myproject/test.ts`):
```typescript
// connect, waitForPageLoad auto-imported
const client = await connect();
const page = await client.page("main");
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log(await page.title());
await client.disconnect();
```

**⚠️ Use script files, NOT heredocs** - better debugging/reusability.

---

## CRITICAL: Recon Before Action

**NEVER guess selectors. NEVER start with screenshots.**

**Decision tree:**
1. **Source code available?** → Read code, use exact selectors
2. **Forms/buttons/links?** → `--inspect main` (sufficient 80% of time)
3. **Complex/dynamic page?** → `getAISnapshot()` (full ARIA tree)
4. **Visual verification?** → `--screenshot main` (NOT for selectors)

| Method | Token Cost | Output | Use Case |
|--------|-----------|--------|----------|
| Source code | 0 | Exact selectors | Local/project sites |
| --inspect | Low | Forms, buttons, links + refs | Most interactions |
| --snapshot | Medium | Full ARIA tree | Complex pages |
| --screenshot | High | Visual only | Verification |

## Setup

First, start the dev-browser server using the startup script:

```bash
./skills/dev-browser/server.sh &
```

The script will automatically install dependencies and start the server. It will also install Chromium on first run if needed.

### Flags

The server script accepts the following flags:

- `--headless` - Start the browser in headless mode (no visible browser window). Use if the user asks for it.

**Wait for the `Ready` message before running scripts.** On first run, the server will:

- Install dependencies if needed
- Download and install Playwright Chromium browser
- Create the `tmp/` directory for scripts
- Create the `profiles/` directory for browser data persistence

The first run may take longer while dependencies are installed. Subsequent runs will start faster.

**Important:** Scripts must be run with `npx tsx` (not `npm run`) due to Playwright WebSocket compatibility.

The server starts a Chromium browser with a REST API for page management (default: `http://localhost:9222`).

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
- **Descriptive page names**: `"checkout"` not `"main"`, `"login"` not `"page1"`
- **Disconnect to exit**: `await client.disconnect()` at end
- **Plain JS in evaluate()**: No TypeScript syntax in browser context

```typescript
// Template
const client = await connect();
const page = await client.page("descriptive-name");
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log({ title: await page.title(), url: page.url() });
await client.disconnect();
```

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
const client = await connect();
const page = await client.page("name"); // Get or create named page
const pages = await client.list(); // List all page names
await client.close("name"); // Close a page
await client.disconnect(); // Disconnect (pages persist)

// ARIA Snapshot methods for element discovery and interaction
const snapshot = await client.getAISnapshot("name"); // Get ARIA accessibility tree
const element = await client.selectSnapshotRef("name", "e5"); // Get element by ref

// Frame-aware helpers for embedded widgets (Stripe, PayPal, etc.)
const result = await client.findInFrames("name", "input[name='card']"); // Find in any frame
const formResult = await client.fillForm("name", { "Card Number": "4242..." }); // Smart form fill
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

Take screenshots when you need to visually inspect the page:

```typescript
await page.screenshot({ path: "tmp/screenshot.png" });
await page.screenshot({ path: "tmp/full.png", fullPage: true });
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
const client = await connect();
const page = await client.page("main");
await page.screenshot({ path: "/tmp/debug.png" });
console.log({
  url: page.url(),
  title: await page.title(),
  bodyText: await page.textContent("body").then((t) => t?.slice(0, 200)),
});
await client.disconnect();
```
