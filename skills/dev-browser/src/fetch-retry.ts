// DevTools HTTP probe with bounded retries (extracted from index.ts 2026-09-29
// so tests can import it without pulling in playwright/express).
//
// WHY the per-attempt timeout (issue #4, round-2 review SHOULD-FIX 1): a spawned
// Chrome that accepts the TCP connection but never answers DevTools HTTP parked
// each bare fetch() on undici's ~300s headers timeout. Times up to 30 retries
// that meant launchBrowserContext effectively never returned — relaunchInFlight
// never settled and every POST /pages hung with no 503.
//
// attemptTimeoutMs bounds the WHOLE attempt: AbortSignal.timeout governs the
// response body stream too, and the .json() read happens inside the timed
// window, so a "headers arrive, body stalls" endpoint cannot slip past the
// bound either.
//
// Worst case per call = maxRetries x attemptTimeoutMs
//                     + delayMilliseconds x (1 + 2 + ... + maxRetries-1).
// index.ts call sites: quiet path 30 x 2000 + 100x435 = ~103.5s,
// persistent/user paths 5 x 2000 + 500x10 = ~15s (was: up to ~2.5h of hanging).
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 2000;

export async function fetchWithRetry<T = unknown>(
  url: string,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  delayMilliseconds: number = DEFAULT_RETRY_DELAY_MS,
  attemptTimeoutMs: number = DEFAULT_ATTEMPT_TIMEOUT_MS,
): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(attemptTimeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        await new Promise<void>((resolve: () => void): void => {
          setTimeout(resolve, delayMilliseconds * (i + 1));
        });
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}
