export interface RetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return error.message === 'fetch failed';
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  const isRetryable = options.isRetryable ?? isTransientNetworkError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      options.onRetry?.(attempt, error);
      await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error('withRetry exhausted without an attempt');
}
