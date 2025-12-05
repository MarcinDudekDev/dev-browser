# Dev Browser - Claude Code Plugin

A browser automation plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that lets Claude control your web browser to close the loop on your development workflows.

## Why Dev Browser?

This plugin is optimized for **testing and verifying as you develop**. Claude can interact with your running application, fill out forms, click buttons, and verify that your changes work—all without leaving your coding session.

### How It's Different

| Approach                      | How It Works                                      | Tradeoff                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playwright MCP**            | Observe-think-act loop with individual tool calls | Simple but slow; each action is a separate round-trip. The MCP also takes up a lot of context window space.                                                                              |
| **Direct Playwright scripts** | Full scripts that run end-to-end                  | Fast but fragile; scripts start fresh every time, so failures mean starting over. Very context efficient.                                                                                |
| **Dev Browser**               | Stateful server + agentic script execution        | Best of both worlds. In between Playwright MCP and Playwright skill in terms of context efficiency. In practice it can be more context efficient because it is less likely to get stuck. |

**Dev Browser** runs a persistent Playwright server that maintains browser state across script executions. This means:

- **Pages stay alive** - Navigate to a page once, interact with it across multiple scripts
- **Flexible execution** - Run full Playwright scripts when the agent knows what to do, or fall back to step-by-step observation when exploring
- **Codebase-aware** - The plugin includes instructions for Claude to look at your actual code to inform debugging
- **LLM-friendly inspection** - Get structured DOM snapshots optimized for AI understanding, similar to browser-use

In practice, Claude will often explore a page step-by-step first, then generate reusable scripts to speed up repetitive actions.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [Bun](https://bun.sh) runtime (v1.0 or later)
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

## Installation

### Step 1: Add the Marketplace

In Claude Code, run:

```
/plugin marketplace add sawyerhood/dev-browser
```

### Step 2: Install the Plugin

```
/plugin install dev-browser@sawyerhood/dev-browser
```

### Step 3: Use It!

Prompt Claude to use it!

> **Restart Claude Code** after installation to activate the plugin.

## Usage

Once installed, just ask Claude to interact with your browser. Here are some example prompts:

**Testing your app:**

> "Open my local dev server at localhost:3000 and create an account to verify the signup flow"

**Debugging UI issues:**

> "Go to the settings page and figure out why the save button isn't working"

**Close the loop visually**

> "Can you use the frontend design skill to make the landing page more visually appealing? Use dev-browser to iterate on the design until it looks good."

## License

MIT

## Author

[Sawyer Hood](https://github.com/sawyerhood)
