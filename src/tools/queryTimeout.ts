import { z } from 'zod/v4';

import { MAX_QUERY_TIMEOUT_MS, resolveQueryTimeout } from '../db2/queryTimeout.js';

export const queryTimeoutSchema = z.number().int().positive().max(MAX_QUERY_TIMEOUT_MS).optional()
  .describe('Db2 statement timeout in milliseconds. Defaults to the server query timeout; longer values are allowed. Rounded up to whole seconds.');

export function effectiveQueryTimeout(queryTimeoutMs: number | undefined, defaultMs: number): number {
  return resolveQueryTimeout(queryTimeoutMs ?? defaultMs).effectiveMs;
}
