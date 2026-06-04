import { createHash } from 'node:crypto';
import path from 'node:path';

import { parseProcedureAllowlist } from './validateConfig.js';
import { type AccessMode, type ConfigError, type ResolvedConfig, getToolsForMode } from './types.js';

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function requiredEnv(name: string, errors: ConfigError[]): string {
  const value = process.env[name];
  if (!value) {
    errors.push({ variable: name, message: `Required environment variable ${name} is not set.` });
    return '';
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function parseMode(raw: string, errors: ConfigError[]): AccessMode {
  const validModes: AccessMode[] = ['readonly', 'readonly_procedures', 'full'];
  if (!validModes.includes(raw as AccessMode)) {
    errors.push({
      variable: 'DB2_MCP_MODE',
      message: `DB2_MCP_MODE must be one of: ${validModes.join(', ')}. Got: "${raw}". Falling back to "readonly".`
    });
    return 'readonly';
  }
  return raw as AccessMode;
}

function parsePositiveInt(name: string, raw: string, errors: ConfigError[], fallback: number): number {
  if (!/^\s*\d+\s*$/.test(raw)) {
    errors.push({ variable: name, message: `${name} must be a positive integer. Got: "${raw}". Falling back to ${fallback}.` });
    return fallback;
  }
  return parseInt(raw, 10);
}

function buildConnectionString(errors: ConfigError[]): string {
  const database = process.env.DB2_MCP_CONNECTION_STRING_DATABASE;
  const hostname = process.env.DB2_MCP_CONNECTION_STRING_HOSTNAME;
  const uid = process.env.DB2_MCP_CONNECTION_STRING_UID;
  const pwd = process.env.DB2_MCP_CONNECTION_STRING_PWD;

  const anyIndividual = database || hostname || uid || pwd;

  if (anyIndividual) {
    if (!database) {
      errors.push({ variable: 'DB2_MCP_CONNECTION_STRING_DATABASE', message: 'DB2_MCP_CONNECTION_STRING_DATABASE is required when using individual connection env vars.' });
    }
    if (!hostname) {
      errors.push({ variable: 'DB2_MCP_CONNECTION_STRING_HOSTNAME', message: 'DB2_MCP_CONNECTION_STRING_HOSTNAME is required when using individual connection env vars.' });
    }
    if (!uid) {
      errors.push({ variable: 'DB2_MCP_CONNECTION_STRING_UID', message: 'DB2_MCP_CONNECTION_STRING_UID is required when using individual connection env vars.' });
    }
    if (!pwd) {
      errors.push({ variable: 'DB2_MCP_CONNECTION_STRING_PWD', message: 'DB2_MCP_CONNECTION_STRING_PWD is required when using individual connection env vars.' });
    }

    if (!database || !hostname || !uid || !pwd) {
      return '';
    }

    const port = optionalEnv('DB2_MCP_CONNECTION_STRING_PORT', '50000');
    const protocol = optionalEnv('DB2_MCP_CONNECTION_STRING_PROTOCOL', 'TCPIP');

    return `DATABASE=${database};HOSTNAME=${hostname};PORT=${port};PROTOCOL=${protocol};UID=${uid};PWD=${pwd};`;
  }

  const connString = process.env.DB2_MCP_CONNECTION_STRING;
  if (!connString) {
    errors.push({ variable: 'DB2_MCP_CONNECTION_STRING', message: 'No DB2 connection configured. Set DB2_MCP_CONNECTION_STRING or individual DB2_MCP_CONNECTION_STRING_* vars.' });
    return '';
  }

  return connString;
}

export function loadConfig(): ResolvedConfig {
  const errors: ConfigError[] = [];

  const modeRaw = requiredEnv('DB2_MCP_MODE', errors);
  const mode = parseMode(modeRaw, errors);
  const apiKey = requiredEnv('DB2_MCP_API_KEY', errors);
  const connectionString = buildConnectionString(errors);

  const descriptorFilesRaw = optionalEnv('DB2_MCP_DESCRIPTOR_FILES', '');
  const descriptorFiles = descriptorFilesRaw
    ? descriptorFilesRaw.split(',').map((f) => path.resolve(f.trim()))
    : [];

  let procedureAllowlist: ReturnType<typeof parseProcedureAllowlist>;
  try {
    procedureAllowlist = parseProcedureAllowlist(optionalEnv('DB2_MCP_PROCEDURE_ALLOWLIST', ''));
  } catch (err) {
    errors.push({ variable: 'DB2_MCP_PROCEDURE_ALLOWLIST', message: `Invalid procedure allowlist: ${err instanceof Error ? err.message : String(err)}` });
    procedureAllowlist = [];
  }

  const portRaw = optionalEnv('DB2_MCP_PORT', '3000');
  const port = parsePositiveInt('DB2_MCP_PORT', portRaw, errors, 3000);

  const maxRowsRaw = optionalEnv('DB2_MCP_MAX_ROWS', '1000');
  const maxRows = parsePositiveInt('DB2_MCP_MAX_ROWS', maxRowsRaw, errors, 1000);

  const defaultPreviewRowsRaw = optionalEnv('DB2_MCP_DEFAULT_PREVIEW_ROWS', '50');
  const defaultPreviewRows = parsePositiveInt('DB2_MCP_DEFAULT_PREVIEW_ROWS', defaultPreviewRowsRaw, errors, 50);

  const queryTimeoutRaw = optionalEnv('DB2_MCP_QUERY_TIMEOUT_MS', '30000');
  const queryTimeoutMs = parsePositiveInt('DB2_MCP_QUERY_TIMEOUT_MS', queryTimeoutRaw, errors, 30000);

  const metadataTimeoutRaw = optionalEnv('DB2_MCP_METADATA_TIMEOUT_MS', '15000');
  const metadataTimeoutMs = parsePositiveInt('DB2_MCP_METADATA_TIMEOUT_MS', metadataTimeoutRaw, errors, 15000);

  const requestBodyBytesRaw = optionalEnv('DB2_MCP_REQUEST_BODY_BYTES', '1048576');
  const requestBodyBytes = parsePositiveInt('DB2_MCP_REQUEST_BODY_BYTES', requestBodyBytesRaw, errors, 1048576);

  return {
    mode,
    apiKey,
    apiKeyHash: apiKey ? hashSecret(apiKey) : 'UNCONFIGURED',
    callerLabel: optionalEnv('DB2_MCP_CALLER_LABEL', mode),
    dbLabel: optionalEnv('DB2_MCP_DB_LABEL', mode),
    connectionString,
    tools: getToolsForMode(mode),
    procedureAllowlist,
    server: {
      host: optionalEnv('DB2_MCP_HOST', '0.0.0.0'),
      port,
      publicBaseUrl: process.env.DB2_MCP_PUBLIC_BASE_URL || undefined
    },
    limits: {
      maxRows,
      defaultPreviewRows,
      queryTimeoutMs,
      metadataTimeoutMs,
      requestBodyBytes
    },
    descriptorFiles,
    configErrors: errors
  };
}
