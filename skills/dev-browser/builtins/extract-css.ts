const client = await connect();
const page = await client.page("readyforloft-prod");
await page.goto("https://readyforloft.com/");
await waitForPageLoad(page);

// Extract wp-custom-css content
const cssContent = await page.evaluate(() => {
  const styleTag = document.getElementById('wp-custom-css');
  return styleTag ? styleTag.textContent : null;
});

if (cssContent) {
  console.log("CSS_CONTENT_START");
  console.log(cssContent);
  console.log("CSS_CONTENT_END");
} else {
  console.log("wp-custom-css not found");
}

await client.disconnect();
