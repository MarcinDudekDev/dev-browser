# Dev-Browser Patterns Library

High-level reusable helpers for common browser automation tasks.

## Installation

```typescript
import { connect } from "./client";
import { login, fillAndSubmit, modal, responsive } from "./patterns";
```

## Patterns

### `login(page, options)`

Generic login flow for WordPress and similar forms.

**Options:**
- `url` - Login page URL
- `user` - Username/email
- `pass` - Password
- `selectors?` - Custom selectors (defaults to WordPress)
  - `username?` - Default: `#user_login`
  - `password?` - Default: `#user_pass`
  - `submit?` - Default: `#wp-submit`
- `waitFor?` - Element/URL to wait for after login
- `timeout?` - Timeout in ms (default: 10000)

**Returns:** `Promise<boolean>` - Success status

**Examples:**

```typescript
// WordPress login with defaults
const client = await connect();
const page = await client.page("main");

await login(page, {
  url: 'https://site.com/wp-login.php',
  user: 'admin',
  pass: 'Admin123'
});
```

```typescript
// Custom login form
await login(page, {
  url: 'https://app.com/login',
  user: 'user@example.com',
  pass: 'secret',
  selectors: {
    username: '#email',
    password: '#password',
    submit: 'button[type="submit"]'
  },
  waitFor: '/dashboard'
});
```

```typescript
// Wait for specific element after login
await login(page, {
  url: 'https://site.com/wp-login.php',
  user: 'admin',
  pass: 'password',
  waitFor: '.admin-bar' // Wait for WordPress admin bar
});
```

---

### `fillAndSubmit(page, options)`

Fill form fields and submit in one operation.

**Options:**
- `fields` - Record of field names to values
- `submit` - Submit button selector
- `waitFor?` - Element/URL to wait for after submit
- `clear?` - Clear fields before filling (default: true)
- `timeout?` - Timeout in ms (default: 10000)

**Returns:** `Promise<FillFormResult & { submitted: boolean }>` - Result with filled/notFound fields

**Examples:**

```typescript
// Contact form
const result = await fillAndSubmit(page, {
  fields: {
    'email': 'user@example.com',
    'name': 'John Doe',
    'message': 'Hello world'
  },
  submit: 'button[type="submit"]',
  waitFor: '.success-message'
});

console.log('Filled:', result.filled);
console.log('Not found:', result.notFound);
console.log('Submitted:', result.submitted);
```

```typescript
// Payment form (works across frames)
await fillAndSubmit(page, {
  fields: {
    'cardnumber': '4242424242424242',
    'exp-date': '12/25',
    'cvc': '123'
  },
  submit: '#checkout-button',
  waitFor: '/order-complete'
});
```

---

### `modal(page, options)`

Handle modal interaction flow.

**Options:**
- `open` - Trigger selector to open modal
- `modal?` - Modal container selector for verification
- `action?` - Action selector to click inside modal
- `close?` - Close button selector
- `screenshot?` - Path to save screenshot before closing
- `timeout?` - Timeout in ms (default: 5000)

**Returns:** `Promise<boolean>` - Success status

**Examples:**

```typescript
// Simple modal with action
await modal(page, {
  open: '.open-settings',
  modal: '.settings-modal',
  action: '.save-button'
});
```

```typescript
// Modal with screenshot
await modal(page, {
  open: '.show-preview',
  modal: '.preview-modal',
  screenshot: '/tmp/preview.png',
  close: '.modal-close'
});
```

```typescript
// WordPress config toggle modal
await modal(page, {
  open: '.constant-toggle',
  modal: '.wpmultitool-modal-overlay',
  action: '.confirm-button',
  close: '.modal-close'
});
```

---

### `responsive(page, options)`

Test page across multiple viewports.

**Options:**
- `url?` - URL to test (optional if already on page)
- `viewports?` - Array of viewport configs (defaults to common breakpoints)
- `screenshots?` - Base path for screenshots (appends viewport name)
- `timeout?` - Timeout in ms (default: 10000)

**Default viewports:**
- Mobile: 375x812
- Tablet: 768x1024
- Desktop: 1280x900
- Desktop Large: 1920x1080

**Returns:** `Promise<boolean>` - Success status

**Examples:**

```typescript
// Test with default viewports
await responsive(page, {
  url: 'https://site.com',
  screenshots: '/tmp/responsive'
});
// Saves: /tmp/responsive-mobile.png, /tmp/responsive-tablet.png, etc.
```

```typescript
// Custom viewports
await responsive(page, {
  viewports: [
    { width: 320, height: 568, name: 'mobile-small' },
    { width: 768, height: 1024, name: 'tablet' },
    { width: 1920, height: 1080, name: 'desktop-hd' }
  ],
  screenshots: '/tmp/test'
});
```

```typescript
// Test current page without screenshots
await responsive(page, {
  viewports: [
    { width: 375, height: 812, name: 'mobile' },
    { width: 1280, height: 900, name: 'desktop' }
  ]
});
```

---

## Complete Example

```typescript
import { connect } from "./client";
import { login, fillAndSubmit, modal, responsive } from "./patterns";

// Start session
const client = await connect();
const page = await client.page("test-session");

// Login to WordPress
const loginSuccess = await login(page, {
  url: 'https://fiverr.loc/wp-login.php',
  user: 'admin',
  pass: 'Admin123',
  waitFor: '.admin-bar'
});

if (!loginSuccess) {
  console.error('Login failed');
  process.exit(1);
}

// Navigate to settings page
await page.goto('https://fiverr.loc/wp-admin/admin.php?page=settings');

// Test modal interaction
await modal(page, {
  open: '.toggle-debug',
  modal: '.confirm-modal',
  action: '.confirm-yes',
  screenshot: '/tmp/modal-before-close.png'
});

// Test form submission
await fillAndSubmit(page, {
  fields: {
    'site_title': 'My Test Site',
    'admin_email': 'admin@example.com'
  },
  submit: '#submit',
  waitFor: '.updated'
});

// Test responsive design
await responsive(page, {
  url: 'https://fiverr.loc',
  screenshots: '/tmp/homepage'
});

// Cleanup
await client.disconnect();
```

## Integration with Scripts

Use patterns in your `dev-browser-scripts/`:

```typescript
// dev-browser-scripts/wp-login.ts
import { Page } from 'playwright';
import { login } from '../src/patterns';

export default async function(page: Page) {
  return await login(page, {
    url: process.env.WP_URL || 'https://fiverr.loc/wp-login.php',
    user: process.env.WP_USER || 'admin',
    pass: process.env.WP_PASS || 'Admin123',
    waitFor: '.admin-bar'
  });
}
```

```typescript
// dev-browser-scripts/test-contact-form.ts
import { Page } from 'playwright';
import { fillAndSubmit } from '../src/patterns';

export default async function(page: Page) {
  await page.goto('https://site.com/contact');

  const result = await fillAndSubmit(page, {
    fields: {
      'your-name': 'Test User',
      'your-email': 'test@example.com',
      'your-subject': 'Test Subject',
      'your-message': 'This is a test message'
    },
    submit: '.wpcf7-submit',
    waitFor: '.wpcf7-mail-sent-ok'
  });

  return {
    success: result.submitted,
    filled: result.filled,
    notFound: result.notFound
  };
}
```

## Best Practices

1. **Always check return values** - Patterns return boolean success status or detailed results
2. **Use waitFor** - Specify what to wait for after actions to ensure completion
3. **Custom selectors** - Override defaults when working with non-WordPress sites
4. **Screenshot on failure** - Use `screenshot` option in modal pattern for debugging
5. **Combine patterns** - Chain multiple patterns for complex flows
6. **Environment variables** - Use env vars for credentials in login pattern

## Error Handling

All patterns handle errors gracefully:

```typescript
const success = await login(page, { /* ... */ });
if (!success) {
  console.error('Login failed');
  // Take debug screenshot
  await page.screenshot({ path: '/tmp/login-error.png' });
  process.exit(1);
}
```

Patterns log errors to console but don't throw, allowing you to handle failures as needed.
