// Get ARIA accessibility snapshot with refs for element discovery
// Usage: aria
// Output: YAML tree with [ref=eN] markers for interactive elements
const prefix = process.env.PROJECT_PREFIX || "dev";
const pageName = process.env.PAGE_NAME || "main";
const fullPageName = `${prefix}-${pageName}`;

const snapshot = await client.getAISnapshot(fullPageName);

if (!snapshot) {
    console.error("Could not get ARIA snapshot. Navigate first: goto <url>");
    process.exit(1);
}

// Output YAML snapshot with refs
console.log(snapshot);
