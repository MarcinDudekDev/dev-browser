// Take screenshot of current page
const page_name = process.env.SCRIPT_ARGS?.split(" ")[0] || "main";
const path = process.env.SCRIPT_ARGS?.split(" ").slice(1).join(" ") ||
    `${process.env.HOME}/Tools/output/screenshots/screenshot-${Date.now()}.png`;

const client = await connect();
const page = await client.page(page_name);
await page.screenshot({ path, fullPage: true });
console.log("Screenshot saved:", path);
await client.disconnect();
