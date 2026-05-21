import { describe, expect, it } from 'vitest';

import { buildPagingResult, normalizeLimit } from '../src/db2/sqlPaging.js';

describe('sqlPaging', () => {
  it('caps limits at 1000 rows', () => {
    const result = normalizeLimit(2000, 1000);

    expect(result.limit).toBe(1000);
    expect(result.warnings[0]).toContain('capped');
  });

  it('returns truncation metadata when more rows exist', () => {
    const result = buildPagingResult([
      { id: 1 },
      { id: 2 },
      { id: 3 }
    ], 2, 0, []);

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(2);
  });
});
