# Dev-Browser Scenario Schema

Declarative YAML format for browser automation flows. Scenarios compile to TypeScript scripts.

## Quick Reference

```yaml
name: scenario-name
variables:
  URL: https://example.com
  USER: ${WP_USER:-admin}
steps:
  - goto: "{{URL}}"
  - wait: load
  - click: "#login"
  - fill: { "#username": "{{USER}}" }
  - screenshot: result.png
```

---

## Schema Definition

### Root Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | yes | Unique scenario identifier |
| `description` | string | no | What this scenario tests/does |
| `page` | string | no | Page name (default: "main") |
| `variables` | object | no | Key-value pairs, supports `${ENV:-default}` |
| `onError` | string | no | `stop` (default) or `continue` |
| `steps` | array | yes | List of steps to execute |

### Variables

Variables use `{{VAR}}` syntax in step values. Define with environment fallbacks:

```yaml
variables:
  WP_URL: ${WP_URL:-http://localhost:8080}
  WP_USER: ${WP_USER:-admin}
  WP_PASS: ${WP_PASS:-admin}
  TIMEOUT: "5000"  # string, converted as needed
```

---

## Step Types

### Basic Steps

#### `goto` - Navigate to URL
```yaml
- goto: "{{WP_URL}}/wp-login.php"
- goto: { url: "{{WP_URL}}", waitUntil: networkidle }
```

#### `click` - Click element
```yaml
- click: "#submit"
- click: { selector: "button.primary", timeout: 3000 }
- click: { text: "Log In" }  # click by text content
- click: { ref: "e5" }       # click ARIA snapshot ref
```

#### `fill` - Fill form fields
```yaml
- fill: { "#user_login": "{{WP_USER}}", "#user_pass": "{{WP_PASS}}" }
- fill:
    selector: "#email"
    value: "test@example.com"
    clear: true  # default: true
```

#### `type` - Type with keyboard (supports special keys)
```yaml
- type: { selector: "#search", text: "query", delay: 50 }
- type: { text: "Enter" }  # keyboard shortcut
```

#### `wait` - Wait for condition
```yaml
- wait: load                    # waitForPageLoad()
- wait: networkidle             # waitForNetworkIdle()
- wait: { element: ".modal" }   # waitForElement()
- wait: { gone: ".spinner" }    # waitForElementGone()
- wait: { url: "**/dashboard" } # waitForURL()
- wait: { ms: 1000 }            # explicit delay (avoid)
```

#### `screenshot` - Capture screenshot
```yaml
- screenshot: result.png        # saves to tmp/result.png
- screenshot: { path: "full.png", fullPage: true }
```

#### `eval` - Execute JavaScript
```yaml
- eval: "document.title"
- eval:
    script: "return document.querySelectorAll('.item').length"
    store: itemCount  # store result in variable
```

### Pattern Shortcuts

High-level patterns that expand to multiple steps.

#### `login` - WordPress/form login
```yaml
- login:
    url: "{{WP_URL}}/wp-login.php"
    username: "{{WP_USER}}"
    password: "{{WP_PASS}}"
    # Optional overrides:
    usernameSelector: "#user_login"
    passwordSelector: "#user_pass"
    submitSelector: "#wp-submit"
```

Expands to:
```yaml
- goto: { url: "{{WP_URL}}/wp-login.php" }
- wait: load
- fill: { "#user_login": "{{WP_USER}}", "#user_pass": "{{WP_PASS}}" }
- click: "#wp-submit"
- wait: load
```

#### `fillForm` - Smart form filling (cross-frame)
```yaml
- fillForm:
    fields:
      "Card Number": "4242424242424242"
      "Expiration": "12/28"
      "CVC": "123"
    submit: true
```

Uses `client.fillForm()` - works with Stripe/PayPal iframes.

#### `modal` - Handle modal dialogs
```yaml
- modal:
    wait: ".modal"
    action: confirm     # confirm | dismiss | fill
    fill: { "#name": "Test" }
    close: ".modal-close"
```

#### `responsive` - Multi-viewport screenshots
```yaml
- responsive:
    path: "homepage"    # saves as homepage-mobile.png, etc.
    viewports:
      - { name: mobile, width: 375, height: 812 }
      - { name: tablet, width: 768, height: 1024 }
      - { name: desktop, width: 1440, height: 900 }
```

---

## Assertions

Optional validation after steps. Failures respect `onError`.

```yaml
- goto: "{{URL}}"
  assert:
    - { title: "Dashboard" }           # exact match
    - { titleContains: "Admin" }       # partial match
    - { url: "**/dashboard" }          # glob pattern
    - { visible: ".welcome-message" }  # element visible
    - { hidden: ".error" }             # element not visible
    - { text: { selector: "h1", contains: "Welcome" } }
    - { count: { selector: ".items", min: 1, max: 10 } }
```

---

## Error Handling

### Global `onError`
```yaml
onError: continue  # continue on failure (default: stop)
```

### Per-Step Override
```yaml
- click: "#optional-button"
  onError: continue

- click: "#required-button"
  onError: stop
```

### Try/Catch Block
```yaml
- try:
    - click: "#maybe-exists"
    - fill: { "#field": "value" }
  catch:
    - screenshot: error-state.png
    - click: "#alternative"
```

---

## Conditionals

```yaml
- if:
    exists: ".cookie-banner"
  then:
    - click: "#accept-cookies"

- if:
    url: "**/login**"
  then:
    - login:
        username: "{{USER}}"
        password: "{{PASS}}"
```

---

## Loops

```yaml
- each:
    selector: ".product-card"
    as: product
    steps:
      - click: "{{product}} .add-to-cart"
      - wait: { gone: ".loading" }

- repeat:
    times: 3
    steps:
      - click: ".next-page"
      - wait: load
```

---

## Example Scenarios

### 1. WordPress Login + Dashboard Check

```yaml
name: wp-admin-login
description: Log into WordPress admin and verify dashboard
page: admin

variables:
  WP_URL: ${WP_URL:-http://localhost:8080}
  WP_USER: ${WP_USER:-admin}
  WP_PASS: ${WP_PASS:-admin}

steps:
  - login:
      url: "{{WP_URL}}/wp-login.php"
      username: "{{WP_USER}}"
      password: "{{WP_PASS}}"

  - wait: load
    assert:
      - { url: "**/wp-admin/**" }
      - { visible: "#adminmenu" }

  - screenshot: dashboard.png
```

### 2. E-commerce Checkout Flow

```yaml
name: checkout-flow
description: Add product to cart and complete checkout
page: shop
onError: stop

variables:
  SHOP_URL: ${SHOP_URL:-https://demo.store}
  CARD: "4242424242424242"

steps:
  # Add to cart
  - goto: "{{SHOP_URL}}/products"
  - wait: load
  - click: { text: "Add to Cart" }
  - wait: { element: ".cart-count" }
    assert:
      - { text: { selector: ".cart-count", contains: "1" } }

  # Checkout
  - goto: "{{SHOP_URL}}/checkout"
  - wait: load

  # Fill shipping
  - fill:
      "#email": "test@example.com"
      "#name": "Test User"
      "#address": "123 Test St"

  # Payment (Stripe iframe)
  - fillForm:
      fields:
        "Card Number": "{{CARD}}"
        "MM / YY": "12/28"
        "CVC": "123"

  - click: "#place-order"
  - wait: { url: "**/thank-you**", timeout: 10000 }
  - screenshot: order-complete.png
```

### 3. Responsive Screenshots

```yaml
name: homepage-responsive
description: Capture homepage at multiple viewport sizes
page: responsive

variables:
  URL: ${URL:-https://example.com}

steps:
  - goto: "{{URL}}"
  - wait: load

  # Handle cookie consent if present
  - if:
      exists: ".cookie-banner"
    then:
      - click: "#accept-cookies"
      - wait: { gone: ".cookie-banner" }

  - responsive:
      path: "homepage"
      viewports:
        - { name: mobile, width: 375, height: 812 }
        - { name: tablet, width: 768, height: 1024 }
        - { name: desktop, width: 1440, height: 900 }
```

---

## File Conventions

- Scenarios: `scenarios/{name}.yaml`
- Screenshots: `tmp/{scenario}/{name}.png`
- Logs: `tmp/{scenario}/run.log`

## Execution

```bash
# Run scenario
dev-browser.sh --scenario wp-admin-login

# With variable overrides
dev-browser.sh --scenario checkout-flow WP_URL=http://staging.site

# Dry-run (show generated script)
dev-browser.sh --scenario wp-admin-login --dry-run
```
