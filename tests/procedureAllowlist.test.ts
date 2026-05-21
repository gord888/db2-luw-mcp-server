import { describe, expect, it } from 'vitest';

import { assertProcedureAllowlisted, isProcedureAllowlisted } from '../src/db2/procedureAllowlist.js';
import { AppError } from '../src/errors/AppError.js';

const entries = [
  {
    schema: 'APP',
    name: 'SAFE_REPORT_PROC'
  }
];

describe('procedure allowlist', () => {
  it('matches entries case-insensitively', () => {
    expect(isProcedureAllowlisted(entries, 'app', 'safe_report_proc')).toBe(true);
  });

  it('rejects procedures not on the allowlist', () => {
    expect(() => assertProcedureAllowlisted(entries, 'APP', 'DANGEROUS_PROC')).toThrowError(AppError);
  });
});
