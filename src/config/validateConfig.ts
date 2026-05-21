import { z } from 'zod/v4';

import {
  FUTURE_TOOL_NAMES,
  IMPLEMENTED_TOOL_NAMES,
  READONLY_TOOL_NAMES,
  PROCEDURE_TOOL_NAMES,
  TOOL_NAMES,
  type RawConfig,
  type ToolName
} from './types.js';
import { AppError } from '../errors/AppError.js';

const toolNameSchema = z.enum(TOOL_NAMES);

const rawConfigSchema = z.object({
  server: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    publicBaseUrl: z.string().url().optional(),
    readinessAuthRequired: z.boolean().optional()
  }),
  limits: z.object({
    maxRows: z.number().int().min(1).max(1000),
    defaultPreviewRows: z.number().int().min(1).max(1000),
    queryTimeoutMs: z.number().int().min(1000),
    metadataTimeoutMs: z.number().int().min(1000),
    requestBodyBytes: z.number().int().min(1024).optional()
  }),
  descriptors: z.object({
    files: z.array(z.string().min(1)).optional()
  }).optional(),
  profiles: z.record(z.string().min(1), z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(['readonly', 'readonly_procedures', 'full']),
    apiKeyEnv: z.string().min(1),
    callerLabel: z.string().min(1).optional(),
    db: z.object({
      connectionStringEnv: z.string().min(1),
      targetLabel: z.string().min(1).optional()
    }),
    tools: z.array(toolNameSchema),
    procedureAllowlist: z.array(z.object({
      schema: z.string().min(1),
      name: z.string().min(1)
    })).optional()
  }))
});

const readonlyToolSet = new Set<string>(READONLY_TOOL_NAMES);
const readonlyProcedureToolSet = new Set<string>([...READONLY_TOOL_NAMES, ...PROCEDURE_TOOL_NAMES]);
const implementedToolSet = new Set<string>(IMPLEMENTED_TOOL_NAMES);
const futureToolSet = new Set<string>(FUTURE_TOOL_NAMES);

export function validateRawConfig(rawConfig: unknown): RawConfig {
  const parsed = rawConfigSchema.safeParse(rawConfig);

  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', 'Configuration file is invalid.', 500, parsed.error.flatten());
  }

  const config = parsed.data;

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    const uniqueTools = new Set(profile.tools);
    if (uniqueTools.size !== profile.tools.length) {
      throw new AppError('CONFIG_INVALID', `Profile ${profileId} contains duplicate tool entries.`, 500);
    }

    const hasProcedureAllowlist = (profile.procedureAllowlist?.length ?? 0) > 0;

    if (profile.mode === 'readonly') {
      for (const tool of profile.tools) {
        if (!readonlyToolSet.has(tool)) {
          throw new AppError('CONFIG_INVALID', `Tool ${tool} is not allowed in readonly profile ${profileId}.`, 500);
        }
      }

      if (hasProcedureAllowlist) {
        throw new AppError('CONFIG_INVALID', `Readonly profile ${profileId} cannot define a procedure allowlist.`, 500);
      }
    }

    if (profile.mode === 'readonly_procedures') {
      for (const tool of profile.tools) {
        if (!readonlyProcedureToolSet.has(tool)) {
          throw new AppError('CONFIG_INVALID', `Tool ${tool} is not allowed in readonly_procedures profile ${profileId}.`, 500);
        }
      }
    }

    if (profile.mode === 'full') {
      for (const tool of profile.tools) {
        if (!futureToolSet.has(tool) && !implementedToolSet.has(tool)) {
          throw new AppError('CONFIG_INVALID', `Tool ${tool} is not recognized for full profile ${profileId}.`, 500);
        }
      }
    }
  }

  return config;
}

export function ensureImplementedTools(profileId: string, tools: ToolName[]): void {
  for (const tool of tools) {
    if (!implementedToolSet.has(tool)) {
      throw new AppError(
        'CONFIG_INVALID',
        `Profile ${profileId} enables ${tool}, but only Release 1 tools are implemented in this server.`,
        500
      );
    }
  }
}
