import { describe, expect, it } from 'vitest';

import { assertProcedureAllowlisted, isProcedureAllowlisted } from '../src/db2/procedureAllowlist.js';
import { AppError } from '../src/errors/AppError.js';

const entries = [
  {
    schema: 'SYSPROC',
    name: 'GET_DBSIZE_INFO'
  }
];

describe('procedure allowlist', () => {
  it('matches entries case-insensitively', () => {
    expect(isProcedureAllowlisted(entries, 'sysproc', 'get_dbsize_info')).toBe(true);
  });

  it('rejects procedures not on the allowlist', () => {
    expect(() => assertProcedureAllowlisted(entries, 'SYSPROC', 'DANGEROUS_PROC')).toThrowError(AppError);
  });
});
