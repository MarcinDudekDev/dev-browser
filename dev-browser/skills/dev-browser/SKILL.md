---
name: dev-browser
description: Browser automation with persistent page state. Use when testing websites, debugging web apps, taking screenshots, filling forms, or automating browser interactions.
---

# Dev Browser Skill

A browser automation skill that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally.

## Setup

First, install dependencies and start the dev-browser server:

You should make sure to run it in the background

```bash
cd dev-browser && bun run start-server &
```

**Important:** Scripts must be run with `bun x tsx` (not `bun run`) due to Playwright WebSocket compatibility:

The server starts a Chromium browser with a REST API for page management (default: `http://localhost:9222`).

## How It Works

1. **Server** launches a persistent Chromium browser and manages named pages via REST API
2. **Client** connects to the HTTP server URL and requests pages by name
3. **Pages persist** - the server owns all page contexts, so they survive client disconnections
4. **State is preserved** - cookies, localStorage, DOM state all persist between runs

## Writing Scripts

Write scripts to `tmp/` with unique names (e.g., `navigate-login.ts`, `fill-form.ts`) and run them with `bun x tsx tmp/<script-name>.ts`.

The `tmp/` directory is created automatically when you start the server.

### Basic Template

Always use the package name `dev-browser/client`.

```typescript
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("main"); // get or create a named page

// Your automation code here
await page.goto("https://example.com");

// Always evaluate state at the end
const title = await page.title();
const url = page.url();
console.log({ title, url });

// Disconnect so the script exits (page stays alive on the server)
await client.disconnect();
```

### Key Principles

1. **Small scripts**: Each script should do ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Always log/return state at the end to decide next steps
3. **Use page names**: Use descriptive names like `"checkout"`, `"login"`, `"search-results"`
4. **Disconnect to exit**: Call `await client.disconnect()` at the end of your script so the process exits cleanly. Pages persist on the server.

## Workflow Loop

Follow this pattern for complex tasks:

1. **Write a script** to perform one action
2. **Run it** and observe the output
3. **Evaluate** - did it work? What's the current state?
4. **Decide** - is the task complete or do we need another script?
5. **Repeat** until task is done

### Example: Login Flow

**Step 1: Navigate to login page**

```typescript
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("auth");

await page.goto("https://example.com/login");

// Check state
const hasLoginForm = (await page.$("form#login")) !== null;
console.log({ url: page.url(), hasLoginForm });

await client.disconnect();
```

**Step 2: Fill credentials** (after confirming login form exists)

```typescript
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("auth");

await page.fill('input[name="email"]', "user@example.com");
await page.fill('input[name="password"]', "password123");
await page.click('button[type="submit"]');

// Wait for navigation and check state
await page.waitForLoadState("load");
await page.waitForTimeout(500); // Allow dynamic content to finish loading
const url = page.url();
const isLoggedIn = url.includes("/dashboard");
console.log({ url, isLoggedIn });

await client.disconnect();
```

**Step 3: Verify success** (if needed)

```typescript
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("auth");

const welcomeText = await page.textContent("h1");
const userMenu = (await page.$(".user-menu")) !== null;
console.log({ welcomeText, userMenu, success: userMenu });

await client.disconnect();
```

## Common Operations

### Navigation

```typescript
await page.goto("https://example.com");
await page.goBack();
await page.reload();
```

### Clicking

```typescript
await page.click("button.submit");
await page.click('a:has-text("Sign Up")');
await page.click("nav >> text=Products");
```

### Form Filling

```typescript
await page.fill('input[name="email"]', "test@example.com");
await page.selectOption("select#country", "US");
await page.check('input[type="checkbox"]');
```

### Waiting

```typescript
await page.waitForSelector(".results");
await page.waitForLoadState("load");
await page.waitForTimeout(500); // Allow dynamic content to finish loading
await page.waitForURL("**/success");
await page.waitForTimeout(1000); // avoid if possible
```

### Extracting Data

```typescript
const text = await page.textContent(".message");
const html = await page.innerHTML(".container");
const value = await page.inputValue("input#search");
const items = await page.$$eval(".item", (els) => els.map((e) => e.textContent));
```

### Evaluating JavaScript

```typescript
const result = await page.evaluate(() => {
  return document.querySelectorAll(".item").length;
});
```

## Managing Pages

```typescript
// List all pages managed by the server
const pages = await client.list();
console.log(pages); // ["main", "auth", "checkout"]

// Close a specific page when done
await client.close("checkout");
```

## Inspecting Page State

### Screenshots

Take screenshots when you need to visually inspect the page:

```typescript
await page.screenshot({ path: "tmp/screenshot.png" });
await page.screenshot({ path: "tmp/full.png", fullPage: true });
```

### LLM Tree (Structured DOM Inspection)

For a more structured, text-based view of the page, use `getLLMTree()`. This returns a human-readable representation of interactive elements on the page, making it easier to understand page structure without parsing raw HTML.

```typescript
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

await page.goto("https://news.ycombinator.com");

// Get the LLM-friendly DOM tree
const tree = await client.getLLMTree("main");
console.log(tree);

await client.disconnect();
```

#### Example Output

The tree output shows interactive elements with numbered indices:

```
[1]<a href="https://news.ycombinator.com" />
[2]<a href="news">Hacker News</a>
[3]<a href="newest">new</a>
[4]<a href="front">past</a>
[5]<a href="newcomments">comments</a>
[6]<a href="ask">ask</a>
[7]<a href="submit">submit</a>
[8]<a href="login?goto=news">login</a>
1.
[9]<a id="up_46134443" href="vote?id=46134443&how=up&goto=news" />
[10]<div class="votearrow" title="upvote" />
[11]<a href="https://www.example.com/article">Article Title Here</a>
528 points
by
[12]<a class="hnuser" href="user?id=username">username</a>
[13]<a href="item?id=46134443">3 hours ago</a>
[14]<a href="item?id=46134443">328 comments</a>
...
[256]<input type="text" name="q" autocomplete="off" />
```

#### Interpreting the Tree

- **`[N]`** - Interactive elements are numbered. Use these indices with `getSelectorForID()` to get CSS selectors
- **`<tag attr="value">text</tag>`** - Element tag, key attributes, and text content
- **Plain text** - Static text content between elements (e.g., "528 points", "by")
- **`|SCROLL|`** - Marks scrollable containers with scroll position info
- **`|IFRAME|`** - Marks iframe boundaries
- **`|SHADOW(open)|`** - Marks shadow DOM roots

### Getting Selectors for Interaction

Once you identify an element by its index in the tree, use `getSelectorForID()` to get a CSS selector you can use with Playwright:

```typescript
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

// First, get the tree to see what's on the page
const tree = await client.getLLMTree("main");
console.log(tree);
// Output shows: [11]<a href="...">Article Title Here</a>

// Get the selector for element 11
const selector = await client.getSelectorForID("main", 11);
console.log(selector); // e.g., "a:nth-of-type(3)" or "#article-link"

// Now use that selector with Playwright
await page.click(selector);

await client.disconnect();
```

### When to Use Each Approach

| Method          | Best For                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| **Screenshots** | Visual debugging, seeing layout/styling issues, sharing with humans             |
| **LLM Tree**    | Understanding page structure, finding interactive elements, text-based analysis |
| **Selectors**   | Programmatically interacting with elements found in the tree                    |

### Example: Finding and Clicking a Link

```typescript
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

await page.goto("https://example.com");

// Step 1: Inspect the page structure
const tree = await client.getLLMTree("main");
console.log("Page structure:");
console.log(tree);

// Step 2: Find the element you want (say it's index 5)
// The tree showed: [5]<a href="/products">Products</a>
const selector = await client.getSelectorForID("main", 5);

// Step 3: Click using the selector
await page.click(selector);
await page.waitForLoadState("load");
await page.waitForTimeout(500); // Allow dynamic content to finish loading

console.log("Navigated to:", page.url());

await client.disconnect();
```

## Debugging Tips

1. **Use getLLMTree** for a structured view of interactive elements
2. **Take screenshots** when you need visual context
3. **Log selectors** before clicking to verify they exist
4. **Use waitForSelector** before interacting with dynamic content
5. **Check page.url()** to confirm navigation worked

## Error Recovery

If a script fails, the page state is preserved. You can:

1. Take a screenshot to see what happened
2. Check the current URL and DOM state
3. Write a recovery script to get back on track

```typescript
// Recovery script - check current state
// Save as dev-browser/tmp/debug-state.ts and run with: bun x tsx tmp/debug-state.ts
import { connect } from "dev-browser/client";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

await page.screenshot({ path: "tmp/debug.png" });
console.log({
  url: page.url(),
  title: await page.title(),
  bodyText: await page.textContent("body").then((t) => t?.slice(0, 200)),
});

await client.disconnect();
```
