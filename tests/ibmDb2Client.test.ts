import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IbmDb2Client } from '../src/db2/IbmDb2Client.js';
import { MAX_QUERY_TIMEOUT_MS, resolveQueryTimeout } from '../src/db2/queryTimeout.js';

const driver = vi.hoisted(() => ({ open: vi.fn() }));
// Mirror the installed CJS module: open is named, dynamically assigned CLI macros are not.
vi.mock('ibm_db', () => ({ open: driver.open, default: { open: driver.open, SQL_ATTR_QUERY_TIMEOUT: 0 } }));

function fixture(resultSets: Array<{ rows: unknown[]; columns: number }> = [{ rows: [{ ID: 1 }], columns: 1 }], output?: unknown[]) {
  const events: string[] = [];
  let index = 0;
  const result = {
    fetchAll: vi.fn((callback: (error: unknown, rows?: unknown[], columns?: number) => void) => {
      events.push('fetch');
      callback(null, resultSets[index]?.rows ?? [], resultSets[index]?.columns ?? 0);
    }),
    moreResultsSync: vi.fn(() => { events.push('more'); return ++index < resultSets.length; }),
    close: vi.fn(async () => { events.push('cursor.close'); })
  };
  const statement = {
    setAttr: vi.fn(async () => { events.push('timeout'); }),
    prepare: vi.fn(async () => { events.push('prepare'); }),
    execute: vi.fn(async () => { events.push('execute'); return output ? [result, output] : result; }),
    close: vi.fn(async () => { events.push('statement.close'); })
  };
  const database = {
    conn: {
      createStatement: vi.fn((callback: (error: unknown, statement?: unknown) => void) => {
        events.push('create');
        callback(null, statement);
      })
    },
    close: vi.fn(async () => { events.push('connection.close'); }),
    query: vi.fn(() => { throw new Error('Untimed database.query must not be called'); })
  };
  driver.open.mockResolvedValue(database);
  return { events, result, statement, database };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('Db2 driver-enforced statement timeouts', () => {
  it('sets the timeout before preparation/execution, binds scalars, and closes all handles in order', async () => {
    const f = fixture();
    const result = await new IbmDb2Client('test-only').query('VALUES (?, ?, ?, ?)', [1, 'text', true, null], { timeoutMs: 1200000 });
    expect(driver.open).toHaveBeenCalledWith('test-only', { connectTimeout: 10 });
    expect(f.statement.setAttr).toHaveBeenCalledWith(0, 1200);
    expect(f.statement.execute).toHaveBeenCalledWith([1, 'text', 1, null]);
    expect((f.statement as typeof f.statement & { db: unknown }).db).toBe(f.database);
    expect(result).toEqual({ rows: [{ ID: 1 }], columns: ['ID'], rowCount: 1, warnings: [] });
    expect(f.events).toEqual(['create', 'timeout', 'prepare', 'execute', 'fetch', 'more', 'cursor.close', 'statement.close', 'connection.close']);
    expect(f.database.query).not.toHaveBeenCalled();
  });

  it('does not stop waiting after the old 30-second deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    f.statement.execute.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve(f.result), 35000);
      markStarted();
    }));
    let settled = false;
    const pending = new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 1200000 });
    void pending.then(() => { settled = true; });
    await started;
    await vi.advanceTimersByTimeAsync(30001);
    expect(settled).toBe(false);
    expect(f.database.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).rowCount).toBe(1);
    expect(f.statement.setAttr).toHaveBeenCalledWith(0, 1200);
  });

  it('rounds up subsecond values instead of accidentally setting unlimited execution', async () => {
    const f = fixture();
    const result = await new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 1 });
    expect(f.statement.setAttr).toHaveBeenCalledWith(0, 1);
    expect(result.warnings[0]).toContain('1000ms');
  });

  it('preserves procedure output parameters and multiple result sets', async () => {
    const f = fixture([{ rows: [{ FIRST: 1 }], columns: 1 }, { rows: [{ SECOND: 2 }], columns: 1 }], [7, 'out']);
    const result = await new IbmDb2Client('test-only').callProcedure('TEST', 'PROC', [
      { direction: 'inout', value: true, sqlType: 'INTEGER', cType: 'INTEGER', length: 4 }
    ], { timeoutMs: 45000 });
    expect(f.statement.prepare).toHaveBeenCalledWith('CALL TEST.PROC(?)');
    expect(f.statement.execute).toHaveBeenCalledWith([{ ParamType: 'INOUT', Data: 1, DataType: 'INTEGER', CType: 'INTEGER', Length: 4 }]);
    expect(result.rows).toEqual([{ FIRST: 1 }, { SECOND: 2 }]);
    expect(result.outputParameters).toEqual({ values: [7, 'out'], param1: 7, param2: 'out' });
    expect(f.result.fetchAll).toHaveBeenCalledTimes(2);
    expect(f.result.close).toHaveBeenCalledTimes(1);
    expect(f.statement.close).toHaveBeenCalledTimes(1);
  });

  it('preserves procedures without output parameters and DDL without rows', async () => {
    fixture([{ rows: [{ ID: 2 }], columns: 1 }]);
    const client = new IbmDb2Client('test-only');
    expect((await client.callProcedure('TEST', 'PROC', [], { timeoutMs: 30000 })).rows).toEqual([{ ID: 2 }]);
    fixture([{ rows: [], columns: 0 }]);
    expect((await client.query('CREATE VIEW TEST.V AS VALUES 1', [], { timeoutMs: 30000 })).rows).toEqual([]);
  });

  it.each(['HYT00', 'HYT01'])('maps driver timeout %s without claiming rollback', async (sqlstate) => {
    const f = fixture();
    f.statement.execute.mockRejectedValueOnce({ sqlstate, message: 'Driver timed out' });
    await expect(new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 60000 }))
      .rejects.toMatchObject({ code: 'DB_TIMEOUT', statusCode: 504, message: expect.stringContaining('does not establish rollback') });
    expect(f.statement.close).toHaveBeenCalledOnce();
    expect(f.database.close).toHaveBeenCalledOnce();
  });

  it.each(['57014', 'HY008'])('does not mislabel driver cancellation %s as a confirmed timeout', async (sqlstate) => {
    const f = fixture();
    f.statement.execute.mockRejectedValueOnce({ sqlstate, message: 'SQL0952N Processing cancelled. SQLSTATE=57014' });
    await expect(new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 60000 }))
      .rejects.toMatchObject({ code: 'DB_EXECUTION_INTERRUPTED', message: expect.stringContaining(`SQLSTATE ${sqlstate}`) });
  });

  it.each(['setAttr', 'prepare', 'execute'] as const)('closes the statement after %s fails and does not execute untimed SQL', async (stage) => {
    const f = fixture();
    f.statement[stage].mockRejectedValueOnce({ sqlstate: 'HY000', message: 'Failure' });
    await expect(new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 60000 }))
      .rejects.toMatchObject({ code: 'DB_EXECUTION_FAILED' });
    expect(f.statement.close).toHaveBeenCalledOnce();
    expect(f.database.close).toHaveBeenCalledOnce();
    if (stage !== 'execute') expect(f.statement.execute).not.toHaveBeenCalled();
  });

  it('closes cursor and statement on fetch failure, preserving the primary error', async () => {
    const f = fixture();
    f.result.fetchAll.mockImplementationOnce((callback) => callback({ sqlstate: 'HYT00' }));
    f.result.close.mockRejectedValueOnce(new Error('Cursor cleanup failed'));
    f.statement.close.mockRejectedValueOnce(new Error('Statement cleanup failed'));
    f.database.close.mockRejectedValueOnce(new Error('Connection cleanup failed'));
    await expect(new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 60000 })).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    expect(f.result.close).toHaveBeenCalledOnce();
    expect(f.statement.close).toHaveBeenCalledOnce();
    expect(f.database.close).toHaveBeenCalledOnce();
  });

  it('closes all handles when advancing results fails', async () => {
    const f = fixture();
    f.result.moreResultsSync.mockImplementationOnce(() => { throw { sqlstate: 'HYT00' }; });
    await expect(new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 60000 })).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    expect(f.result.close).toHaveBeenCalledOnce();
    expect(f.statement.close).toHaveBeenCalledOnce();
    expect(f.database.close).toHaveBeenCalledOnce();
  });

  it('does not report success if connection cleanup fails', async () => {
    const f = fixture();
    f.database.close.mockRejectedValueOnce(new Error('close failed'));
    await expect(new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 60000 }))
      .rejects.toMatchObject({ code: 'DB_EXECUTION_FAILED', message: expect.stringContaining('completed execution') });
  });

  it('reports connection failures separately, without opening an untimed statement', async () => {
    driver.open.mockRejectedValueOnce({ sqlstate: '08001' });
    await expect(new IbmDb2Client('test-only').query('VALUES 1', [], { timeoutMs: 60000 })).rejects.toMatchObject({ code: 'DB_CONNECTION_FAILED' });
  });

  it('applies timeouts to every explain/metadata statement and connection health probe', async () => {
    const f = fixture([{ rows: [], columns: 0 }]);
    const client = new IbmDb2Client('test-only');
    await client.explain('VALUES ?', [1], { timeoutMs: 120000 });
    expect(f.statement.setAttr).toHaveBeenCalledTimes(2);
    expect(f.statement.setAttr).toHaveBeenLastCalledWith(0, 120);
    await client.getMetadata({ timeoutMs: 15000 });
    expect(f.statement.setAttr).toHaveBeenCalledTimes(5);
    expect(f.statement.setAttr).toHaveBeenLastCalledWith(0, 15);
    await client.testConnection();
    expect(f.statement.setAttr).toHaveBeenLastCalledWith(0, 10);
  });

  it('does not start subsequent explain statements after a timeout', async () => {
    const f = fixture();
    f.statement.execute.mockRejectedValueOnce({ sqlstate: 'HYT00' });
    await expect(new IbmDb2Client('test-only').explain('VALUES 1', [], { timeoutMs: 60000 })).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    expect(f.statement.prepare).toHaveBeenCalledOnce();
  });
});

describe('timeout representation boundaries', () => {
  it.each([0, -1, 1.5, NaN, Infinity, MAX_QUERY_TIMEOUT_MS + 1])('rejects invalid timeout %s', (timeout) => {
    expect(() => resolveQueryTimeout(timeout)).toThrow();
  });
  it('allows the driver maximum without a new policy cap', () => {
    expect(resolveQueryTimeout(MAX_QUERY_TIMEOUT_MS).seconds).toBe(2147483647);
  });
});
