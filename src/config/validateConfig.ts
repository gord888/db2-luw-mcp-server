import { AppError } from '../errors/AppError.js';
import type { ProcedureAllowlistEntry } from './types.js';

export function parseProcedureAllowlist(raw: string): ProcedureAllowlistEntry[] {
  const entries = raw.split(',').filter((entry) => entry.trim().length > 0);

  if (entries.length === 0) {
    return [];
  }

  return entries.map((entry) => {
    const parts = entry.trim().split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AppError(
        'CONFIG_INVALID',
        `Invalid procedure allowlist entry "${entry.trim()}". Expected format: SCHEMA.NAME`,
        500
      );
    }
    return { schema: parts[0].trim(), name: parts[1].trim() };
  });
}
