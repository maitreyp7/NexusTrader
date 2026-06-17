import { RETRY } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// RETRY.TS — Exponential backoff retry utility
//
// Every external API call in this system goes through this function.
// If an API fails, it waits and tries again — up to maxAttempts times.
// The wait time doubles each attempt: 1s → 2s → 4s (exponential backoff).
// This prevents hammering a struggling API and getting permanently blocked.
// ─────────────────────────────────────────────────────────────────────────────

export async function retry<T>(
  label: string,           // Human-readable name for logging (e.g. "Binance price fetch")
  fn: () => Promise<T>,    // The async function to retry
): Promise<T> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;

      // Non-retryable errors: retrying a 400/404 will always fail — fail fast.
      // 400 = bad request (our bug), 401 = auth error, 403 = forbidden, 404 = not found.
      if (/HTTP (400|401|403|404)/.test(msg)) {
        throw new Error(`[retry] ${label} — non-retryable error, aborting: ${msg}`);
      }

      // Rate limit (429): API explicitly says to slow down.
      // Wait 60s rather than the normal short backoff, then fail — don't burn all retries.
      if (/HTTP 429/.test(msg)) {
        console.warn(`[retry] ${label} — rate limited (429). Waiting 60s before one final retry...`);
        await sleep(60_000);
        try { return await fn(); } catch (retryErr) {
          throw new Error(`[retry] ${label} — still rate limited after 60s wait: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
        }
      }

      if (attempt === RETRY.maxAttempts) break;

      // Exponential backoff with ±25% jitter — prevents thundering herd when
      // multiple symbols retry simultaneously after a shared API failure.
      const baseDelay = Math.min(
        RETRY.baseDelayMs * Math.pow(2, attempt - 1),
        RETRY.maxDelayMs,
      );
      const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1); // ±25%
      const delay  = Math.round(baseDelay + jitter);

      console.warn(`[retry] ${label} failed (attempt ${attempt}/${RETRY.maxAttempts}): ${msg}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw new Error(`[retry] ${label} failed after ${RETRY.maxAttempts} attempts: ${lastError.message}`);
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
