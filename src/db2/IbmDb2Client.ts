import type { Database, SQLParam } from 'ibm_db';

import { AppError } from '../errors/AppError.js';
import type {
  DatabaseMetadata,
  Db2Client,
  Db2ClientFactory,
  Db2DirectionalParameter,
  Db2Parameter,
  ExplainResult,
  MetadataOptions,
  ProcedureResult,
  QueryOptions,
  QueryResult
} from './Db2Client.js';
import type { ResolvedConfig } from '../config/types.js';
import { executeStatement } from './executeStatement.js';
import { resolveQueryTimeout } from './queryTimeout.js';

function isDirectionalParameter(parameter: Db2Parameter): parameter is Db2DirectionalParameter {
  return typeof parameter === 'object' && parameter !== null && 'direction' in parameter;
}

function normalizeScalarValue(value: Db2DirectionalParameter['value']): string | number {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return value ?? '';
}

function toSqlParam(parameter: Db2Parameter): SQLParam {
  if (!isDirectionalParameter(parameter)) {
    if (typeof parameter === 'boolean') {
      return parameter ? 1 : 0;
    }

    return parameter;
  }

  const directionMap = {
    input: 'INPUT',
    output: 'OUTPUT',
    inout: 'INOUT'
  } as const;

  return {
    ParamType: directionMap[parameter.direction],
    Data: normalizeScalarValue(parameter.value),
    DataType: parameter.sqlType,
    CType: parameter.cType,
    Length: parameter.length
  } as unknown as SQLParam;
}

function normalizeRows<T>(rows: unknown): T[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.filter((row): row is T => typeof row === 'object' && row !== null);
}

function normalizeProcedureResult(result: unknown): ProcedureResult {
  if (!Array.isArray(result)) {
    return {
      rows: [],
      rowCount: 0,
      outputParameters: {},
      warnings: []
    };
  }

  const rows: Record<string, unknown>[] = [];
  const outputValues: unknown[] = [];

  for (const item of result) {
    if (Array.isArray(item)) {
      rows.push(...normalizeRows<Record<string, unknown>>(item));
      continue;
    }

    if (typeof item === 'object' && item !== null) {
      rows.push(item as Record<string, unknown>);
      continue;
    }

    outputValues.push(item);
  }

  return {
    rows,
    rowCount: rows.length,
    outputParameters: outputValues.reduce<Record<string, unknown>>((accumulator, value, index) => {
      accumulator[`param${index + 1}`] = value;
      return accumulator;
    }, {
      values: outputValues
    }),
    warnings: []
  };
}

function formatDriverErrorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : '';
}

function executionError(error: unknown, label: string, timeoutMs: number): AppError {
  if (error instanceof AppError) return error;
  const sqlstate = typeof error === 'object' && error !== null && 'sqlstate' in error ? error.sqlstate : undefined;
  if (sqlstate === 'HYT00' || sqlstate === 'HYT01') {
    return new AppError('DB_TIMEOUT', `Db2 driver reported a timeout for ${label} (statement timeout ${resolveQueryTimeout(timeoutMs).effectiveMs}ms). This does not establish rollback of committed work.`, 504, error);
  }
  if (sqlstate === '57014' || sqlstate === 'HY008') {
    return new AppError('DB_EXECUTION_INTERRUPTED', `Db2 driver reported interruption of ${label} (SQLSTATE ${sqlstate}): timeout or external cancellation. This does not establish rollback of committed work.`, 500, error);
  }
  const message = formatDriverErrorMessage(error);
  return new AppError('DB_EXECUTION_FAILED', `Db2 execution failed for ${label}${message ? `: ${message}` : '.'}`, 500, error);
}

export class IbmDb2Client implements Db2Client {
  public constructor(private readonly connectionString: string, private readonly connectTimeoutMs = 10000) {}

  private async withDatabase<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    const ibmDb = await import('ibm_db');
    let database: Database | undefined;
    let failed = false;
    try {
      try {
        database = await ibmDb.open(this.connectionString, { connectTimeout: resolveQueryTimeout(this.connectTimeoutMs).seconds });
      } catch (error) {
        throw new AppError('DB_CONNECTION_FAILED', 'Unable to connect to Db2 within the configured login timeout or connection failed.', 500, error);
      }
      return await callback(database);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (database) {
        try { await database.close(); } catch (error) {
          if (!failed) throw new AppError('DB_EXECUTION_FAILED', 'Db2 completed execution but connection cleanup failed; do not retry writes without checking their effects.', 500, error);
        }
      }
    }
  }

  public async query<T = Record<string, unknown>>(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<QueryResult<T>> {
    resolveQueryTimeout(options.timeoutMs);
    return this.withDatabase(async (database) => {
      try {
        const rows = await executeStatement(database, sql, params.map(toSqlParam), options.timeoutMs);
        const normalizedRows = normalizeRows<T>(rows);

        return {
          columns: Object.keys(normalizedRows[0] ?? {}),
          rows: normalizedRows,
          rowCount: normalizedRows.length,
          warnings: resolveQueryTimeout(options.timeoutMs).warnings
        };
      } catch (error) {
        throw executionError(error, options.label ?? 'query', options.timeoutMs);
      }
    });
  }

  public async callProcedure(schema: string, name: string, params: Db2Parameter[], options: QueryOptions): Promise<ProcedureResult> {
    resolveQueryTimeout(options.timeoutMs);
    return this.withDatabase(async (database) => {
      const placeholders = params.map(() => '?').join(', ');
      const sql = `CALL ${schema}.${name}(${placeholders})`;

      try {
        const result = normalizeProcedureResult(await executeStatement(database, sql, params.map(toSqlParam), options.timeoutMs));
        result.warnings.push(...resolveQueryTimeout(options.timeoutMs).warnings);
        return result;
      } catch (error) {
        throw executionError(error, `procedure ${schema}.${name}`, options.timeoutMs);
      }
    });
  }

  public async getMetadata(options: MetadataOptions): Promise<DatabaseMetadata> {
    resolveQueryTimeout(options.timeoutMs);
    return this.withDatabase(async (database) => {
      try {
        const schemas = normalizeRows<{ SCHEMA: string }>(await executeStatement(database, `
          SELECT RTRIM(SCHEMANAME) AS SCHEMA
          FROM SYSCAT.SCHEMATA
          WHERE SCHEMANAME NOT LIKE 'SYS%'
          ORDER BY SCHEMANAME
          WITH UR
        `, [], options.timeoutMs));
        const tables = normalizeRows<{ SCHEMA: string; TABLE_NAME: string; TABLE_TYPE?: string }>(await executeStatement(database, `
          SELECT RTRIM(TABSCHEMA) AS SCHEMA, RTRIM(TABNAME) AS TABLE_NAME, RTRIM(TYPE) AS TABLE_TYPE
          FROM SYSCAT.TABLES
          WHERE TABSCHEMA NOT LIKE 'SYS%'
          ORDER BY TABSCHEMA, TABNAME
          FETCH FIRST 200 ROWS ONLY
          WITH UR
        `, [], options.timeoutMs));
        const procedures = normalizeRows<{ SCHEMA: string; PROCEDURE_NAME: string }>(await executeStatement(database, `
          SELECT RTRIM(ROUTINESCHEMA) AS SCHEMA, RTRIM(ROUTINENAME) AS PROCEDURE_NAME
          FROM SYSCAT.ROUTINES
          WHERE ROUTINETYPE = 'P'
          ORDER BY ROUTINESCHEMA, ROUTINENAME
          FETCH FIRST 200 ROWS ONLY
          WITH UR
        `, [], options.timeoutMs));

        return {
          schemas: schemas.map((schema) => ({ schema: schema.SCHEMA })),
          tables: tables.map((table) => ({
            schema: table.SCHEMA,
            table: table.TABLE_NAME,
            type: table.TABLE_TYPE
          })),
          procedures: procedures.map((procedure) => ({
            schema: procedure.SCHEMA,
            procedure: procedure.PROCEDURE_NAME
          }))
        };
      } catch (error) {
        throw executionError(error, 'metadata', options.timeoutMs);
      }
    });
  }

  public async explain(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<ExplainResult> {
    resolveQueryTimeout(options.timeoutMs);
    return this.withDatabase(async (database) => {
      try {
        await executeStatement(database, `EXPLAIN PLAN FOR ${sql}`, params.map(toSqlParam), options.timeoutMs);
        const rows = normalizeRows<Record<string, unknown>>(await executeStatement(database, `
          SELECT EXPLAIN_TIME, SOURCE_NAME, SOURCE_SCHEMA, QUERYTAG
          FROM EXPLAIN_STATEMENT
          ORDER BY EXPLAIN_TIME DESC
          FETCH FIRST 10 ROWS ONLY
          WITH UR
        `, [], options.timeoutMs));

        return {
          statementText: sql,
          details: rows
        };
      } catch (error) {
        throw executionError(error, 'explain', options.timeoutMs);
      }
    });
  }

  public async testConnection(): Promise<void> {
    await this.withDatabase(async (database) => {
      await executeStatement(database, 'VALUES CURRENT SERVER', [], 10000);
    });
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

export class DefaultDb2ClientFactory implements Db2ClientFactory {
  public create(config: ResolvedConfig): Db2Client {
    return new IbmDb2Client(config.connectionString);
  }
}
