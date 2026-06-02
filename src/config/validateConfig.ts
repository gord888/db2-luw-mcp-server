import { AppError } from '../errors/AppError.js';
import type { ProcedureAllowlistEntry } from './types.js';

export function parseProcedureAllowlist(raw: string): ProcedureAllowlistEntry[] {
  return raw.split(',').map((entry) => {
    const [schema, name] = entry.trim().split('.');
    if (!schema || !name) {
      throw new AppError(
        'CONFIG_INVALID',
        `Invalid procedure allowlist entry "${entry.trim()}". Expected format: SCHEMA.NAME`,
        500
      );
    }
    return { schema: schema.trim(), name: name.trim() };
  });
}
