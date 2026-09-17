/** Failures that cannot improve by repeating the same paid request. */
export class PermanentPipelineError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "PermanentPipelineError";
  }
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const typed = error as Error & { status?: number; retryable?: boolean };
  if (typed.retryable !== undefined) return typed.retryable;
  if (typeof typed.status === "number") {
    return [408, 409, 429].includes(typed.status) || typed.status >= 500;
  }
  if (error.name === "MissingEnvError" || error.name === "SyntaxError") return false;
  return /timeout|timed out|network|fetch failed|connection|ECONN|socket|temporar|rate limit/i.test(error.message)
    || ["AbortError", "TimeoutError", "APIConnectionError", "APIConnectionTimeoutError"].includes(error.name);
}
