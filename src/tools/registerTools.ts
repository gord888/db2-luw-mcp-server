import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { IMPLEMENTED_TOOL_NAMES, type ImplementedToolName } from '../config/types.js';
import { AppError } from '../errors/AppError.js';
import { isDeniedError, toAppError, toErrorPayload } from '../errors/errorMapper.js';
import { getDdlToolDefinitions } from './ddlTools.js';
import { getMetadataToolDefinitions, type ToolDefinition } from './metadataTools.js';
import { getProcedureToolDefinitions } from './procedureTools.js';
import { getQueryToolDefinitions } from './queryTools.js';
import type { ToolExecutionPayload, ToolServices } from './toolContext.js';
import { createToolTextPayload } from './toolContext.js';

const implementedToolSet = new Set<string>(IMPLEMENTED_TOOL_NAMES);

function toContentBlocks(data: unknown) {
  return [
    {
      type: 'text' as const,
      text: createToolTextPayload(data)
    }
  ];
}

function registerToolDefinition(
  server: McpServer,
  definition: ToolDefinition,
  services: ToolServices
): void {
  server.registerTool(definition.name, {
    description: definition.description,
    inputSchema: definition.inputSchema.shape
  }, async (args: unknown, _extra: unknown): Promise<CallToolResult> => {
    const startedAt = Date.now();

    try {
      const payload = await definition.handler(args, services);

      services.auditLogger.logToolEvent({
        timestamp: new Date().toISOString(),
        requestId: services.requestContext.requestId,
        profileId: services.profile.id,
        mode: services.profile.mode,
        toolName: definition.name,
        dbTarget: services.profile.db.targetLabel,
        normalizedObjectNames: payload.normalizedObjectNames,
        sqlHash: payload.sqlHash,
        rowCount: payload.rowCount,
        truncated: payload.truncated,
        durationMs: Date.now() - startedAt,
        outcome: 'success'
      });

      return {
        content: toContentBlocks(payload.data)
      };
    } catch (error) {
      const appError = toAppError(error);
      services.auditLogger.logToolEvent({
        timestamp: new Date().toISOString(),
        requestId: services.requestContext.requestId,
        profileId: services.profile.id,
        mode: services.profile.mode,
        toolName: definition.name,
        dbTarget: services.profile.db.targetLabel,
        durationMs: Date.now() - startedAt,
        outcome: isDeniedError(appError) ? 'denied' : 'error',
        errorCode: appError.code
      });

      return {
        isError: true,
        content: toContentBlocks(toErrorPayload(appError, services.requestContext.requestId))
      };
    }
  });
}

export function registerTools(server: McpServer, services: ToolServices): void {
  const definitions = [
    ...getMetadataToolDefinitions(),
    ...getQueryToolDefinitions(),
    ...getProcedureToolDefinitions(),
    ...getDdlToolDefinitions()
  ];

  const definitionMap = new Map(definitions.map((definition) => [definition.name, definition]));

  for (const toolName of services.profile.tools) {
    if (!implementedToolSet.has(toolName)) {
      throw new AppError('TOOL_NOT_ALLOWED', `Tool ${toolName} is not implemented in this build.`, 500);
    }

    const definition = definitionMap.get(toolName as ImplementedToolName);
    if (!definition) {
      throw new AppError('TOOL_NOT_ALLOWED', `Tool ${toolName} is not registered.`, 500);
    }

    registerToolDefinition(server, definition, services);
  }
}
