// Evaluate JavaScript in page context
const code = process.env.SCRIPT_ARGS || "";
if (!code) {
    console.error("Usage: dev-browser.sh --run eval 'document.title'");
    process.exit(1);
}

const client = await connect();
const page = await client.page("main");
const result = await page.evaluate(code);
console.log(JSON.stringify(result, null, 2));
await client.disconnect();
