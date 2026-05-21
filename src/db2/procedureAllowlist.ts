import type { ProcedureAllowlistEntry } from '../config/types.js';
import { AppError } from '../errors/AppError.js';
import { normalizeIdentifier } from './identifiers.js';

function buildProcedureKey(schema: string, name: string): string {
  return `${normalizeIdentifier(schema)}.${normalizeIdentifier(name)}`;
}

export function isProcedureAllowlisted(entries: ProcedureAllowlistEntry[], schema: string, name: string): boolean {
  const requestedKey = buildProcedureKey(schema, name);

  return entries.some((entry) => buildProcedureKey(entry.schema, entry.name) === requestedKey);
}

export function assertProcedureAllowlisted(entries: ProcedureAllowlistEntry[], schema: string, name: string): void {
  if (!isProcedureAllowlisted(entries, schema, name)) {
    throw new AppError(
      'PROCEDURE_NOT_ALLOWLISTED',
      `Procedure ${normalizeIdentifier(schema)}.${normalizeIdentifier(name)} is not allowlisted for this profile.`,
      403
    );
  }
}
