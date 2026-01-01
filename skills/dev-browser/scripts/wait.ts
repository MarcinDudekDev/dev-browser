// Wait for selector or text to appear
const target = process.env.SCRIPT_ARGS || "";
if (!target) {
    console.error("Usage: dev-browser.sh --run wait 'selector or text'");
    process.exit(1);
}

const client = await connect();
const page = await client.page("main");

try {
    // Try as selector first
    await page.locator(target).first().waitFor({ timeout: 30000 });
    console.log("Found selector:", target);
} catch {
    // Try as text
    await page.getByText(target).first().waitFor({ timeout: 30000 });
    console.log("Found text:", target);
}

await client.disconnect();
