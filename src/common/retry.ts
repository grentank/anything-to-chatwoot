/**
 * Run an async task with exponential backoff retries.
 *
 * `shouldRetry` decides whether a given error is retryable (e.g. network/5xx but
 * not 4xx). Delays grow as base * 2^attempt, capped at `maxDelayMs`.
 */
export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 5_000,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) {
        break;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
