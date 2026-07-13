// Universal async failsafe. Wraps a fragile async operation (HTML5 Canvas
// work, a storage upload, an RPC call) so it can never hang the caller
// forever — the concrete failure mode this exists for is iOS Safari
// occasionally stalling a canvas.toBlob()/fetch() call indefinitely, which
// previously left users stuck on a disabled "Next" button with no way
// forward. Every wrapped operation resolves within `timeoutMs` one way or
// another: either with the real result, with a caller-supplied fallback
// value, or by throwing a friendly, catchable error.

export class TimeoutFallbackError extends Error {
  constructor(message = 'This is taking longer than expected. Please check your connection and try again.') {
    super(message);
    this.name = 'TimeoutFallbackError';
  }
}

interface WithTimeoutFallbackOptions<T> {
  /** Milliseconds to wait before giving up on the wrapped promise. Defaults to 8s. */
  timeoutMs?: number;
  /** Called only if the operation times out. Its result is returned instead of throwing. */
  fallback?: () => T | Promise<T>;
  /** Friendly message attached to the thrown error when there's no fallback. */
  timeoutMessage?: string;
}

export async function withTimeoutFallback<T>(
  promise: Promise<T>,
  options: WithTimeoutFallbackOptions<T> = {}
): Promise<T> {
  const { timeoutMs = 8000, fallback, timeoutMessage } = options;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutFallbackError(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } catch (err) {
    if (timedOut) {
      // The original operation may still resolve/reject later, after we've
      // already moved on — swallow that so it can't surface as an
      // unhandled promise rejection.
      promise.catch(() => {});
      if (fallback) return await fallback();
      throw err;
    }
    throw err;
  } finally {
    clearTimeout(timer!);
  }
}
