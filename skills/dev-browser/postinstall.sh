#!/bin/bash
# Patch Playwright to use native ws in Bun instead of bundled ws.
# Bun's HTTP client doesn't support protocol upgrades, so Playwright's
# bundled ws (which relies on Node's http upgrade event) silently fails.
# Native ws in Bun works fine. See: https://github.com/oven-sh/bun/issues/9911
UTILS="node_modules/playwright-core/lib/utilsBundle.js"
if [[ -f "$UTILS" ]] && ! grep -q "'Bun' in globalThis" "$UTILS"; then
    sed -i.bak 's|const ws = require("./utilsBundleImpl").ws;|const ws = '"'"'Bun'"'"' in globalThis ? require("ws") : require("./utilsBundleImpl").ws;|' "$UTILS"
    rm -f "$UTILS.bak"
    echo "Patched Playwright ws for Bun compatibility"
fi
