---
name: dev-browser
description: Browser automation with persistent page state
arguments:
  command:
    description: "goto|click|fill|text|aria|--screenshot|--inspect|--list|--help"
    required: false
  args:
    description: "Command arguments (URL, selector, value, etc.)"
    required: false
---

# Dev Browser Quick Reference

## Navigation & Interaction
```bash
dev-browser.sh goto <url>           # Navigate + auto-inspect
dev-browser.sh click <text|ref>     # Click by text or ARIA ref
dev-browser.sh fill <field> <value> # Fill form field
dev-browser.sh text <ref>           # Get element text
dev-browser.sh aria                 # ARIA snapshot with refs
```

## Screenshots & Inspection
```bash
dev-browser.sh --screenshot main    # Take screenshot
dev-browser.sh --inspect main       # Forms + ARIA snapshot
dev-browser.sh --annotate main      # Screenshot with ref labels
```

## Browser Modes
| Mode | Flag | Use Case |
|------|------|----------|
| dev | `--dev` (default) | Normal testing |
| stealth | `--stealth` | Bypass bot detection |
| user | `--user` | Your real browser session |

## Server Management
```bash
dev-browser.sh --server             # Start server
dev-browser.sh --status             # Check all servers
dev-browser.sh --stop               # Stop current mode
```

## TypeScript Scripts
Save to `$DEV_BROWSER_HOME/scripts/{project}/script.ts`:
```typescript
// client and page are AUTO-INJECTED
await page.goto("https://example.com");
await waitForPageLoad(page);
console.log(await page.title());
```

Run with: `dev-browser.sh --run {project}/script`

---

**Full docs:** See SKILL.md or run `dev-browser.sh --help`
