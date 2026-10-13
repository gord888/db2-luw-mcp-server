import { AppError } from '../errors/AppError.js';

// Representation limit of the driver's signed integer attribute value, not a policy cap.
export const MAX_QUERY_TIMEOUT_MS = 2_147_483_647 * 1000;

export function resolveQueryTimeout(timeoutMs: number): { seconds: number; effectiveMs: number; warnings: string[] } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_QUERY_TIMEOUT_MS) {
    throw new AppError('VALIDATION_ERROR', `Query timeout must be a positive integer no greater than ${MAX_QUERY_TIMEOUT_MS} milliseconds.`, 400);
  }

  const seconds = Math.ceil(timeoutMs / 1000);
  const effectiveMs = seconds * 1000;
  return {
    seconds,
    effectiveMs,
    warnings: effectiveMs === timeoutMs ? [] : [`Db2 CLI rounded the requested timeout up to ${effectiveMs}ms (whole seconds).`]
  };
}
