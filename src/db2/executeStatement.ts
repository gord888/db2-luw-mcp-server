import type { Database, ODBCResult, ODBCStatement, SQLParam } from 'ibm_db';

import { AppError } from '../errors/AppError.js';
import { resolveQueryTimeout } from './queryTimeout.js';

/** Equivalent result collection to ibm_db 4.0.1 Database.query, with a timed statement. */
export async function executeStatement(database: Database, sql: string, params: SQLParam[], timeoutMs: number): Promise<unknown[]> {
  const { seconds } = resolveQueryTimeout(timeoutMs);
  // ibm_db is CommonJS. Its dynamically copied CLI macros are on the default export,
  // not Node's synthesized ESM named exports (unlike open, which is a named export).
  const ibmDb = (await import('ibm_db')).default as unknown as typeof import('ibm_db');
  if (!Number.isInteger(ibmDb.SQL_ATTR_QUERY_TIMEOUT)) {
    throw new AppError('DB_EXECUTION_FAILED', 'The installed Db2 driver does not expose SQL_ATTR_QUERY_TIMEOUT.');
  }
  if (!database.conn) {
    throw new AppError('DB_CONNECTION_FAILED', 'Db2 connection is not available.');
  }

  const statement = await new Promise<ODBCStatement>((resolve, reject) => {
    database.conn!.createStatement((error, value) => error ? reject(error) : resolve(value));
  });
  // The driver's prepared-statement wrappers require this back-reference for error handling.
  // Database.prepare sets it too, but prepares before we can configure the timeout.
  (statement as ODBCStatement & { db: Database }).db = database;
  let result: ODBCResult | undefined;
  let failed = false;

  try {
    await statement.setAttr(ibmDb.SQL_ATTR_QUERY_TIMEOUT, seconds);
    await statement.prepare(sql);
    const execution = await statement.execute(params.length ? params : undefined);
    const outputParameters = Array.isArray(execution) ? execution[1] : undefined;
    result = (Array.isArray(execution) ? execution[0] : execution) ?? undefined;
    const collected: unknown[] = outputParameters ? [...outputParameters] : [];
    let multipleResults = Boolean(outputParameters);

    if (!result) return collected;

    for (;;) {
      const activeResult = result;
      const { rows, columnCount } = await new Promise<{ rows: unknown[]; columnCount: number }>((resolve, reject) => {
        activeResult.fetchAll((error, rows, columnCount) => {
          if (error) reject(error);
          else resolve({ rows: rows ?? [], columnCount });
        });
      });
      const more = result.moreResultsSync();
      if (more) {
        collected.push(rows);
        multipleResults = true;
      } else {
        if (columnCount) {
          if (multipleResults) collected.push(rows);
          else collected.push(...rows);
        }
        return collected;
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A prepared statement owns the native handle; its result only owns the cursor.
    // Attempt both closes, preserving the execution error if cleanup also fails.
    let cleanupError: unknown;
    try { await result?.close(); } catch (error) { cleanupError = error; }
    try { await statement.close(); } catch (error) { cleanupError ??= error; }
    if (!failed && cleanupError) throw cleanupError;
  }
}
