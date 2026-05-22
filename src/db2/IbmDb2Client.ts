import type { Database, SQLParam } from 'ibm_db';

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
import type { ResolvedProfileConfig } from '../config/types.js';
import { AppError } from '../errors/AppError.js';

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
  if (!(error instanceof Error)) {
    return '';
  }

  return error.message;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new AppError('DB_TIMEOUT', `DB2 operation exceeded ${timeoutMs}ms.`, 504));
      }, timeoutMs);
    });

    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export class IbmDb2Client implements Db2Client {
  public constructor(private readonly connectionString: string) {}

  private async withDatabase<T>(callback: (database: Database) => Promise<T>, timeoutMs: number): Promise<T> {
    const operation = (async () => {
      const ibmDb = await import('ibm_db');
      let database: Database | undefined;

      try {
        database = await ibmDb.open(this.connectionString);
        return await callback(database);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        throw new AppError('DB_CONNECTION_FAILED', 'Unable to connect to DB2.', 500, error);
      } finally {
        if (database) {
          await database.close().catch(() => undefined);
        }
      }
    })();

    return withTimeout(operation, timeoutMs);
  }

  public async query<T = Record<string, unknown>>(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<QueryResult<T>> {
    return this.withDatabase(async (database) => {
      try {
        const rows = await database.query(sql, params.map(toSqlParam));
        const normalizedRows = normalizeRows<T>(rows);

        return {
          columns: Object.keys(normalizedRows[0] ?? {}),
          rows: normalizedRows,
          rowCount: normalizedRows.length,
          warnings: []
        };
      } catch (error) {
        const driverMessage = formatDriverErrorMessage(error);
        throw new AppError(
          'DB_EXECUTION_FAILED',
          driverMessage
            ? `DB2 query failed for ${options.label ?? 'query'}: ${driverMessage}`
            : `DB2 query failed for ${options.label ?? 'query'}.`,
          500,
          error
        );
      }
    }, options.timeoutMs);
  }

  public async callProcedure(schema: string, name: string, params: Db2Parameter[], options: QueryOptions): Promise<ProcedureResult> {
    return this.withDatabase(async (database) => {
      const placeholders = params.map(() => '?').join(', ');
      const sql = `CALL ${schema}.${name}(${placeholders})`;

      try {
        return normalizeProcedureResult(await database.query(sql, params.map(toSqlParam)));
      } catch (error) {
        const driverMessage = formatDriverErrorMessage(error);
        throw new AppError(
          'DB_EXECUTION_FAILED',
          driverMessage
            ? `Stored procedure ${schema}.${name} failed: ${driverMessage}`
            : `Stored procedure ${schema}.${name} failed.`,
          500,
          error
        );
      }
    }, options.timeoutMs);
  }

  public async getMetadata(options: MetadataOptions): Promise<DatabaseMetadata> {
    return this.withDatabase(async (database) => {
      try {
        const schemas = normalizeRows<{ SCHEMA: string }>(await database.query(`
          SELECT RTRIM(SCHEMANAME) AS SCHEMA
          FROM SYSCAT.SCHEMATA
          WHERE SCHEMANAME NOT LIKE 'SYS%'
          ORDER BY SCHEMANAME
          WITH UR
        `));
        const tables = normalizeRows<{ SCHEMA: string; TABLE_NAME: string; TABLE_TYPE?: string }>(await database.query(`
          SELECT RTRIM(TABSCHEMA) AS SCHEMA, RTRIM(TABNAME) AS TABLE_NAME, RTRIM(TYPE) AS TABLE_TYPE
          FROM SYSCAT.TABLES
          WHERE TABSCHEMA NOT LIKE 'SYS%'
          ORDER BY TABSCHEMA, TABNAME
          FETCH FIRST 200 ROWS ONLY
          WITH UR
        `));
        const procedures = normalizeRows<{ SCHEMA: string; PROCEDURE_NAME: string }>(await database.query(`
          SELECT RTRIM(ROUTINESCHEMA) AS SCHEMA, RTRIM(ROUTINENAME) AS PROCEDURE_NAME
          FROM SYSCAT.ROUTINES
          WHERE ROUTINETYPE = 'P'
          ORDER BY ROUTINESCHEMA, ROUTINENAME
          FETCH FIRST 200 ROWS ONLY
          WITH UR
        `));

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
        throw new AppError('DB_EXECUTION_FAILED', 'Unable to retrieve DB2 metadata.', 500, error);
      }
    }, options.timeoutMs);
  }

  public async explain(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<ExplainResult> {
    return this.withDatabase(async (database) => {
      try {
        await database.query(`EXPLAIN PLAN FOR ${sql}`, params.map(toSqlParam));
        const rows = normalizeRows<Record<string, unknown>>(await database.query(`
          SELECT EXPLAIN_TIME, SOURCE_NAME, SOURCE_SCHEMA, QUERYTAG
          FROM EXPLAIN_STATEMENT
          ORDER BY EXPLAIN_TIME DESC
          FETCH FIRST 10 ROWS ONLY
          WITH UR
        `));

        return {
          statementText: sql,
          details: rows
        };
      } catch (error) {
        throw new AppError('DB_EXECUTION_FAILED', 'Unable to explain the SQL statement.', 500, error);
      }
    }, options.timeoutMs);
  }

  public async testConnection(): Promise<void> {
    await this.withDatabase(async (database) => {
      await database.query('VALUES CURRENT SERVER');
    }, 10000);
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

export class DefaultDb2ClientFactory implements Db2ClientFactory {
  public create(profile: ResolvedProfileConfig): Db2Client {
    return new IbmDb2Client(profile.db.connectionString);
  }
}
