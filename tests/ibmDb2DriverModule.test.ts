import type { Database } from 'ibm_db';
import { expect, it, vi } from 'vitest';

import { executeStatement } from '../src/db2/executeStatement.js';

it('reads CLI macros from the real installed CJS driver module without opening a database connection', async () => {
  // Deliberately do not mock ibm_db: a named-export-only mock hides Node's CJS macro boundary.
  const driver = await import('ibm_db');
  expect(typeof driver.open).toBe('function');
  const result = {
    fetchAll: (callback: (error: unknown, rows: unknown[], columns: number) => void) => callback(null, [{ ID: 1 }], 1),
    moreResultsSync: () => false,
    close: vi.fn(async () => {})
  };
  const statement = {
    setAttr: vi.fn(async () => {}),
    prepare: vi.fn(async () => {}),
    execute: vi.fn(async () => result),
    close: vi.fn(async () => {})
  };
  const database = {
    conn: { createStatement: (callback: (error: unknown, value: unknown) => void) => callback(null, statement) }
  } as unknown as Database;

  expect(await executeStatement(database, 'VALUES 1', [], 1200000)).toEqual([{ ID: 1 }]);
  expect(statement.setAttr).toHaveBeenCalledWith(0, 1200);
  expect(statement.close).toHaveBeenCalledOnce();
});
