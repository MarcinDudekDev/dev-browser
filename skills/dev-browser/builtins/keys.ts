// keys.ts — keyboard input fallback (fast-path .sh handles this server-side)
const args = process.env.SCRIPT_ARGS || "";
if (!args) {
  console.error("Usage: keys <text|key>");
  process.exit(1);
}

const SPECIAL_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Insert",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);
const isPress = SPECIAL_KEYS.has(args) || /^(Control|Alt|Meta|Shift)\+/.test(args);

if (isPress) {
  await page.keyboard.press(args);
  console.log(`Keys pressed: ${args}`);
} else {
  await page.keyboard.type(args);
  console.log(`Keys typed: ${args}`);
}
