import { createHash } from 'node:crypto';
import path from 'node:path';

import { AppError } from '../errors/AppError.js';
import { parseProcedureAllowlist } from './validateConfig.js';
import { type AccessMode, type ResolvedConfig, getToolsForMode } from './types.js';

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError('CONFIG_INVALID', `Required environment variable ${name} is not set.`, 500);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function parseMode(raw: string): AccessMode {
  const validModes: AccessMode[] = ['readonly', 'readonly_procedures', 'full'];
  if (!validModes.includes(raw as AccessMode)) {
    throw new AppError(
      'CONFIG_INVALID',
      `DB2_MCP_MODE must be one of: ${validModes.join(', ')}. Got: ${raw}`,
      500
    );
  }
  return raw as AccessMode;
}

export function loadConfig(): ResolvedConfig {
  const mode = parseMode(requiredEnv('DB2_MCP_MODE'));
  const apiKey = requiredEnv('DB2_MCP_API_KEY');
  const connectionString = requiredEnv('DB2_MCP_CONNECTION_STRING');

  const descriptorFilesRaw = optionalEnv('DB2_MCP_DESCRIPTOR_FILES', '');
  const descriptorFiles = descriptorFilesRaw
    ? descriptorFilesRaw.split(',').map((f) => path.resolve(f.trim()))
    : [];

  const procedureAllowlistRaw = optionalEnv('DB2_MCP_PROCEDURE_ALLOWLIST', '');
  const procedureAllowlist = procedureAllowlistRaw
    ? parseProcedureAllowlist(procedureAllowlistRaw)
    : [];

  return {
    mode,
    apiKey,
    apiKeyHash: hashSecret(apiKey),
    callerLabel: optionalEnv('DB2_MCP_CALLER_LABEL', mode),
    dbLabel: optionalEnv('DB2_MCP_DB_LABEL', mode),
    connectionString,
    tools: getToolsForMode(mode),
    procedureAllowlist,
    server: {
      host: optionalEnv('DB2_MCP_HOST', '0.0.0.0'),
      port: parseInt(optionalEnv('DB2_MCP_PORT', '3000'), 10),
      publicBaseUrl: process.env.DB2_MCP_PUBLIC_BASE_URL || undefined
    },
    limits: {
      maxRows: parseInt(optionalEnv('DB2_MCP_MAX_ROWS', '1000'), 10),
      defaultPreviewRows: parseInt(optionalEnv('DB2_MCP_DEFAULT_PREVIEW_ROWS', '50'), 10),
      queryTimeoutMs: parseInt(optionalEnv('DB2_MCP_QUERY_TIMEOUT_MS', '30000'), 10),
      metadataTimeoutMs: parseInt(optionalEnv('DB2_MCP_METADATA_TIMEOUT_MS', '15000'), 10),
      requestBodyBytes: parseInt(optionalEnv('DB2_MCP_REQUEST_BODY_BYTES', '1048576'), 10)
    },
    descriptorFiles
  };
}
