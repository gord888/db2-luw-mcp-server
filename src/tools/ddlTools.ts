import { z } from 'zod/v4';

import { normalizeIdentifier, quoteIdentifier } from '../db2/identifiers.js';
import { AppError } from '../errors/AppError.js';
import type { ToolDefinition } from './metadataTools.js';
import type { ToolServices } from './toolContext.js';
import { hashSql, withDbClient } from './toolContext.js';

const identifierSchema = z.string().min(1);
const ddlSqlSchema = z.string().min(1);
const parameterTypesSchema = z.array(z.string().min(1)).optional();
const genericDdlSchema = z.object({
  sql: ddlSqlSchema
});

const DB2_IDENTIFIER_PATTERN = '(?:"(?:[^"]|"")+"|[A-Za-z_#$@][A-Za-z0-9_#$@]*)';
const DB2_TYPE_PATTERN = /^[A-Z][A-Z0-9_(), ]*$/;
const ALLOWED_DDL_PREFIX_PATTERN = /^(CREATE|ALTER|DROP|COMMENT|RENAME)\b/iu;

type DdlObjectKind = 'PROCEDURE' | 'FUNCTION' | 'VIEW';

function normalizeDdlSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/u, '').trim();
}

function classifyDdlStatement(sql: string): string {
  const normalizedSql = normalizeDdlSql(sql);
  const match = ALLOWED_DDL_PREFIX_PATTERN.exec(normalizedSql);

  if (!match?.[1]) {
    throw new AppError(
      'VALIDATION_ERROR',
      'run_ddl only allows DDL statements that start with CREATE, ALTER, DROP, COMMENT, or RENAME.',
      400
    );
  }

  return match[1].toUpperCase();
}

function qualifyObjectName(schema: string, name: string): string {
  return `${quoteIdentifier(normalizeIdentifier(schema))}.${quoteIdentifier(normalizeIdentifier(name))}`;
}

function normalizeTarget(schema: string, name: string): { schema: string; name: string; qualifiedName: string } {
  const normalizedSchema = normalizeIdentifier(schema);
  const normalizedName = normalizeIdentifier(name);

  return {
    schema: normalizedSchema,
    name: normalizedName,
    qualifiedName: `${normalizedSchema}.${normalizedName}`
  };
}

function extractCreateTarget(kind: DdlObjectKind, sql: string): { schema: string; name: string } {
  const createTargetPattern = new RegExp(
    `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?${kind}\\s+(?:(?<schema>${DB2_IDENTIFIER_PATTERN})\\s*\\.\\s*)?(?<name>${DB2_IDENTIFIER_PATTERN})(?=\\s|\\()`,
    'iu'
  );
  const match = createTargetPattern.exec(sql);
  const schema = match?.groups?.schema;
  const name = match?.groups?.name;

  if (!schema || !name) {
    throw new AppError(
      'VALIDATION_ERROR',
      `The SQL must start with a schema-qualified CREATE or CREATE OR REPLACE ${kind} statement.`,
      400
    );
  }

  return {
    schema: normalizeIdentifier(schema),
    name: normalizeIdentifier(name)
  };
}

function assertMatchingDeploySql(kind: DdlObjectKind, schema: string, name: string, sql: string): string {
  const normalizedSql = normalizeDdlSql(sql);
  const expected = normalizeTarget(schema, name);
  const target = extractCreateTarget(kind, normalizedSql);

  if (target.schema !== expected.schema || target.name !== expected.name) {
    throw new AppError(
      'VALIDATION_ERROR',
      `The SQL targets ${target.schema}.${target.name}, but the tool call targets ${expected.qualifiedName}.`,
      400
    );
  }

  return normalizedSql;
}

function normalizeParameterType(typeName: string): string {
  const normalizedType = typeName.trim().replace(/\s+/gu, ' ').toUpperCase();

  if (!normalizedType || !DB2_TYPE_PATTERN.test(normalizedType)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Parameter type "${typeName}" contains unsupported characters. Use plain DB2 type names such as INTEGER or VARCHAR(100).`,
      400
    );
  }

  return normalizedType;
}

function buildRoutineSignature(parameterTypes: string[] | undefined): string {
  if (!parameterTypes?.length) {
    return '';
  }

  return `(${parameterTypes.map((typeName) => normalizeParameterType(typeName)).join(', ')})`;
}

async function executeDdl(
  services: ToolServices,
  sql: string,
  label: string,
  normalizedObjectName: string,
  action: 'deploy' | 'drop',
  objectType: 'procedure' | 'function' | 'view'
) {
  return withDbClient(services, async (client) => {
    await client.query(sql, [], {
      timeoutMs: services.config.limits.queryTimeoutMs,
      label
    });

    return {
      data: {
        action,
        objectType,
        objectName: normalizedObjectName,
        sql
      },
      normalizedObjectNames: [normalizedObjectName],
      sqlHash: hashSql(sql)
    };
  });
}

export function getDdlToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'run_ddl',
      description: 'Run a full-mode DDL statement such as CREATE, ALTER, DROP, COMMENT, or RENAME.',
      inputSchema: genericDdlSchema,
      handler: async ({ sql }, services) => {
        const normalizedSql = normalizeDdlSql(sql);
        const statementType = classifyDdlStatement(normalizedSql);

        return withDbClient(services, async (client) => {
          await client.query(normalizedSql, [], {
            timeoutMs: services.config.limits.queryTimeoutMs,
            label: 'run_ddl'
          });

          return {
            data: {
              action: 'run_ddl',
              statementType,
              sql: normalizedSql
            },
            sqlHash: hashSql(normalizedSql)
          };
        });
      }
    },
    {
      name: 'deploy_procedure',
      description: 'Create or replace a stored procedure in full mode. The SQL must target the same schema-qualified procedure.',
      inputSchema: z.object({
        schema: identifierSchema,
        procedure: identifierSchema,
        sql: ddlSqlSchema
      }),
      handler: async ({ schema, procedure, sql }, services) => {
        const target = normalizeTarget(schema, procedure);
        const normalizedSql = assertMatchingDeploySql('PROCEDURE', target.schema, target.name, sql);

        return executeDdl(
          services,
          normalizedSql,
          'deploy_procedure',
          target.qualifiedName,
          'deploy',
          'procedure'
        );
      }
    },
    {
      name: 'drop_procedure',
      description: 'Drop a stored procedure in full mode. Supply parameter types when the routine is overloaded.',
      inputSchema: z.object({
        schema: identifierSchema,
        procedure: identifierSchema,
        parameterTypes: parameterTypesSchema
      }),
      handler: async ({ schema, procedure, parameterTypes }, services) => {
        const target = normalizeTarget(schema, procedure);
        const sql = `DROP PROCEDURE ${qualifyObjectName(target.schema, target.name)}${buildRoutineSignature(parameterTypes)}`;

        return executeDdl(
          services,
          sql,
          'drop_procedure',
          target.qualifiedName,
          'drop',
          'procedure'
        );
      }
    },
    {
      name: 'deploy_function',
      description: 'Create or replace a function in full mode. The SQL must target the same schema-qualified function.',
      inputSchema: z.object({
        schema: identifierSchema,
        function: identifierSchema,
        sql: ddlSqlSchema
      }),
      handler: async ({ schema, function: functionName, sql }, services) => {
        const target = normalizeTarget(schema, functionName);
        const normalizedSql = assertMatchingDeploySql('FUNCTION', target.schema, target.name, sql);

        return executeDdl(
          services,
          normalizedSql,
          'deploy_function',
          target.qualifiedName,
          'deploy',
          'function'
        );
      }
    },
    {
      name: 'drop_function',
      description: 'Drop a function in full mode. Supply parameter types when the function is overloaded.',
      inputSchema: z.object({
        schema: identifierSchema,
        function: identifierSchema,
        parameterTypes: parameterTypesSchema
      }),
      handler: async ({ schema, function: functionName, parameterTypes }, services) => {
        const target = normalizeTarget(schema, functionName);
        const sql = `DROP FUNCTION ${qualifyObjectName(target.schema, target.name)}${buildRoutineSignature(parameterTypes)}`;

        return executeDdl(
          services,
          sql,
          'drop_function',
          target.qualifiedName,
          'drop',
          'function'
        );
      }
    },
    {
      name: 'deploy_view',
      description: 'Create or replace a view in full mode. The SQL must target the same schema-qualified view.',
      inputSchema: z.object({
        schema: identifierSchema,
        view: identifierSchema,
        sql: ddlSqlSchema
      }),
      handler: async ({ schema, view, sql }, services) => {
        const target = normalizeTarget(schema, view);
        const normalizedSql = assertMatchingDeploySql('VIEW', target.schema, target.name, sql);

        return executeDdl(
          services,
          normalizedSql,
          'deploy_view',
          target.qualifiedName,
          'deploy',
          'view'
        );
      }
    },
    {
      name: 'drop_view',
      description: 'Drop a view in full mode.',
      inputSchema: z.object({
        schema: identifierSchema,
        view: identifierSchema
      }),
      handler: async ({ schema, view }, services) => {
        const target = normalizeTarget(schema, view);
        const sql = `DROP VIEW ${qualifyObjectName(target.schema, target.name)}`;

        return executeDdl(
          services,
          sql,
          'drop_view',
          target.qualifiedName,
          'drop',
          'view'
        );
      }
    }
  ];
}
