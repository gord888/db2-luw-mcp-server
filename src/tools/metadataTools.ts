import { z } from 'zod/v4';

import { buildPagingResult, normalizeLimit, wrapSqlWithPaging } from '../db2/sqlPaging.js';
import { qualifyTable } from '../db2/identifiers.js';
import type { ToolExecutionPayload, ToolServices } from './toolContext.js';
import { withDbClient } from './toolContext.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (args: any, services: ToolServices) => Promise<ToolExecutionPayload>;
}

function toUpperSearch(search: string | undefined): string | null {
  if (!search) {
    return null;
  }

  return `%${search.trim().toUpperCase()}%`;
}

export function getMetadataToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'list_schemas',
      description: 'List visible DB2 schemas for the caller profile.',
      inputSchema: z.object({}),
      handler: async (_args, services) => withDbClient(services, async (client) => {
        const result = await client.query(`
          SELECT RTRIM(SCHEMANAME) AS SCHEMA, RTRIM(OWNER) AS OWNER, CREATE_TIME AS CREATED_AT
          FROM SYSCAT.SCHEMATA
          WHERE SCHEMANAME NOT LIKE 'SYS%'
          ORDER BY SCHEMANAME
          WITH UR
        `, [], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'list_schemas'
        });

        return {
          data: {
            schemas: result.rows
          },
          rowCount: result.rowCount
        };
      })
    },
    {
      name: 'list_tables',
      description: 'List DB2 tables and views, optionally filtered by schema or search text.',
      inputSchema: z.object({
        schema: z.string().optional(),
        search: z.string().optional()
      }),
      handler: async ({ schema, search }, services) => withDbClient(services, async (client) => {
        const pattern = toUpperSearch(search);
        const result = await client.query(`
          SELECT RTRIM(TABSCHEMA) AS SCHEMA, RTRIM(TABNAME) AS TABLE_NAME, RTRIM(TYPE) AS TABLE_TYPE, COALESCE(REMARKS, '') AS REMARKS
          FROM SYSCAT.TABLES
          WHERE (? IS NULL OR UPPER(TABSCHEMA) = ?)
            AND (? IS NULL OR UPPER(TABNAME) LIKE ? OR UPPER(COALESCE(REMARKS, '')) LIKE ?)
          ORDER BY TABSCHEMA, TABNAME
          FETCH FIRST 200 ROWS ONLY
          WITH UR
        `, [schema ? schema.toUpperCase() : null, schema ? schema.toUpperCase() : null, pattern, pattern, pattern], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'list_tables'
        });

        return {
          data: {
            tables: result.rows
          },
          rowCount: result.rowCount
        };
      })
    },
    {
      name: 'describe_table',
      description: 'Describe a DB2 table, including its columns and descriptor metadata when available.',
      inputSchema: z.object({
        schema: z.string(),
        table: z.string()
      }),
      handler: async ({ schema, table }, services) => withDbClient(services, async (client) => {
        const normalizedSchema = schema.toUpperCase();
        const normalizedTable = table.toUpperCase();
        const tableResult = await client.query(`
          SELECT RTRIM(TABSCHEMA) AS SCHEMA, RTRIM(TABNAME) AS TABLE_NAME, RTRIM(TYPE) AS TABLE_TYPE, COALESCE(REMARKS, '') AS REMARKS
          FROM SYSCAT.TABLES
          WHERE UPPER(TABSCHEMA) = ? AND UPPER(TABNAME) = ?
          FETCH FIRST 1 ROW ONLY
          WITH UR
        `, [normalizedSchema, normalizedTable], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'describe_table'
        });
        const columnResult = await client.query(`
          SELECT COLNO + 1 AS ORDINAL, RTRIM(COLNAME) AS COLUMN_NAME, RTRIM(TYPENAME) AS TYPE_NAME, LENGTH, SCALE, NULLS, DEFAULT, COALESCE(REMARKS, '') AS REMARKS
          FROM SYSCAT.COLUMNS
          WHERE UPPER(TABSCHEMA) = ? AND UPPER(TABNAME) = ?
          ORDER BY COLNO
          WITH UR
        `, [normalizedSchema, normalizedTable], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'describe_table_columns'
        });
        const descriptor = services.descriptorCatalog.getTable(normalizedSchema, normalizedTable);

        return {
          data: {
            table: tableResult.rows[0] ?? null,
            columns: columnResult.rows,
            descriptor: descriptor ?? null
          },
          rowCount: columnResult.rowCount,
          normalizedObjectNames: [`${normalizedSchema}.${normalizedTable}`]
        };
      })
    },
    {
      name: 'describe_index',
      description: 'Describe indexes for a DB2 table.',
      inputSchema: z.object({
        schema: z.string(),
        table: z.string()
      }),
      handler: async ({ schema, table }, services) => withDbClient(services, async (client) => {
        const normalizedSchema = schema.toUpperCase();
        const normalizedTable = table.toUpperCase();
        const result = await client.query(`
          SELECT RTRIM(i.INDSCHEMA) AS INDEX_SCHEMA,
                 RTRIM(i.INDNAME) AS INDEX_NAME,
                 RTRIM(i.UNIQUERULE) AS UNIQUE_RULE,
                 i.SYSTEM_REQUIRED,
                 COALESCE(i.REMARKS, '') AS REMARKS,
                 RTRIM(c.COLNAME) AS COLUMN_NAME,
                 c.COLSEQ
          FROM SYSCAT.INDEXES i
          LEFT JOIN SYSCAT.INDEXCOLUSE c
            ON i.INDSCHEMA = c.INDSCHEMA
           AND i.INDNAME = c.INDNAME
          WHERE UPPER(i.TABSCHEMA) = ? AND UPPER(i.TABNAME) = ?
          ORDER BY i.INDNAME, c.COLSEQ
          WITH UR
        `, [normalizedSchema, normalizedTable], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'describe_index'
        });

        return {
          data: {
            indexes: result.rows
          },
          rowCount: result.rowCount,
          normalizedObjectNames: [`${normalizedSchema}.${normalizedTable}`]
        };
      })
    },
    {
      name: 'get_relationships',
      description: 'Get table relationships from DB2 catalog data plus descriptor hints.',
      inputSchema: z.object({
        schema: z.string(),
        table: z.string()
      }),
      handler: async ({ schema, table }, services) => withDbClient(services, async (client) => {
        const normalizedSchema = schema.toUpperCase();
        const normalizedTable = table.toUpperCase();
        const dbRelationships = await client.query(`
          SELECT 'outgoing' AS DIRECTION,
                 RTRIM(r.TABSCHEMA) AS SOURCE_SCHEMA,
                 RTRIM(r.TABNAME) AS SOURCE_TABLE,
                 RTRIM(r.REFTABSCHEMA) AS TARGET_SCHEMA,
                 RTRIM(r.REFTABNAME) AS TARGET_TABLE,
                 RTRIM(r.CONSTNAME) AS CONSTRAINT_NAME,
                 RTRIM(k.COLNAME) AS COLUMN_NAME,
                 k.COLSEQ
          FROM SYSCAT.REFERENCES r
          LEFT JOIN SYSCAT.KEYCOLUSE k
            ON r.TABSCHEMA = k.TABSCHEMA
           AND r.CONSTNAME = k.CONSTNAME
          WHERE UPPER(r.TABSCHEMA) = ? AND UPPER(r.TABNAME) = ?
          ORDER BY r.CONSTNAME, k.COLSEQ
          WITH UR
        `, [normalizedSchema, normalizedTable], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'get_relationships'
        });
        const descriptor = services.descriptorCatalog.getTable(normalizedSchema, normalizedTable);

        return {
          data: {
            relationships: dbRelationships.rows,
            descriptorRelationships: descriptor?.relationships ?? []
          },
          rowCount: dbRelationships.rowCount,
          normalizedObjectNames: [`${normalizedSchema}.${normalizedTable}`]
        };
      })
    },
    {
      name: 'search_objects',
      description: 'Search schemas, tables, columns, procedures, and descriptor metadata.',
      inputSchema: z.object({
        query: z.string().min(1)
      }),
      handler: async ({ query }, services) => withDbClient(services, async (client) => {
        const pattern = `%${query.trim().toUpperCase()}%`;
        const result = await client.query(`
          SELECT 'schema' AS OBJECT_TYPE, RTRIM(SCHEMANAME) AS SCHEMA_NAME, NULL AS OBJECT_NAME, NULL AS DETAIL
          FROM SYSCAT.SCHEMATA
          WHERE UPPER(SCHEMANAME) LIKE ?
          UNION ALL
          SELECT 'table' AS OBJECT_TYPE, RTRIM(TABSCHEMA) AS SCHEMA_NAME, RTRIM(TABNAME) AS OBJECT_NAME, COALESCE(REMARKS, '') AS DETAIL
          FROM SYSCAT.TABLES
          WHERE UPPER(TABNAME) LIKE ? OR UPPER(COALESCE(REMARKS, '')) LIKE ?
          UNION ALL
          SELECT 'column' AS OBJECT_TYPE, RTRIM(TABSCHEMA) AS SCHEMA_NAME, RTRIM(COLNAME) AS OBJECT_NAME, RTRIM(TABNAME) AS DETAIL
          FROM SYSCAT.COLUMNS
          WHERE UPPER(COLNAME) LIKE ?
          UNION ALL
          SELECT 'procedure' AS OBJECT_TYPE, RTRIM(ROUTINESCHEMA) AS SCHEMA_NAME, RTRIM(ROUTINENAME) AS OBJECT_NAME, COALESCE(REMARKS, '') AS DETAIL
          FROM SYSCAT.ROUTINES
          WHERE ROUTINETYPE = 'P' AND (UPPER(ROUTINENAME) LIKE ? OR UPPER(COALESCE(REMARKS, '')) LIKE ?)
          FETCH FIRST 200 ROWS ONLY
          WITH UR
        `, [pattern, pattern, pattern, pattern, pattern, pattern], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'search_objects'
        });

        return {
          data: {
            objects: result.rows,
            descriptorMatches: services.descriptorCatalog.searchBusinessTerms(query)
          },
          rowCount: result.rowCount
        };
      })
    },
    {
      name: 'get_table_context',
      description: 'Get DB metadata and descriptor context for a table.',
      inputSchema: z.object({
        schema: z.string(),
        table: z.string()
      }),
      handler: async ({ schema, table }, services) => withDbClient(services, async (client) => {
        const normalizedSchema = schema.toUpperCase();
        const normalizedTable = table.toUpperCase();
        const columns = await client.query(`
          SELECT RTRIM(COLNAME) AS COLUMN_NAME, RTRIM(TYPENAME) AS TYPE_NAME, COALESCE(REMARKS, '') AS REMARKS
          FROM SYSCAT.COLUMNS
          WHERE UPPER(TABSCHEMA) = ? AND UPPER(TABNAME) = ?
          ORDER BY COLNO
          WITH UR
        `, [normalizedSchema, normalizedTable], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'get_table_context'
        });

        return {
          data: {
            schema: normalizedSchema,
            table: normalizedTable,
            descriptor: services.descriptorCatalog.getTable(normalizedSchema, normalizedTable) ?? null,
            columnSummary: columns.rows
          },
          rowCount: columns.rowCount,
          normalizedObjectNames: [`${normalizedSchema}.${normalizedTable}`]
        };
      })
    },
    {
      name: 'search_business_terms',
      description: 'Search business aliases and descriptor metadata.',
      inputSchema: z.object({
        query: z.string().min(1)
      }),
      handler: async ({ query }, services) => {
        const matches = services.descriptorCatalog.searchBusinessTerms(query);

        return {
          data: {
            matches
          },
          rowCount: matches.length
        };
      }
    },
    {
      name: 'list_join_paths',
      description: 'Return curated join hints first and DB relationships second.',
      inputSchema: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        fromSchema: z.string().optional(),
        fromTable: z.string().optional(),
        toSchema: z.string().optional(),
        toTable: z.string().optional()
      }).refine((value) => Boolean((value.from && value.to) || (value.fromSchema && value.fromTable && value.toSchema && value.toTable)), {
        message: 'Provide from/to or explicit fromSchema/fromTable/toSchema/toTable inputs.'
      }),
      handler: async (args: {
        from?: string;
        to?: string;
        fromSchema?: string;
        fromTable?: string;
        toSchema?: string;
        toTable?: string;
      }, services) => {
        const fromParts = args.from ? args.from.split('.', 2) : [args.fromSchema, args.fromTable];
        const toParts = args.to ? args.to.split('.', 2) : [args.toSchema, args.toTable];
        const [fromSchema, fromTable] = fromParts;
        const [toSchema, toTable] = toParts;

        if (!fromSchema || !fromTable || !toSchema || !toTable) {
          throw new Error('Join path inputs could not be parsed.');
        }

        return withDbClient(services, async (client) => {
          const descriptorPaths = services.descriptorCatalog.listJoinHints(fromSchema, fromTable, toSchema, toTable);
          const dbRelationships = await client.query(`
            SELECT RTRIM(TABSCHEMA) AS SOURCE_SCHEMA, RTRIM(TABNAME) AS SOURCE_TABLE, RTRIM(REFTABSCHEMA) AS TARGET_SCHEMA, RTRIM(REFTABNAME) AS TARGET_TABLE, RTRIM(CONSTNAME) AS CONSTRAINT_NAME
            FROM SYSCAT.REFERENCES
            WHERE UPPER(TABSCHEMA) = ? AND UPPER(TABNAME) = ? AND UPPER(REFTABSCHEMA) = ? AND UPPER(REFTABNAME) = ?
            WITH UR
          `, [fromSchema.toUpperCase(), fromTable.toUpperCase(), toSchema.toUpperCase(), toTable.toUpperCase()], {
            timeoutMs: services.config.limits.metadataTimeoutMs,
            label: 'list_join_paths'
          });

          return {
            data: {
              curated: descriptorPaths,
              catalogRelationships: dbRelationships.rows
            },
            rowCount: descriptorPaths.length + dbRelationships.rowCount,
            normalizedObjectNames: [
              `${fromSchema.toUpperCase()}.${fromTable.toUpperCase()}`,
              `${toSchema.toUpperCase()}.${toTable.toUpperCase()}`
            ]
          };
        });
      }
    },
    {
      name: 'preview_table',
      description: 'Preview table rows with safe quoted identifiers and capped paging.',
      inputSchema: z.object({
        schema: z.string(),
        table: z.string(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().min(0).optional()
      }),
      handler: async ({ schema, table, limit, offset }, services) => withDbClient(services, async (client) => {
        const normalizedSchema = schema.toUpperCase();
        const normalizedTable = table.toUpperCase();
        const normalizedOffset = offset ?? 0;
        const { limit: safeLimit, warnings } = normalizeLimit(limit, services.config.limits.maxRows, services.config.limits.defaultPreviewRows);
        const sql = `SELECT * FROM ${qualifyTable(normalizedSchema, normalizedTable)}`;
        const query = wrapSqlWithPaging(sql, safeLimit, normalizedOffset);
        const result = await client.query<Record<string, unknown>>(query, [], {
          timeoutMs: services.config.limits.queryTimeoutMs,
          label: 'preview_table'
        });
        const paging = buildPagingResult(result.rows, safeLimit, normalizedOffset, [...warnings, ...result.warnings]);

        return {
          data: paging,
          rowCount: paging.rowCount,
          truncated: paging.truncated,
          normalizedObjectNames: [`${normalizedSchema}.${normalizedTable}`]
        };
      })
    }
  ];
}
