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

## Quick Start: Use the Wrapper

**ALWAYS use `wrapper.sh` (or symlinked `~/Tools/dev-browser.sh`) instead of raw npx commands.**

The wrapper provides:
- Auto-prefixes page names with project name (prevents collisions)
- Auto-imports `connect` and `waitForPageLoad`
- Auto-starts server if needed
- Auto-resizes screenshots for Claude (max 7500px)
- Console error capture
- Convenience commands for common tasks

### Installation (one-time)

```bash
# Create symlink to wrapper
ln -sf /path/to/skills/dev-browser/wrapper.sh ~/Tools/dev-browser.sh
```

### Basic Usage

**Step 1: Use built-in commands when possible**

```bash
~/Tools/dev-browser.sh --run goto https://example.com   # Navigate to URL
~/Tools/dev-browser.sh --run click "Submit"             # Click by text
~/Tools/dev-browser.sh --run fill "email" "a@b.com"     # Fill input field
~/Tools/dev-browser.sh --screenshot main                # Take screenshot
~/Tools/dev-browser.sh --status                         # List active pages
~/Tools/dev-browser.sh --inspect main                   # Show forms, elements
~/Tools/dev-browser.sh --resize 375                     # Mobile viewport
~/Tools/dev-browser.sh --responsive main                # All breakpoint screenshots
```

**Step 2: For custom logic, write script file then run**

```bash
# 1. Write script to ~/Tools/dev-browser-scripts/{project}/mytest.ts
# 2. Run it:
~/Tools/dev-browser.sh --run {project}/mytest
```

**IMPORTANT: Always use project subdirectories** to keep scripts organized:
- `~/Tools/dev-browser-scripts/matchify/login.ts`
- `~/Tools/dev-browser-scripts/brandkit/generate.ts`
- `~/Tools/dev-browser-scripts/mm/checkout.ts`

Use the current project name (from cwd or context) as the subdirectory.

Example script (`~/Tools/dev-browser-scripts/myproject/mytest.ts`):
```typescript
// connect() and waitForPageLoad() are auto-imported by wrapper
const client = await connect();
const page = await client.page("main");
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log(await page.title());
await client.disconnect();
```

**⚠️ DO NOT use heredocs (`<<'EOF'`)** - use script files instead for better debugging and reusability.

### Why Use the Wrapper?

| Without Wrapper | With Wrapper |
|-----------------|--------------|
| `cd /long/path && npx tsx script.ts` | `~/Tools/dev-browser.sh --run script` |
| Manual imports required | Auto-imports `connect`, `waitForPageLoad` |
| Page name collisions across projects | Auto-prefixed with project name |
| Screenshots may exceed Claude's limit | Auto-resized to 7500px max |
| Manual server management | Auto-starts if needed |

---

## CRITICAL: Recon Before Action

**NEVER guess selectors. NEVER start with screenshots for discovery.**

Before ANY interaction with a page, follow this workflow:

### Step 0: Check Source Code (if available)
If you have access to the source (localhost, project files), **read the code first** to write selectors directly. Skip browser inspection entirely.

### Step 1: --inspect (default first step)
```bash
~/Tools/dev-browser.sh --inspect main
```
Returns: URL, forms, inputs, buttons, links with `[ref=eN]` refs.
**Sufficient for 80% of tasks**: login forms, button clicks, navigation.

### Step 2: --snapshot (if --inspect insufficient)
```bash
# In script:
const snapshot = await client.getAISnapshot("main");
```
Returns: Full ARIA accessibility tree with all interactive elements.
**Use when**: Complex/dynamic pages, need elements not in forms.

### Step 3: --screenshot (visual confirmation ONLY)
```bash
~/Tools/dev-browser.sh --screenshot main
```
**NOT for finding selectors** - screenshots don't show CSS selectors or refs.
**Use for**: Verifying results, debugging layout, visual confirmation.

### Why This Order?
| Step | Token Cost | Output | Use Case |
|------|-----------|--------|----------|
| Source code | 0 (already loaded) | Exact selectors | Local/project sites |
| --inspect | Low (text) | Forms, buttons, links + refs | Most interactions |
| --snapshot | Medium (text) | Full ARIA tree | Complex pages |
| --screenshot | High (image) | Visual only | Verification |

**If you guess and fail, you wasted more tokens than inspecting first.**

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

**ALWAYS write scripts to `~/Tools/dev-browser-scripts/{project}/` then run with `--run`**

```bash
# 1. Create project subdirectory if needed
mkdir -p ~/Tools/dev-browser-scripts/myproject

# 2. Write your script
~/Tools/dev-browser-scripts/myproject/myscript.ts

# 3. Run it
~/Tools/dev-browser.sh --run myproject/myscript
```

The wrapper auto-imports `connect` and `waitForPageLoad`, so your scripts are simpler:

```typescript
// ~/Tools/dev-browser-scripts/myproject/myscript.ts
const client = await connect();
const page = await client.page("main");
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log(await page.title());
await client.disconnect();
```

> **Why script files instead of heredocs?**
> - Easier to debug (you can see exactly what ran)
> - Reusable across sessions
> - Proper syntax highlighting in editors
> - No escaping issues with quotes/variables

### Script Template

Save to `~/Tools/dev-browser-scripts/{project}/yourscript.ts`:

```typescript
// connect and waitForPageLoad are auto-imported by wrapper
const client = await connect();
const page = await client.page("main");
await page.setViewportSize({ width: 1280, height: 800 });

await page.goto("https://example.com");
await waitForPageLoad(page);

// Log state at the end
const title = await page.title();
const url = page.url();
console.log({ title, url });

await client.disconnect();
```

Run with: `~/Tools/dev-browser.sh --run {project}/yourscript`

### Key Principles

1. **Small scripts**: Each script should do ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Always log/return state at the end to decide next steps
3. **Use page names**: Use descriptive names like `"checkout"`, `"login"`, `"search-results"`
4. **Disconnect to exit**: Call `await client.disconnect()` at the end of your script so the process exits cleanly. Pages persist on the server.
5. **Plain JS in evaluate**: Always use plain JavaScript inside `page.evaluate()` callbacks—never TypeScript. The code runs in the browser which doesn't understand TS syntax.

### Important Notes

- **tsx runs without type-checking**: Scripts run with `npx tsx` which transpiles TypeScript but does NOT type-check. Type errors won't prevent execution—they're just ignored.
- **No TypeScript in browser context**: Code passed to `page.evaluate()`, `page.evaluateHandle()`, or similar methods runs in the browser. Use plain JavaScript only:

```typescript
// ✅ Correct: plain JavaScript in evaluate
const text = await page.evaluate(() => {
  return document.body.innerText;
});

// ❌ Wrong: TypeScript syntax in evaluate (will fail at runtime)
const text = await page.evaluate(() => {
  const el: HTMLElement = document.body; // TS syntax - don't do this!
  return el.innerText;
});
```

- Names that you give to pages should be descriptive and unique

❌ client.page("main")
✅ client.page("cnn-homepage")

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

## Waiting

### ❌ Anti-Pattern: setTimeout/sleep

**NEVER use `setTimeout` or sleep for waiting.** It's flaky, slow, and unpredictable:

```typescript
// ❌ BAD - Don't do this
await button.click();
await new Promise(r => setTimeout(r, 2000)); // Wastes 2s even if ready in 100ms
await page.screenshot({ path: '/tmp/result.png' });

// ❌ BAD - Also don't do this
await page.goto(url, { waitUntil: 'networkidle' });
await new Promise(r => setTimeout(r, 2000)); // Redundant! Already waited for networkidle
```

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

Use `getAISnapshot()` when you don't know the page layout and need to discover what elements are available. It returns a YAML-formatted accessibility tree with:

- **Semantic roles** (button, link, textbox, heading, etc.)
- **Accessible names** (what screen readers would announce)
- **Element states** (checked, disabled, expanded, etc.)
- **Stable refs** that persist across script executions

Script (`~/Tools/dev-browser-scripts/{project}/get-snapshot.ts`):
```typescript
const client = await connect();
const page = await client.page("main");
await page.goto("https://news.ycombinator.com");
await waitForPageLoad(page);
const snapshot = await client.getAISnapshot("main");
console.log(snapshot);
await client.disconnect();
```

Run: `~/Tools/dev-browser.sh --run {project}/get-snapshot`

#### Example Output

The snapshot is YAML-formatted with semantic structure:

```yaml
- banner:
  - link "Hacker News" [ref=e1]
  - navigation:
    - link "new" [ref=e2]
    - link "past" [ref=e3]
    - link "comments" [ref=e4]
    - link "ask" [ref=e5]
    - link "submit" [ref=e6]
  - link "login" [ref=e7]
- main:
  - list:
    - listitem:
      - link "Article Title Here" [ref=e8]
      - text: "528 points by username 3 hours ago"
      - link "328 comments" [ref=e9]
- contentinfo:
  - textbox [ref=e10]
    - /placeholder: "Search"
```

#### Interpreting the Snapshot

- **Roles** - Semantic element types: `button`, `link`, `textbox`, `heading`, `listitem`, etc.
- **Names** - Accessible text in quotes: `link "Click me"`, `button "Submit"`
- **`[ref=eN]`** - Element reference for interaction. Only assigned to visible, clickable elements
- **`[checked]`** - Checkbox/radio is checked
- **`[disabled]`** - Element is disabled
- **`[expanded]`** - Expandable element (details, accordion) is open
- **`[level=N]`** - Heading level (h1=1, h2=2, etc.)
- **`/url:`** - Link URL (shown as a property)
- **`/placeholder:`** - Input placeholder text

#### Interacting with Refs

Use `selectSnapshotRef()` to get a Playwright ElementHandle for any ref:

Script (`~/Tools/dev-browser-scripts/{project}/click-ref.ts`):
```typescript
const client = await connect();
const page = await client.page("main");
await page.goto("https://news.ycombinator.com");
await waitForPageLoad(page);

// Get snapshot to see refs
const snapshot = await client.getAISnapshot("main");
console.log(snapshot);
// Output shows: - link "new" [ref=e2]

// Click element by ref
const element = await client.selectSnapshotRef("main", "e2");
await element.click();
await waitForPageLoad(page);
console.log("Navigated to:", page.url());
await client.disconnect();
```

Run: `~/Tools/dev-browser.sh --run {project}/click-ref`

## Working with Iframes (Stripe, PayPal, etc.)

Payment forms and embedded widgets often use iframes that are invisible to normal selectors. Use `findInFrames()` and `fillForm()` to work with these.

### Finding Elements in Iframes

`findInFrames()` searches all frames (main + nested) for an element:

Script (`~/Tools/dev-browser-scripts/{project}/find-in-iframe.ts`):
```typescript
const client = await connect();
const page = await client.page("main");
await page.goto("https://example.com/checkout");
await waitForPageLoad(page);

// Find card input in Stripe iframe
const result = await client.findInFrames("main", 'input[name="cardnumber"]');
if (result.element) {
  console.log("Found in:", result.frameInfo);
  await result.element.fill("4242424242424242");
} else {
  console.log("Not found:", result.frameInfo);
}
await client.disconnect();
```

### Smart Form Filling

`fillForm()` finds fields by label, name, placeholder, or aria-label—across all frames:

Script (`~/Tools/dev-browser-scripts/{project}/fill-checkout.ts`):
```typescript
const client = await connect();
const page = await client.page("main");
await page.goto("https://example.com/checkout");
await waitForPageLoad(page);

const result = await client.fillForm("main", {
  "Card Number": "4242424242424242",
  "Expiration Date": "12/25",
  "CVC": "123",
  "Name on Card": "Test User"
}, { submit: true });

console.log("Filled:", result.filled);
console.log("Not found:", result.notFound);
console.log("Submitted:", result.submitted);
await client.disconnect();
```

### Options

**findInFrames options:**
- `timeout` - Max wait time in ms (default: 5000)
- `includeMainFrame` - Search main frame too (default: true)

**fillForm options:**
- `timeout` - Max wait per field in ms (default: 5000)
- `submit` - Click submit button after filling (default: false)
- `clear` - Clear fields before filling (default: true)

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
