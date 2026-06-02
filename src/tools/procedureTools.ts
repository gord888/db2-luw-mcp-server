import { z } from 'zod/v4';

import { assertProcedureAllowlisted, isProcedureAllowlisted } from '../db2/procedureAllowlist.js';
import type { Db2Parameter } from '../db2/Db2Client.js';
import type { ToolDefinition } from './metadataTools.js';
import { withDbClient } from './toolContext.js';

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function canCallProcedure(
  services: Parameters<ToolDefinition['handler']>[1],
  schema: string,
  procedure: string
): boolean {
  return services.config.mode === 'full'
    || isProcedureAllowlisted(services.config.procedureAllowlist, schema, procedure);
}

export function getProcedureToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'list_procedures',
      description: 'List stored procedures, defaulting to allowlisted procedures in procedure mode.',
      inputSchema: z.object({
        schema: z.string().optional(),
        allowedOnly: z.boolean().optional()
      }),
      handler: async ({ schema, allowedOnly }, services) => withDbClient(services, async (client) => {
        const normalizedSchema = schema?.toUpperCase();
        const result = await client.query(`
          SELECT RTRIM(ROUTINESCHEMA) AS SCHEMA, RTRIM(ROUTINENAME) AS PROCEDURE_NAME, COALESCE(REMARKS, '') AS REMARKS
          FROM SYSCAT.ROUTINES
          WHERE ROUTINETYPE = 'P'
            AND (? IS NULL OR UPPER(ROUTINESCHEMA) = ?)
          ORDER BY ROUTINESCHEMA, ROUTINENAME
          FETCH FIRST 200 ROWS ONLY
          WITH UR
        `, [normalizedSchema ?? null, normalizedSchema ?? null], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'list_procedures'
        });

        const shouldFilter = allowedOnly ?? services.config.mode === 'readonly_procedures';
        const procedures = shouldFilter
          ? result.rows.filter((row) => {
              const candidate = row as Record<string, unknown>;
              return isProcedureAllowlisted(
                services.config.procedureAllowlist,
                String(candidate.SCHEMA ?? ''),
                String(candidate.PROCEDURE_NAME ?? '')
              );
            })
          : result.rows;

        return {
          data: {
            procedures
          },
          rowCount: procedures.length
        };
      })
    },
    {
      name: 'describe_procedure',
      description: 'Describe a stored procedure and whether the current profile may call it.',
      inputSchema: z.object({
        schema: z.string(),
        procedure: z.string()
      }),
      handler: async ({ schema, procedure }, services) => withDbClient(services, async (client) => {
        const normalizedSchema = schema.toUpperCase();
        const normalizedProcedure = procedure.toUpperCase();
        const routine = await client.query(`
          SELECT RTRIM(ROUTINESCHEMA) AS SCHEMA, RTRIM(ROUTINENAME) AS PROCEDURE_NAME, SPECIFICNAME, COALESCE(REMARKS, '') AS REMARKS
          FROM SYSCAT.ROUTINES
          WHERE ROUTINETYPE = 'P'
            AND UPPER(ROUTINESCHEMA) = ?
            AND UPPER(ROUTINENAME) = ?
          FETCH FIRST 1 ROW ONLY
          WITH UR
        `, [normalizedSchema, normalizedProcedure], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'describe_procedure'
        });
        const parameters = await client.query(`
          SELECT RTRIM(PARMNAME) AS PARAMETER_NAME,
                 ROWTYPE,
                 RTRIM(TYPENAME) AS TYPE_NAME,
                 LENGTH,
                 SCALE,
                 COALESCE(REMARKS, '') AS REMARKS
          FROM SYSCAT.ROUTINEPARMS
          WHERE UPPER(ROUTINESCHEMA) = ?
            AND UPPER(ROUTINENAME) = ?
          ORDER BY ORDINAL
          WITH UR
        `, [normalizedSchema, normalizedProcedure], {
          timeoutMs: services.config.limits.metadataTimeoutMs,
          label: 'describe_procedure_params'
        });

        return {
          data: {
            procedure: routine.rows[0] ?? null,
            parameters: parameters.rows,
            allowlisted: isProcedureAllowlisted(services.config.procedureAllowlist, normalizedSchema, normalizedProcedure),
            callable: canCallProcedure(services, normalizedSchema, normalizedProcedure),
            accessPolicy: services.config.mode === 'full' ? 'unrestricted' : 'allowlist'
          },
          rowCount: parameters.rowCount,
          normalizedObjectNames: [`${normalizedSchema}.${normalizedProcedure}`]
        };
      })
    },
    {
      name: 'call_procedure',
      description: 'Call a stored procedure. readonly_procedures requires an allowlisted procedure; full mode can call any procedure.',
      inputSchema: z.object({
        schema: z.string(),
        procedure: z.string(),
        params: z.array(scalarSchema).default([])
      }),
      handler: async ({ schema, procedure, params }, services) => {
        const normalizedSchema = schema.toUpperCase();
        const normalizedProcedure = procedure.toUpperCase();
        if (services.config.mode !== 'full') {
          assertProcedureAllowlisted(services.config.procedureAllowlist, normalizedSchema, normalizedProcedure);
        }

        return withDbClient(services, async (client) => {
          const result = await client.callProcedure(normalizedSchema, normalizedProcedure, params as Db2Parameter[], {
            timeoutMs: services.config.limits.queryTimeoutMs,
            label: 'call_procedure'
          });

          return {
            data: result,
            rowCount: result.rowCount,
            normalizedObjectNames: [`${normalizedSchema}.${normalizedProcedure}`]
          };
        });
      }
    }
  ];
}
