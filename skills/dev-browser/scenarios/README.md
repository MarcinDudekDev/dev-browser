# Dev-Browser Scenario Runner

Run browser automation scenarios from YAML files.

## Quick Start

```bash
# Run a scenario
bun x tsx src/scenario-runner.ts scenarios/examples/wp-login.yaml

# Or make it executable
chmod +x src/scenario-runner.ts
./src/scenario-runner.ts scenarios/examples/test-simple.yaml
```

## Prerequisites

- Dev-browser server must be running
- Start with: `npm run start-server` or use the dev-browser CLI

## Features Implemented

### ✅ Core Steps
- `goto` - Navigate to URL
- `click` - Click elements (by selector, text, or ARIA ref)
- `fill` - Fill form fields
- `type` - Keyboard input with delays
- `wait` - Wait for load, networkidle, elements, or time
- `screenshot` - Capture screenshots (auto-saved to tmp/)
- `eval` - Execute JavaScript (with optional variable storage)

### ✅ Pattern Shortcuts
- `login` - WordPress/form login pattern
- `fillForm` - Smart form filling (cross-frame)
- `modal` - Modal interaction handling
- `responsive` - Multi-viewport screenshots

### ✅ Control Flow
- `if/then/else` - Conditional execution
- `try/catch` - Error recovery blocks
- `each` - Loop over elements
- `repeat` - Repeat steps N times

### ✅ Assertions
- `title` - Exact title match
- `titleContains` - Partial title match
- `url` - URL pattern matching (supports glob)
- `visible` - Element visibility check
- `hidden` - Element hidden check
- `exists` - Element existence check
- `text` - Text content validation
- `count` - Element count validation

### ✅ Error Handling
- Global `onError: continue|stop`
- Per-step `onError` override
- Try/catch blocks for recovery
- Detailed error reporting

### ✅ Variables
- `{{VAR}}` interpolation
- Environment fallback: `${ENV:-default}`
- Runtime variable storage from `eval`

## Examples

See `scenarios/examples/`:
- `wp-login.yaml` - WordPress login with assertions
- `form-test.yaml` - Form filling with conditionals
- `test-simple.yaml` - Basic Google search test
- `test-variables.yaml` - Variable interpolation demo
- `test-error-handling.yaml` - Error handling demo

## Execution Report

The runner outputs a detailed report:

```
============================================================
Scenario: test-simple
Status: PASSED
Duration: 1071ms
============================================================
✓ Step 0 [PASSED ] goto (616ms)
✓ Step 1 [PASSED ] wait (102ms)
✓ Step 2 [PASSED ] if (16ms)
✓ Step 3 [PASSED ] wait (104ms)
✓ Step 4 [PASSED ] screenshot (52ms)
```

Exit codes:
- `0` - All steps passed
- `1` - One or more steps failed or fatal error

## Implementation Notes

- Screenshots auto-saved to `tmp/` (creates directory if needed)
- Variables resolved at scenario start
- Steps executed sequentially
- Assertions run after each step
- Client connection reused across steps
- Page state persists in dev-browser server

## Schema Reference

See `SCHEMA.md` for complete YAML syntax documentation.
