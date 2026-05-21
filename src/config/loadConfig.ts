import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';

import { AppError } from '../errors/AppError.js';
import { ensureImplementedTools, validateRawConfig } from './validateConfig.js';
import type { ResolvedConfig, ResolvedProfileConfig } from './types.js';

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

interface ResolveEnvOptions {
  required?: boolean;
  fallback?: string;
}

export interface LoadConfigOptions {
  requireApiKeys?: boolean;
}

function resolveEnv(name: string, context: string, options: ResolveEnvOptions = {}): string {
  const value = process.env[name];
  if (!value) {
    if (options.required === false) {
      return options.fallback ?? '';
    }

    throw new AppError('CONFIG_INVALID', `${context} references missing environment variable ${name}.`, 500);
  }

  return value;
}

export async function loadConfig(configPath: string, options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const absolutePath = path.resolve(configPath);
  const fileContent = await readFile(absolutePath, 'utf8');
  const parsedYaml = yaml.parse(fileContent) as unknown;
  const rawConfig = validateRawConfig(parsedYaml);
  const apiKeyOwners = new Map<string, string>();
  const resolvedProfiles: Record<string, ResolvedProfileConfig> = {};
  const requireApiKeys = options.requireApiKeys ?? true;

  for (const [profileId, profile] of Object.entries(rawConfig.profiles)) {
    const enabled = profile.enabled ?? true;
    const apiKey = resolveEnv(profile.apiKeyEnv, `Profile ${profileId}`, {
      required: enabled && requireApiKeys,
      fallback: `unused-api-key-${profileId}`
    });
    const connectionString = resolveEnv(profile.db.connectionStringEnv, `Profile ${profileId}`, {
      required: enabled
    });
    const apiKeyHash = hashSecret(apiKey);

    if (enabled) {
      ensureImplementedTools(profileId, profile.tools);
    }

    const existingOwner = apiKeyOwners.get(apiKey);
    if (enabled && existingOwner) {
      throw new AppError(
        'CONFIG_INVALID',
        `Profiles ${existingOwner} and ${profileId} resolve to the same API key. API keys must map to exactly one profile.`,
        500
      );
    }

    if (enabled) {
      apiKeyOwners.set(apiKey, profileId);
    }

    resolvedProfiles[profileId] = {
      id: profileId,
      enabled,
      mode: profile.mode,
      apiKeyEnv: profile.apiKeyEnv,
      apiKey,
      apiKeyHash,
      callerLabel: profile.callerLabel,
      db: {
        connectionStringEnv: profile.db.connectionStringEnv,
        connectionString,
        targetLabel: profile.db.targetLabel ?? profileId
      },
      tools: profile.tools,
      procedureAllowlist: profile.procedureAllowlist ?? []
    };
  }

  return {
    server: {
      host: rawConfig.server.host,
      port: rawConfig.server.port,
      publicBaseUrl: rawConfig.server.publicBaseUrl,
      readinessAuthRequired: rawConfig.server.readinessAuthRequired ?? true
    },
    limits: {
      maxRows: rawConfig.limits.maxRows,
      defaultPreviewRows: rawConfig.limits.defaultPreviewRows,
      queryTimeoutMs: rawConfig.limits.queryTimeoutMs,
      metadataTimeoutMs: rawConfig.limits.metadataTimeoutMs,
      requestBodyBytes: rawConfig.limits.requestBodyBytes ?? 1024 * 1024
    },
    descriptorFiles: (rawConfig.descriptors?.files ?? []).map((file) => path.resolve(path.dirname(absolutePath), file)),
    profiles: resolvedProfiles
  };
}

export function resolveConfigPath(argv: string[]): string {
  const configArgument = argv.find((value) => value.startsWith('--config='));
  if (configArgument) {
    return configArgument.replace('--config=', '');
  }

  return process.env.DB2_MCP_CONFIG_PATH ?? path.resolve(process.cwd(), 'config', 'profiles.example.yaml');
}
