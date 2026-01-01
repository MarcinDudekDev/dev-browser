// Navigate to URL
const client = await connect();
const page = await client.page("main");
const url = process.env.SCRIPT_ARGS || process.argv[2] || "about:blank";
await page.goto(url);
await waitForPageLoad(page);
console.log({ url: page.url(), title: await page.title() });
await client.disconnect();
