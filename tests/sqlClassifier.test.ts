import { describe, expect, it } from 'vitest';

import { classifyReadOnlySql } from '../src/db2/sqlClassifier.js';
import { AppError } from '../src/errors/AppError.js';

describe('classifyReadOnlySql', () => {
  it('accepts SELECT and WITH queries', () => {
    expect(classifyReadOnlySql('select * from sysibm.sysdummy1').normalizedSql).toContain('select');
    expect(classifyReadOnlySql('with cte as (select 1 as value from sysibm.sysdummy1) select * from cte').normalizedSql).toContain('with');
  });

  it('rejects mutation SQL, semicolons, and CALL statements', () => {
    expect(() => classifyReadOnlySql('update test set value = 1')).toThrowError(AppError);
    expect(() => classifyReadOnlySql('select 1; select 2')).toThrowError(AppError);
    expect(() => classifyReadOnlySql('call APP.SAFE_PROC()')).toThrowError(AppError);
  });
});
