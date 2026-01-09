#!/bin/bash
# Page inspection commands

cmd_inspect() {
    local page_name="${1:-main}"
    start_server || return 1
    local PREFIX=$(get_project_prefix)

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<INSPECT_SCRIPT
import { connect } from "@/client.js";

const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p.replace("${PREFIX}-", "")));
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

const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const pages = await client.list();
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
        echo "Watching console for page '${page_name}' (timeout: ${timeout_sec}s)..."
    else
        echo "Watching console for page '${page_name}' (Ctrl+C to stop)..."
    fi

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<CONSOLE_SCRIPT
import { connect } from "@/client.js";

const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const timeoutSec = ${timeout_sec};
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p.replace("${PREFIX}-", "")));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);
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
