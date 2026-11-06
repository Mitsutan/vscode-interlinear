/**
 * Retries an asynchronous operation with exponential backoff.
 *
 * The delay doubles after each failed attempt, starting from `baseDelayMs`,
 * and a random jitter is added so that many clients do not retry in lockstep.
 *
 * @param operation - The function to call. It is retried while it throws.
 * @param maxAttempts - How many times to try before giving up.
 * @param baseDelayMs - The delay before the first retry, in milliseconds.
 * @returns The value returned by the first successful attempt.
 * @throws The last error, if every attempt fails.
 */
export async function retry<T>(operation: () => Promise<T>, maxAttempts = 5, baseDelayMs = 200): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Do not wait after the last attempt; there is nothing left to retry.
      if (attempt === maxAttempts - 1) break;
      const jitter = Math.random() * baseDelayMs; // spread out retries from many clients
      await sleep(baseDelayMs * 2 ** attempt + jitter);
    }
  }
  throw lastError;
}

/** Resolves after the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Settings are logged as JSON so that they can be pasted into a bug report as is.
export function describeSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2); // a two-space indent keeps the log readable
}
