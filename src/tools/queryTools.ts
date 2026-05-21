import { z } from 'zod/v4';

import { type Db2Parameter } from '../db2/Db2Client.js';
import { classifyReadOnlySql } from '../db2/sqlClassifier.js';
import { buildPagingResult, normalizeLimit, wrapSqlWithPaging } from '../db2/sqlPaging.js';
import type { ToolDefinition } from './metadataTools.js';
import type { ToolServices } from './toolContext.js';
import { hashSql, withDbClient } from './toolContext.js';

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function getQueryToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'run_query',
      description: 'Run a read-only DB2 query with enforced row caps and paging metadata.',
      inputSchema: z.object({
        sql: z.string().min(1),
        params: z.array(scalarSchema).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().min(0).optional()
      }),
      handler: async ({ sql, params, limit, offset }, services) => {
        classifyReadOnlySql(sql);
        const normalizedOffset = offset ?? 0;
        const { limit: safeLimit, warnings } = normalizeLimit(limit, services.config.limits.maxRows);
        const pagedSql = wrapSqlWithPaging(sql, safeLimit, normalizedOffset);

        return withDbClient(services, async (client) => {
          const result = await client.query<Record<string, unknown>>(pagedSql, (params ?? []) as Db2Parameter[], {
            timeoutMs: services.config.limits.queryTimeoutMs,
            label: 'run_query'
          });
          const paging = buildPagingResult(result.rows, safeLimit, normalizedOffset, [...warnings, ...result.warnings]);

          return {
            data: paging,
            rowCount: paging.rowCount,
            truncated: paging.truncated,
            sqlHash: hashSql(sql)
          };
        });
      }
    },
    {
      name: 'explain_query',
      description: 'Explain a read-only DB2 query.',
      inputSchema: z.object({
        sql: z.string().min(1),
        params: z.array(scalarSchema).optional()
      }),
      handler: async ({ sql, params }, services) => {
        classifyReadOnlySql(sql);

        return withDbClient(services, async (client) => {
          const result = await client.explain(sql, (params ?? []) as Db2Parameter[], {
            timeoutMs: services.config.limits.queryTimeoutMs,
            label: 'explain_query'
          });

          return {
            data: result,
            rowCount: result.details.length,
            sqlHash: hashSql(sql)
          };
        });
      }
    }
  ];
}
