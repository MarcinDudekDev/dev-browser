import type { Page, Locator } from "playwright";

// Track last known mouse position per page
const mousePositions = new WeakMap<Page, { x: number; y: number }>();

// Idle interval handles per page
const idleIntervals = new WeakMap<Page, ReturnType<typeof setTimeout>>();

function getLastPos(page: Page): { x: number; y: number } {
  let pos = mousePositions.get(page);
  if (!pos) {
    // Random starting position in typical viewport area
    pos = { x: 200 + Math.random() * 600, y: 150 + Math.random() * 400 };
    mousePositions.set(page, pos);
  }
  return pos;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Cubic bezier interpolation with 2 control points
function cubicBezier(
  p0: number, p1: number, p2: number, p3: number, t: number
): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Easing: accelerate at start, decelerate at end
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Move mouse along a natural cubic bezier curve to target position.
 * 20-40 intermediate points with acceleration/deceleration.
 * 30% chance of overshoot with correction.
 */
export async function humanMouseMove(
  page: Page, targetX: number, targetY: number
): Promise<void> {
  const start = getLastPos(page);
  const dx = targetX - start.x;
  const dy = targetY - start.y;

  // 2 random control points offset from straight line
  const perpX = -dy; // perpendicular direction
  const perpY = dx;
  const len = Math.sqrt(perpX * perpX + perpY * perpY) || 1;
  const normPx = perpX / len;
  const normPy = perpY / len;

  const offset1 = randomBetween(50, 150) * (Math.random() > 0.5 ? 1 : -1);
  const offset2 = randomBetween(50, 150) * (Math.random() > 0.5 ? 1 : -1);

  const cp1x = lerp(start.x, targetX, 0.33) + normPx * offset1;
  const cp1y = lerp(start.y, targetY, 0.33) + normPy * offset1;
  const cp2x = lerp(start.x, targetX, 0.66) + normPx * offset2;
  const cp2y = lerp(start.y, targetY, 0.66) + normPy * offset2;

  const steps = Math.round(randomBetween(20, 40));

  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;
    const t = easeInOutCubic(rawT);
    const x = cubicBezier(start.x, cp1x, cp2x, targetX, t);
    const y = cubicBezier(start.y, cp1y, cp2y, targetY, t);
    await page.mouse.move(x, y);
    await sleep(randomBetween(2, 8));
  }

  // 30% chance of overshoot
  if (Math.random() < 0.3) {
    const ovX = targetX + randomBetween(5, 15) * (Math.random() > 0.5 ? 1 : -1);
    const ovY = targetY + randomBetween(5, 15) * (Math.random() > 0.5 ? 1 : -1);
    await page.mouse.move(ovX, ovY);
    await sleep(randomBetween(30, 80));
    // Correct back
    const corrSteps = Math.round(randomBetween(3, 6));
    for (let i = 1; i <= corrSteps; i++) {
      const t = i / corrSteps;
      await page.mouse.move(lerp(ovX, targetX, t), lerp(ovY, targetY, t));
      await sleep(randomBetween(2, 5));
    }
  }

  mousePositions.set(page, { x: targetX, y: targetY });
  // Debug: uncomment to trace mouse paths
  // console.log(`[stealth-mouse] move: (${start.x.toFixed(0)},${start.y.toFixed(0)}) → (${targetX.toFixed(0)},${targetY.toFixed(0)}), ${steps} steps`);
}

/**
 * Small random micro-movements simulating idle hand jitter.
 */
export async function humanMouseIdle(page: Page): Promise<void> {
  const pos = getLastPos(page);
  const newX = pos.x + randomBetween(-10, 10);
  const newY = pos.y + randomBetween(-10, 10);
  // Clamp to reasonable viewport bounds
  const x = Math.max(5, Math.min(newX, 1270));
  const y = Math.max(5, Math.min(newY, 750));
  try {
    await page.mouse.move(x, y);
    mousePositions.set(page, { x, y });
    // Debug: uncomment to trace idle jitter
    // console.log(`[stealth-mouse] idle: (${pos.x.toFixed(0)},${pos.y.toFixed(0)}) → (${x.toFixed(0)},${y.toFixed(0)})`);
  } catch {
    // Page may have been closed
  }
}

/**
 * Get the center coordinates of an element from its locator.
 */
export async function getElementCenter(
  locator: Locator
): Promise<{ x: number; y: number }> {
  // Use a short timeout - if element isn't quickly visible, skip mouse movement
  const box = await Promise.race([
    locator.boundingBox(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
  if (!box) throw new Error("Element not visible or has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Start idle mouse jitter on a page (every 2-5s, randomized).
 * Returns cleanup function.
 */
export function startIdleMovement(page: Page): void {
  stopIdleMovement(page);
  const scheduleNext = () => {
    const delay = randomBetween(2000, 5000);
    const handle = setTimeout(async () => {
      await humanMouseIdle(page);
      scheduleNext();
    }, delay);
    idleIntervals.set(page, handle);
  };
  scheduleNext();
}

/**
 * Stop idle mouse jitter on a page.
 */
export function stopIdleMovement(page: Page): void {
  const handle = idleIntervals.get(page);
  if (handle) {
    clearTimeout(handle);
    idleIntervals.delete(page);
  }
}
