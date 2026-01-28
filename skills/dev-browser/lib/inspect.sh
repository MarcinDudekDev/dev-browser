#!/bin/bash
# Page inspection commands

cmd_inspect() {
    local page_name="${1:-main}"
    start_server || return 1
    local PREFIX=$(get_project_prefix)

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<INSPECT_SCRIPT
import { connect } from "@/client.js";

const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);
console.log("=== PAGE INSPECT: ${page_name} ===");
console.log("URL:", page.url());
console.log("");

const info = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        id: f.id || '(no id)',
        action: f.action || '(no action)',
        fields: Array.from(f.querySelectorAll('input, select, textarea')).slice(0, 10).map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || el.id || '(unnamed)',
            value: el.value?.substring(0, 30) || ''
        }))
    }));
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
        name: f.name || '(no name)',
        src: f.src?.substring(0, 80) || '(no src)',
        isStripe: f.src?.includes('stripe') || false
    }));
    const orphanInputs = Array.from(document.querySelectorAll('input:not(form input), select:not(form select)')).slice(0, 10).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || el.id || '(unnamed)'
    }));
    return { forms, iframes, orphanInputs };
});

if (info.forms.length > 0) {
    console.log("=== FORMS ===");
    info.forms.forEach((f, i) => {
        console.log(\`Form #\${i + 1}: id="\${f.id}" action="\${f.action}"\`);
        f.fields.forEach(field => {
            console.log(\`  [\${field.tag}] name="\${field.name}" type="\${field.type}" value="\${field.value}"\`);
        });
    });
    console.log("");
}

if (info.iframes.length > 0) {
    console.log("=== IFRAMES ===");
    info.iframes.forEach(f => {
        const badge = f.isStripe ? " [STRIPE]" : "";
        console.log(\`  name="\${f.name}"\${badge}\`);
        console.log(\`    src: \${f.src}\`);
    });
    console.log("");
}

if (info.orphanInputs.length > 0) {
    console.log("=== INPUTS (outside forms) ===");
    info.orphanInputs.forEach(field => {
        console.log(\`  [\${field.tag}] name="\${field.name}" type="\${field.type}"\`);
    });
    console.log("");
}

const snapshot = await client.getAISnapshot(pageName);
const lines = snapshot.split('\n');
const buttons = lines.filter(l => l.includes('button')).slice(0, 5);
const links = lines.filter(l => l.includes('link "')).slice(0, 5);
const textboxes = lines.filter(l => l.includes('textbox')).slice(0, 5);

console.log("=== KEY ELEMENTS (use [ref=eN] with selectSnapshotRef) ===");
if (buttons.length) { console.log("Buttons:"); buttons.forEach(b => console.log("  " + b.trim())); }
if (links.length) { console.log("Links:"); links.forEach(l => console.log("  " + l.trim())); }
if (textboxes.length) { console.log("Textboxes:"); textboxes.forEach(t => console.log("  " + t.trim())); }
console.log("");
await client.disconnect();
INSPECT_SCRIPT
}

cmd_page_status() {
    local page_name="${1:-main}"
    start_server || return 1
    local PREFIX=$(get_project_prefix)

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<STATUS_SCRIPT
import { connect } from "@/client.js";

const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found");
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);
const status = await page.evaluate(() => {
    const getText = (el) => el?.textContent?.trim()?.substring(0, 200) || '';
    const errorSelectors = ['.error', '.alert-error', '.alert-danger', '[class*="error"]', '.warning', '.alert-warning', '[class*="warning"]', '[role="alert"]'];
    const successSelectors = ['.success', '.alert-success', '[class*="success"]'];
    const errors = [], warnings = [], successes = [];

    errorSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
            const text = getText(el);
            if (text && !errors.includes(text) && !warnings.includes(text)) {
                if (sel.includes('warning')) warnings.push(text);
                else errors.push(text);
            }
        });
    });
    successSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
            const text = getText(el);
            if (text && !successes.includes(text)) successes.push(text);
        });
    });
    return { url: window.location.href, title: document.title, errors: errors.slice(0, 5), warnings: warnings.slice(0, 5), successes: successes.slice(0, 5) };
});

console.log("=== PAGE STATUS: ${page_name} ===");
console.log("URL:", status.url);
console.log("Title:", status.title);
if (status.errors.length > 0) { console.log("\n❌ ERRORS:"); status.errors.forEach(e => console.log("  ", e)); }
if (status.warnings.length > 0) { console.log("\n⚠️  WARNINGS:"); status.warnings.forEach(w => console.log("  ", w)); }
if (status.successes.length > 0) { console.log("\n✅ SUCCESS:"); status.successes.forEach(s => console.log("  ", s)); }
if (status.errors.length === 0 && status.warnings.length === 0 && status.successes.length === 0) { console.log("\n(No status messages detected)"); }
await client.disconnect();
STATUS_SCRIPT
}

cmd_console() {
    local page_name="${1:-main}"
    local timeout_sec="${2:-0}"
    start_server || return 1
    local PREFIX=$(get_project_prefix)

    if [[ "$timeout_sec" -gt 0 ]]; then
        echo "Watching console for page '${page_name}' (timeout: ${timeout_sec}s)..." >&2
    elif [[ "$timeout_sec" -eq 0 ]]; then
        echo "Console snapshot for page '${page_name}'..." >&2
    else
        echo "Watching console for page '${page_name}' (Ctrl+C to stop)..." >&2
    fi

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<CONSOLE_SCRIPT
import { connect } from "@/client.js";

const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
const timeoutSec = ${timeout_sec};
const snapshotMode = timeoutSec === 0;
if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);

// Use CDP for snapshot mode to get existing console entries
if (snapshotMode) {
    const cdp = await page.context().newCDPSession(page);

    // Collect messages
    const messages = [];

    // Enable Console domain (collects existing messages)
    cdp.on('Console.messageAdded', ({ message }) => {
        messages.push({
            type: message.level.toUpperCase(),
            text: message.text,
            url: message.url,
            line: message.line
        });
    });

    // Enable Runtime for any immediate console API calls
    cdp.on('Runtime.consoleAPICalled', ({ type, args, timestamp }) => {
        const text = args.map(a => a.value || a.description || '').join(' ');
        messages.push({
            type: type.toUpperCase(),
            text: text,
            timestamp: timestamp
        });
    });

    // Enable domains
    await cdp.send('Console.enable');
    await cdp.send('Runtime.enable');

    // Brief pause to collect any immediate messages
    await new Promise(r => setTimeout(r, 200));

    // Also get any JS errors visible on page
    const pageErrors = await page.evaluate(() => {
        const errors = [];
        // Check for common error display patterns
        document.querySelectorAll('[class*="error"], [class*="Error"], .notice-error, .wp-die-message').forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length < 500) errors.push(text);
        });
        return errors.slice(0, 10);
    });

    // Output
    console.log("=== CONSOLE SNAPSHOT: ${page_name} ===");
    console.log("URL:", page.url());
    console.log("");

    if (messages.length > 0) {
        console.log("📋 CONSOLE MESSAGES:");
        messages.forEach(m => {
            const loc = m.url ? \` (\${m.url.split('/').pop()}:\${m.line || '?'})\` : '';
            console.log(\`  [\${m.type.padEnd(7)}] \${m.text}\${loc}\`);
        });
        console.log("");
    }

    if (pageErrors.length > 0) {
        console.log("❌ VISIBLE ERRORS ON PAGE:");
        pageErrors.forEach(e => console.log("  " + e.substring(0, 200)));
        console.log("");
    }

    if (messages.length === 0 && pageErrors.length === 0) {
        console.log("(No console messages or visible errors detected)");
    }

    await client.disconnect();
    process.exit(0);
}

// Watch mode (timeout > 0 or continuous)
page.on('console', msg => {
    const type = msg.type().toUpperCase().padEnd(7);
    console.log(\`[\${new Date().toLocaleTimeString()}] \${type} \${msg.text()}\`);
});
page.on('pageerror', err => {
    console.log(\`[\${new Date().toLocaleTimeString()}] ERROR   \${err.message}\`);
});

console.log("Listening for console messages...");
console.log("URL:", page.url());
console.log("---");

if (timeoutSec > 0) {
    setTimeout(async () => {
        console.log("---");
        console.log(\`Timeout (\${timeoutSec}s) reached.\`);
        await client.disconnect();
        process.exit(0);
    }, timeoutSec * 1000);
} else {
    await new Promise(() => {});
}
CONSOLE_SCRIPT
}

cmd_console_snapshot() {
    # Alias for --console 0
    local page_name="${1:-main}"
    cmd_console "$page_name" 0
}

cmd_styles() {
    local selector="$1"
    local page_name="${2:-main}"

    if [[ -z "$selector" ]]; then
        echo "Usage: dev-browser.sh --styles <selector> [page]"
        echo "Example: dev-browser.sh --styles '.widget-heading h2'"
        return 1
    fi

    start_server || return 1
    local PREFIX=$(get_project_prefix)

    # Escape quotes in selector for safe JS embedding
    local escaped_selector="${selector//\\/\\\\}"  # escape backslashes first
    escaped_selector="${escaped_selector//\"/\\\"}"  # escape double quotes

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<STYLES_SCRIPT
import { connect } from "@/client.js";

const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
const selector = "${escaped_selector}";

if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);
const cdp = await page.context().newCDPSession(page);

// Enable required CDP domains
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');

// Get document root
const { root } = await cdp.send('DOM.getDocument');

// Find element by selector
let nodeId;
try {
    const result = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: selector
    });
    nodeId = result.nodeId;
    if (!nodeId) throw new Error('Element not found');
} catch (e) {
    console.log("❌ Element not found: " + selector);
    await client.disconnect();
    process.exit(1);
}

// Get matched styles
const styles = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });

console.log("=== CSS STYLES: " + selector + " ===");
console.log("URL: " + page.url());
console.log("");

// Helper to format source location
const formatSource = (rule) => {
    if (!rule.origin || rule.origin === 'user-agent') return '(user-agent)';
    if (rule.origin === 'inline') return '(inline style)';

    const styleSheet = rule.styleSheetId;
    const range = rule.style?.range;
    let source = '';

    if (rule.style?.sourceURL) {
        const url = rule.style.sourceURL;
        const filename = url.split('/').pop()?.split('?')[0] || url;
        const line = range?.startLine !== undefined ? ':' + (range.startLine + 1) : '';
        source = filename + line;
    } else if (styleSheet) {
        source = '(stylesheet ' + styleSheet.substring(0, 8) + '...)';
    } else {
        source = '(' + (rule.origin || 'unknown') + ')';
    }
    return source;
};

// Process inline styles first
if (styles.inlineStyle?.cssProperties?.length > 0) {
    console.log("📌 INLINE STYLES (highest specificity)");
    styles.inlineStyle.cssProperties
        .filter(p => !p.disabled && p.name && p.value)
        .forEach(p => {
            console.log("  " + p.name + ": " + p.value + " ← (inline style)");
        });
    console.log("");
}

// Process matched rules (winning rules)
if (styles.matchedCSSRules?.length > 0) {
    console.log("🎯 MATCHED RULES (in cascade order, last wins)");

    // Group by property to show what overrides what
    const propertyMap = new Map();

    styles.matchedCSSRules.forEach(match => {
        const rule = match.rule;
        const selectorText = rule.selectorList?.selectors?.map(s => s.text).join(', ') || '(unknown)';
        const source = formatSource(rule);

        rule.style?.cssProperties
            ?.filter(p => !p.disabled && p.name && p.value && !p.name.startsWith('-'))
            .forEach(p => {
                if (!propertyMap.has(p.name)) {
                    propertyMap.set(p.name, []);
                }
                propertyMap.get(p.name).push({
                    value: p.value,
                    selector: selectorText,
                    source: source,
                    important: p.value.includes('!important')
                });
            });
    });

    // Display by property, showing cascade
    for (const [prop, rules] of propertyMap) {
        const winner = rules[rules.length - 1];
        const hasImportant = rules.some(r => r.important);
        const actualWinner = hasImportant ? rules.find(r => r.important) || winner : winner;

        console.log("  " + prop + ": " + actualWinner.value + " ← " + actualWinner.selector + " (" + actualWinner.source + ")");

        // Show overridden rules
        rules.filter(r => r !== actualWinner).forEach(r => {
            console.log("    ╌╌ " + r.value + " ← " + r.selector + " (" + r.source + ") [overridden]");
        });
    }
    console.log("");
}

// Process inherited styles
if (styles.inherited?.length > 0) {
    const inheritedProps = new Map();

    styles.inherited.forEach((inherited, depth) => {
        if (inherited.matchedCSSRules) {
            inherited.matchedCSSRules.forEach(match => {
                const rule = match.rule;
                const selectorText = rule.selectorList?.selectors?.map(s => s.text).join(', ') || '(unknown)';
                const source = formatSource(rule);

                rule.style?.cssProperties
                    ?.filter(p => !p.disabled && p.name && p.value && !p.name.startsWith('-'))
                    .filter(p => ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'letter-spacing', 'direction', 'visibility', 'cursor'].includes(p.name))
                    .forEach(p => {
                        if (!inheritedProps.has(p.name)) {
                            inheritedProps.set(p.name, {
                                value: p.value,
                                selector: selectorText,
                                source: source,
                                depth: depth + 1
                            });
                        }
                    });
            });
        }
    });

    if (inheritedProps.size > 0) {
        console.log("📥 INHERITED STYLES");
        for (const [prop, info] of inheritedProps) {
            console.log("  " + prop + ": " + info.value + " ← " + info.selector + " (" + info.source + ") [inherited×" + info.depth + "]");
        }
        console.log("");
    }
}

// Computed style for quick reference
const computed = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        display: cs.display,
        position: cs.position
    };
}, selector);

if (computed) {
    console.log("📊 COMPUTED (final values)");
    Object.entries(computed).forEach(([k, v]) => {
        console.log("  " + k + ": " + v);
    });
}

await client.disconnect();
STYLES_SCRIPT
}

cmd_element() {
    local selector="$1"
    local page_name="${2:-main}"

    if [[ -z "$selector" ]]; then
        echo "Usage: dev-browser.sh --element <selector|ref> [page]"
        echo "Example: dev-browser.sh --element '#submit-btn'"
        echo "         dev-browser.sh --element e53          # Use ref from --annotate"
        echo "         dev-browser.sh --element '.nav-item' checkout"
        return 1
    fi

    start_server || return 1
    local PREFIX=$(get_project_prefix)

    # Escape quotes in selector for safe JS embedding
    local escaped_selector="${selector//\\/\\\\}"
    escaped_selector="${escaped_selector//\"/\\\"}"

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<ELEMENT_SCRIPT
import { connect } from "@/client.js";

const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
const input = "${escaped_selector}";

if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);

// Check if input is a ref (e.g., e53, e1) or a CSS selector
const isRef = /^e\d+$/.test(input);
let selector = input;
let elementHandle = null;

if (isRef) {
    // Get ARIA snapshot to populate refs (if not already done)
    await client.getAISnapshot(pageName);

    // Get element from refs
    try {
        elementHandle = await client.selectSnapshotRef(pageName, input);
        if (!elementHandle) throw new Error('Ref not found');

        // Get a unique selector for this element for display
        selector = await page.evaluate((el) => {
            if (el.id) return '#' + el.id;
            let s = el.tagName.toLowerCase();
            if (el.className && typeof el.className === 'string') {
                const cls = el.className.trim().split(/\s+/)[0];
                if (cls) s += '.' + cls;
            }
            return s;
        }, elementHandle);
        selector = input + ' → ' + selector;
    } catch (e) {
        console.log("❌ Ref not found: " + input);
        console.log("   Run --annotate first to generate refs, or use a CSS selector.");
        await client.disconnect();
        process.exit(1);
    }
}

const cdp = await page.context().newCDPSession(page);

// Enable required CDP domains
await cdp.send('DOM.enable');

// Get document root
const { root } = await cdp.send('DOM.getDocument', { depth: -1 });

// Find element - either by ref (already have handle) or by CSS selector
let nodeId;
if (elementHandle) {
    // Convert ElementHandle to CDP nodeId
    const remoteObj = await elementHandle.evaluate((el) => el, elementHandle);
    // Use a workaround: find element by evaluating in page context
    nodeId = await page.evaluate((el) => {
        // Store temporarily for CDP lookup
        (window as any).__devBrowserTempElement = el;
        return true;
    }, elementHandle);

    // Get nodeId via evaluate
    const nodeResult = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '*'  // Will refine below
    });

    // Actually, we need to use resolveNode approach
    // Let's get the element's unique path and query it
    const uniqueSelector = await page.evaluate((el) => {
        // Build a unique selector path
        const parts: string[] = [];
        let current = el as HTMLElement;
        while (current && current !== document.body && parts.length < 5) {
            let part = current.tagName.toLowerCase();
            if (current.id) {
                parts.unshift('#' + current.id);
                break;
            }
            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (siblings.length > 1) {
                    const idx = siblings.indexOf(current) + 1;
                    part += ':nth-of-type(' + idx + ')';
                }
            }
            parts.unshift(part);
            current = current.parentElement as HTMLElement;
        }
        return parts.join(' > ') || 'body';
    }, elementHandle);

    try {
        const result = await cdp.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: uniqueSelector
        });
        nodeId = result.nodeId;
        if (!nodeId) throw new Error('Could not resolve element');
    } catch (e) {
        console.log("❌ Could not resolve ref to DOM node: " + input);
        await client.disconnect();
        process.exit(1);
    }
} else {
    // CSS selector path
    try {
        const result = await cdp.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: input
        });
        nodeId = result.nodeId;
        if (!nodeId) throw new Error('Element not found');
    } catch (e) {
        console.log("❌ Element not found: " + input);
        await client.disconnect();
        process.exit(1);
    }
}

// Get node details
const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 0 });

console.log("=== ELEMENT INSPECTOR: " + selector + " ===");
console.log("URL: " + page.url());
console.log("");

// 1. Element tag/id/classes/attributes
console.log("🏷️  ELEMENT");
const attrs = {};
if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i += 2) {
        attrs[node.attributes[i]] = node.attributes[i + 1];
    }
}
console.log("  Tag: <" + node.nodeName.toLowerCase() + ">");
if (attrs.id) console.log("  ID: #" + attrs.id);
if (attrs.class) console.log("  Classes: ." + attrs.class.split(' ').filter(Boolean).join(', .'));

const otherAttrs = Object.entries(attrs).filter(([k]) => k !== 'id' && k !== 'class' && k !== 'style');
if (otherAttrs.length > 0) {
    console.log("  Attributes:");
    otherAttrs.forEach(([k, v]) => {
        const val = v.length > 50 ? v.substring(0, 50) + '...' : v;
        console.log("    " + k + '="' + val + '"');
    });
}
if (attrs.style) {
    console.log("  Inline style: " + (attrs.style.length > 60 ? attrs.style.substring(0, 60) + '...' : attrs.style));
}
console.log("");

// Helper: get element - use elementHandle if available, otherwise querySelector
const getElement = async (fn: (el: Element) => any) => {
    if (elementHandle) {
        return await page.evaluate(fn, elementHandle);
    } else {
        return await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? (arguments[1] as (el: Element) => any)(el) : null;
        }, input);
    }
};

// 2. Parent chain (breadcrumb) via page.evaluate
const breadcrumb = elementHandle
    ? await page.evaluate((el) => {
        const chain: string[] = [];
        let current = el as HTMLElement;
        while (current && current !== document.documentElement) {
            let desc = current.tagName.toLowerCase();
            if (current.id) desc += '#' + current.id;
            else if (current.className && typeof current.className === 'string') {
                const cls = current.className.trim().split(/\s+/)[0];
                if (cls) desc += '.' + cls;
            }
            chain.unshift(desc);
            current = current.parentElement as HTMLElement;
        }
        return chain;
    }, elementHandle)
    : await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const chain: string[] = [];
        let current = el as HTMLElement;
        while (current && current !== document.documentElement) {
            let desc = current.tagName.toLowerCase();
            if (current.id) desc += '#' + current.id;
            else if (current.className && typeof current.className === 'string') {
                const cls = current.className.trim().split(/\s+/)[0];
                if (cls) desc += '.' + cls;
            }
            chain.unshift(desc);
            current = current.parentElement as HTMLElement;
        }
        return chain;
    }, input);

if (breadcrumb) {
    console.log("📍 PARENT CHAIN");
    console.log("  " + breadcrumb.join(' > '));
    console.log("");
}

// 3. Siblings
const siblings = elementHandle
    ? await page.evaluate((el) => {
        const getSibDesc = (sib: Element | null) => {
            if (!sib) return null;
            let desc = sib.tagName.toLowerCase();
            if ((sib as HTMLElement).id) desc += '#' + (sib as HTMLElement).id;
            else if (sib.className && typeof sib.className === 'string') {
                const cls = sib.className.trim().split(/\s+/)[0];
                if (cls) desc += '.' + cls;
            }
            const text = sib.textContent?.trim().substring(0, 30);
            if (text) desc += ' "' + text + (sib.textContent!.trim().length > 30 ? '...' : '') + '"';
            return desc;
        };
        return {
            prev: getSibDesc(el.previousElementSibling),
            next: getSibDesc(el.nextElementSibling),
            childCount: el.children.length,
            parentChildCount: el.parentElement?.children.length || 0
        };
    }, elementHandle)
    : await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const getSibDesc = (sib: Element | null) => {
            if (!sib) return null;
            let desc = sib.tagName.toLowerCase();
            if ((sib as HTMLElement).id) desc += '#' + (sib as HTMLElement).id;
            else if (sib.className && typeof sib.className === 'string') {
                const cls = sib.className.trim().split(/\s+/)[0];
                if (cls) desc += '.' + cls;
            }
            const text = sib.textContent?.trim().substring(0, 30);
            if (text) desc += ' "' + text + (sib.textContent!.trim().length > 30 ? '...' : '') + '"';
            return desc;
        };
        return {
            prev: getSibDesc(el.previousElementSibling),
            next: getSibDesc(el.nextElementSibling),
            childCount: el.children.length,
            parentChildCount: el.parentElement?.children.length || 0
        };
    }, input);

if (siblings) {
    console.log("👥 SIBLINGS");
    console.log("  Previous: " + (siblings.prev || '(none)'));
    console.log("  Next: " + (siblings.next || '(none)'));
    console.log("  Children: " + siblings.childCount);
    console.log("  Position: 1 of " + siblings.parentChildCount + " siblings");
    console.log("");
}

// 4. XPath selector
const xpath = elementHandle
    ? await page.evaluate((el) => {
        const parts: string[] = [];
        let current = el as Node;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            let index = 0;
            let sibling = current.previousSibling;
            while (sibling) {
                if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) {
                    index++;
                }
                sibling = sibling.previousSibling;
            }
            const tagName = current.nodeName.toLowerCase();
            const part = index > 0 ? tagName + '[' + (index + 1) + ']' : tagName;
            parts.unshift(part);
            current = current.parentNode as Node;
        }
        return '/' + parts.join('/');
    }, elementHandle)
    : await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const parts: string[] = [];
        let current = el as Node;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            let index = 0;
            let sibling = current.previousSibling;
            while (sibling) {
                if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) {
                    index++;
                }
                sibling = sibling.previousSibling;
            }
            const tagName = current.nodeName.toLowerCase();
            const part = index > 0 ? tagName + '[' + (index + 1) + ']' : tagName;
            parts.unshift(part);
            current = current.parentNode as Node;
        }
        return '/' + parts.join('/');
    }, input);

// 5. Unique CSS selector
const uniqueCssSelector = elementHandle
    ? await page.evaluate((el) => {
        if ((el as HTMLElement).id) return '#' + (el as HTMLElement).id;
        const parts: string[] = [];
        let current = el as HTMLElement;
        while (current && current !== document.body && parts.length < 4) {
            let part = current.tagName.toLowerCase();
            if (current.id) {
                parts.unshift('#' + current.id);
                break;
            }
            if (current.className && typeof current.className === 'string') {
                const classes = current.className.trim().split(/\s+/).filter(c => c && !c.includes(':'));
                if (classes.length > 0) {
                    part += '.' + classes.slice(0, 2).join('.');
                }
            }
            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (siblings.length > 1) {
                    const idx = siblings.indexOf(current) + 1;
                    part += ':nth-child(' + idx + ')';
                }
            }
            parts.unshift(part);
            current = current.parentElement as HTMLElement;
        }
        return parts.join(' > ');
    }, elementHandle)
    : await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        if ((el as HTMLElement).id) return '#' + (el as HTMLElement).id;
        const parts: string[] = [];
        let current = el as HTMLElement;
        while (current && current !== document.body && parts.length < 4) {
            let part = current.tagName.toLowerCase();
            if (current.id) {
                parts.unshift('#' + current.id);
                break;
            }
            if (current.className && typeof current.className === 'string') {
                const classes = current.className.trim().split(/\s+/).filter(c => c && !c.includes(':'));
                if (classes.length > 0) {
                    part += '.' + classes.slice(0, 2).join('.');
                }
            }
            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (siblings.length > 1) {
                    const idx = siblings.indexOf(current) + 1;
                    part += ':nth-child(' + idx + ')';
                }
            }
            parts.unshift(part);
            current = current.parentElement as HTMLElement;
        }
        return parts.join(' > ');
    }, input);

console.log("🎯 SELECTORS");
console.log("  XPath: " + (xpath || '(error)'));
console.log("  Unique CSS: " + (uniqueCssSelector || '(error)'));
console.log("");

// 6. Box model
const boxModel = await cdp.send('DOM.getBoxModel', { nodeId }).catch(() => null);
const computedStyle = elementHandle
    ? await page.evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return {
            display: cs.display,
            position: cs.position,
            width: cs.width,
            height: cs.height,
            padding: cs.padding,
            margin: cs.margin,
            border: cs.border,
            boxSizing: cs.boxSizing
        };
    }, elementHandle)
    : await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = window.getComputedStyle(el);
        return {
            display: cs.display,
            position: cs.position,
            width: cs.width,
            height: cs.height,
            padding: cs.padding,
            margin: cs.margin,
            border: cs.border,
            boxSizing: cs.boxSizing
        };
    }, input);

console.log("📐 BOX MODEL");
if (boxModel?.model) {
    const m = boxModel.model;
    console.log("  Content: " + m.width + "×" + m.height + "px");
    if (m.border) {
        const [x1, y1, x2, y2] = [m.border[0], m.border[1], m.border[2], m.border[3]];
        console.log("  Border box: " + Math.round(x2 - x1) + "×" + Math.round(m.border[5] - y1) + "px");
    }
}
if (computedStyle) {
    console.log("  Display: " + computedStyle.display);
    console.log("  Position: " + computedStyle.position);
    console.log("  Size: " + computedStyle.width + " × " + computedStyle.height);
    console.log("  Padding: " + computedStyle.padding);
    console.log("  Margin: " + computedStyle.margin);
    console.log("  Border: " + computedStyle.border);
    console.log("  Box-sizing: " + computedStyle.boxSizing);
}
console.log("");

// 7. Event listeners via CDP
const remoteObject = await cdp.send('DOM.resolveNode', { nodeId });
if (remoteObject?.object?.objectId) {
    try {
        const listeners = await cdp.send('DOMDebugger.getEventListeners', {
            objectId: remoteObject.object.objectId,
            depth: 0
        });

        if (listeners?.listeners?.length > 0) {
            console.log("⚡ EVENT LISTENERS");
            const grouped = {};
            listeners.listeners.forEach(l => {
                if (!grouped[l.type]) grouped[l.type] = [];
                grouped[l.type].push({
                    useCapture: l.useCapture,
                    passive: l.passive,
                    once: l.once,
                    source: l.scriptId ? '(script)' : '(inline)'
                });
            });
            Object.entries(grouped).forEach(([type, handlers]) => {
                const flags = handlers.map(h => {
                    const parts = [];
                    if (h.useCapture) parts.push('capture');
                    if (h.passive) parts.push('passive');
                    if (h.once) parts.push('once');
                    return parts.length ? ' [' + parts.join(', ') + ']' : '';
                });
                console.log("  " + type + ": " + handlers.length + " handler(s)" + (flags[0] || ''));
            });
            console.log("");
        }
    } catch (e) {
        // Silently skip if event listeners can't be retrieved
    }
}

await client.disconnect();
ELEMENT_SCRIPT
}

cmd_annotate() {
    local page_name="${1:-main}"
    local output_file="$2"
    start_server || return 1
    local PREFIX=$(get_project_prefix)

    # Use project screenshots directory (same as --screenshot)
    get_project_paths
    mkdir -p "$PROJECT_SCREENSHOTS_DIR"

    # Generate output filename if not provided (same pattern as --screenshot)
    if [[ -z "$output_file" ]]; then
        output_file="annotated_${page_name}_$(date +%s).png"
    fi
    local screenshot_path="$PROJECT_SCREENSHOTS_DIR/$output_file"

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<ANNOTATE_SCRIPT
import { connect } from "@/client.js";
import * as fs from "fs";
import * as path from "path";

const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
const screenshotPath = "${screenshot_path}";

if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);

// Get ARIA snapshot first (this populates __devBrowserRefs)
await client.getAISnapshot(pageName);

// Collect all refs with their bounding boxes and element info
const elements = await page.evaluate(() => {
    const refs = (window as any).__devBrowserRefs;
    if (!refs) return [];

    const results: Array<{
        ref: string;
        tag: string;
        selector: string;
        text: string;
        box: { x: number; y: number; width: number; height: number } | null;
    }> = [];

    for (const [refId, element] of Object.entries(refs)) {
        const el = element as HTMLElement;
        if (!el || !el.getBoundingClientRect) continue;

        const rect = el.getBoundingClientRect();
        // Skip elements that are not visible
        if (rect.width === 0 || rect.height === 0) continue;

        // Build a short selector description
        let selector = el.tagName.toLowerCase();
        if (el.id) selector = '#' + el.id;
        else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\s+/)[0];
            if (cls) selector = '.' + cls;
        }

        // Get text content (abbreviated)
        let text = el.textContent?.trim() || '';
        if (text.length > 25) text = text.substring(0, 25) + '...';

        results.push({
            ref: refId,
            tag: el.tagName.toLowerCase(),
            selector: selector,
            text: text,
            box: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            }
        });
    }

    // Sort by ref number
    results.sort((a, b) => {
        const numA = parseInt(a.ref.replace('e', ''));
        const numB = parseInt(b.ref.replace('e', ''));
        return numA - numB;
    });

    return results;
});

// Inject annotation overlay
await page.evaluate((els: typeof elements) => {
    // Remove any existing overlay
    const existing = document.getElementById('__devBrowserAnnotationOverlay');
    if (existing) existing.remove();

    // Create overlay canvas
    const overlay = document.createElement('div');
    overlay.id = '__devBrowserAnnotationOverlay';
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 999999;';

    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    overlay.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Colors for labels
    const colors = [
        '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'
    ];

    els.forEach((el, i) => {
        if (!el.box) return;
        const { x, y, width, height } = el.box;
        const color = colors[i % colors.length];

        // Draw rectangle around element
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, width, height);

        // Draw label background
        const label = el.ref;
        ctx.font = 'bold 11px Arial, sans-serif';
        const textWidth = ctx.measureText(label).width + 6;
        const textHeight = 16;

        // Position label at top-left of element, or above if too high
        let labelX = x;
        let labelY = y - textHeight - 2;
        if (labelY < 0) labelY = y + 2;

        ctx.fillStyle = color;
        ctx.fillRect(labelX, labelY, textWidth, textHeight);

        // Draw label text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, labelX + 3, labelY + 12);
    });

    document.body.appendChild(overlay);
}, elements);

// Take screenshot (path set from bash)
await page.screenshot({ path: screenshotPath });

// Remove overlay after screenshot
await page.evaluate(() => {
    const overlay = document.getElementById('__devBrowserAnnotationOverlay');
    if (overlay) overlay.remove();
});

// Output results
console.log("=== ANNOTATED SCREENSHOT: ${page_name} ===");
console.log("URL: " + page.url());
console.log("Screenshot: " + screenshotPath);
console.log("");
console.log("📍 ELEMENT REFS (" + elements.length + " interactive elements)");
console.log("");

elements.forEach(el => {
    if (!el.box) return;
    const { x, y, width, height } = el.box;
    const x2 = x + width;
    const y2 = y + height;
    const desc = el.text ? \` "\${el.text}"\` : '';
    console.log(\`  \${el.ref}: \${el.selector}\${desc}\`);
    console.log(\`      (\${x},\${y}) → (\${x2},\${y2}) \${width}×\${height}px\`);
});

console.log("");
console.log("💡 Use refs with: --element '.selector' or click <ref>");

await client.disconnect();
ANNOTATE_SCRIPT
    # Resize if too large (same as --screenshot)
    resize_screenshot "$screenshot_path"
}

cmd_watch_design() {
    local page_name="${1:-main}"
    local design_path="$2"
    local interval="${3:-5}"

    if [[ -z "$design_path" ]]; then
        echo "Usage: dev-browser.sh --watch-design <page> <design.png> [interval_seconds]"
        echo "Example: dev-browser.sh --watch-design main ~/designs/homepage.png 5"
        return 1
    fi

    if [[ ! -f "$design_path" ]]; then
        echo "Error: Design file not found: $design_path" >&2
        return 1
    fi

    # Check if design-compare tool exists
    if ! command -v design-compare &> /dev/null && [[ ! -x "$HOME/Tools/design-compare" ]]; then
        echo "Error: design-compare tool not found. Install it first." >&2
        return 1
    fi
    local DESIGN_COMPARE="${HOME}/Tools/design-compare"

    start_server || return 1
    local PREFIX=$(get_project_prefix)

    # Setup temp directory for screenshots
    local watch_dir=$(mktemp -d)
    local screenshot_path="$watch_dir/current.png"
    local tsx_pid_file="$watch_dir/tsx.pid"

    # Cleanup function for proper process termination
    cleanup_watch() {
        # Kill the tsx watcher process
        if [[ -f "$tsx_pid_file" ]]; then
            local tsx_pid=$(cat "$tsx_pid_file" 2>/dev/null)
            if [[ -n "$tsx_pid" ]] && kill -0 "$tsx_pid" 2>/dev/null; then
                kill "$tsx_pid" 2>/dev/null
                wait "$tsx_pid" 2>/dev/null
            fi
        fi
        # Kill any child processes
        pkill -P $$ 2>/dev/null
        sleep 0.3
        pkill -9 -P $$ 2>/dev/null
        # Clean up temp directory
        rm -rf "$watch_dir"
        echo
        echo "Watch stopped."
    }

    # Cleanup on exit
    trap cleanup_watch EXIT INT TERM

    echo "🔍 Design Watch Started"
    echo "   Page: $page_name"
    echo "   Design: $(basename "$design_path")"
    echo "   Interval: ${interval}s"
    echo "   Press Ctrl+C to stop"
    echo ""
    echo "─────────────────────────────────────────────"

    # Run a SINGLE persistent tsx script that maintains ONE browser connection
    # and outputs screenshot paths to stdout for the shell loop to process
    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<WATCH_SCRIPT &
import { connect } from "@/client.js";
import { execFileSync } from "child_process";
import * as fs from "fs";

const screenshotPath = "${screenshot_path}";
const designPath = "${design_path}";
const interval = ${interval} * 1000;
const designCompare = "${DESIGN_COMPARE}";

// Connect ONCE to the persistent dev-browser server
const client = await connect("http://localhost:${SERVER_PORT}");

const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
if (!pages.includes(pageName)) {
    console.error("Page '" + "${page_name}" + "' not found");
    console.error("Available:", pages.join(", "));
    process.exit(1);
}

// Get page handle ONCE - reuse for all screenshots
const page = await client.page(pageName);

let lastScore = "";
let lastChangeTime = Date.now();
let iteration = 0;
let prevScreenshotData: Buffer | null = null;

// Watch loop - single connection, single page
while (true) {
    iteration++;

    try {
        // Take screenshot using persistent page connection
        await page.screenshot({ path: screenshotPath });

        // Read current screenshot
        const currData = fs.readFileSync(screenshotPath);

        // Check if changed (simple byte comparison for speed)
        let runCompare = false;
        if (!prevScreenshotData) {
            runCompare = true;
        } else if (Buffer.compare(currData, prevScreenshotData) !== 0) {
            runCompare = true;
            lastChangeTime = Date.now();
        }

        if (runCompare) {
            // Run design comparison using execFileSync (safe, no shell injection)
            try {
                const result = execFileSync(
                    "timeout",
                    ["60", designCompare, designPath, screenshotPath, "--json", "--no-clip"],
                    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
                );
                const json = JSON.parse(result);
                const newScore = (json.similarity?.combined || 0).toFixed(1);

                // Calculate change indicator
                let changeIndicator = "";
                if (lastScore) {
                    const diff = parseFloat(newScore) - parseFloat(lastScore);
                    if (Math.abs(diff) >= 0.1) {
                        changeIndicator = diff > 0 ? \` ↑ +\${diff.toFixed(1)}\` : \` ↓ \${diff.toFixed(1)}\`;
                    }
                }
                lastScore = newScore;

                // Time since last change
                const elapsed = Math.floor((Date.now() - lastChangeTime) / 1000);
                const timeStr = elapsed < 60 ? \`\${elapsed}s ago\` : \`\${Math.floor(elapsed / 60)}m ago\`;

                // Clear line and print status
                process.stdout.write(\`\\r\\x1b[K📊 Score: \${newScore}%\${changeIndicator} | Changed: \${timeStr} | #\${iteration}\`);
            } catch (e) {
                process.stdout.write(\`\\r\\x1b[K⚠️  Compare failed, retrying... #\${iteration}\`);
            }
        } else {
            // No change - just update display
            const elapsed = Math.floor((Date.now() - lastChangeTime) / 1000);
            const timeStr = elapsed < 60 ? \`\${elapsed}s ago\` : \`\${Math.floor(elapsed / 60)}m ago\`;
            process.stdout.write(\`\\r\\x1b[K📊 Score: \${lastScore}% | Changed: \${timeStr} | #\${iteration} (no change)\`);
        }

        prevScreenshotData = currData;

    } catch (e) {
        process.stdout.write(\`\\r\\x1b[K⚠️  Screenshot failed: \${e} #\${iteration}\`);
    }

    // Wait for next interval
    await new Promise(r => setTimeout(r, interval));
}
WATCH_SCRIPT
    local tsx_pid=$!
    echo $tsx_pid > "$tsx_pid_file"

    # Wait for the tsx process (will be killed by trap on Ctrl+C)
    wait $tsx_pid 2>/dev/null || true
}
