import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/loadConfig.js';

const trackedEnv = [
  'DB2_MCP_API_KEY_READONLY',
  'DB2_MCP_DB_READONLY',
  'DB2_MCP_API_KEY_FULL',
  'DB2_MCP_DB_FULL'
] as const;

afterEach(() => {
  for (const key of trackedEnv) {
    delete process.env[key];
  }
});

describe('loadConfig', () => {
  it('loads env-backed secrets and resolves defaults', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'db2-mcp-config-'));
    const configPath = path.join(tempDirectory, 'config.yaml');

    process.env.DB2_MCP_API_KEY_READONLY = 'readonly-key';
    process.env.DB2_MCP_DB_READONLY = 'DATABASE=SAMPLE;';

    await writeFile(configPath, `
server:
  host: "127.0.0.1"
  port: 3000
limits:
  maxRows: 1000
  defaultPreviewRows: 50
  queryTimeoutMs: 30000
  metadataTimeoutMs: 15000
profiles:
  readonly:
    mode: "readonly"
    apiKeyEnv: "DB2_MCP_API_KEY_READONLY"
    db:
      connectionStringEnv: "DB2_MCP_DB_READONLY"
    tools:
      - "run_query"
`, 'utf8');

    const config = await loadConfig(configPath);

    expect(config.server.readinessAuthRequired).toBe(true);
    expect(config.limits.requestBodyBytes).toBe(1024 * 1024);
    expect(config.profiles.readonly.apiKey).toBe('readonly-key');
    expect(config.profiles.readonly.db.connectionString).toBe('DATABASE=SAMPLE;');
    expect(config.profiles.readonly.db.targetLabel).toBe('readonly');
  });

  it('does not require secrets for disabled profiles', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'db2-mcp-config-'));
    const configPath = path.join(tempDirectory, 'config.yaml');

    process.env.DB2_MCP_API_KEY_READONLY = 'readonly-key';
    process.env.DB2_MCP_DB_READONLY = 'DATABASE=SAMPLE;';

    await writeFile(configPath, `
server:
  host: "127.0.0.1"
  port: 3000
limits:
  maxRows: 1000
  defaultPreviewRows: 50
  queryTimeoutMs: 30000
  metadataTimeoutMs: 15000
profiles:
  readonly:
    mode: "readonly"
    apiKeyEnv: "DB2_MCP_API_KEY_READONLY"
    db:
      connectionStringEnv: "DB2_MCP_DB_READONLY"
    tools:
      - "run_query"
  full:
    enabled: false
    mode: "full"
    apiKeyEnv: "DB2_MCP_API_KEY_FULL"
    db:
      connectionStringEnv: "DB2_MCP_DB_FULL"
    tools: []
`, 'utf8');

    const config = await loadConfig(configPath);

    expect(config.profiles.full.enabled).toBe(false);
    expect(config.profiles.full.apiKey).toBe('unused-api-key-full');
    expect(config.profiles.full.db.connectionString).toBe('');
  });

  it('can load stdio config without api key env vars', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'db2-mcp-config-'));
    const configPath = path.join(tempDirectory, 'config.yaml');

    process.env.DB2_MCP_DB_READONLY = 'DATABASE=SAMPLE;';

    await writeFile(configPath, `
server:
  host: "127.0.0.1"
  port: 3000
limits:
  maxRows: 1000
  defaultPreviewRows: 50
  queryTimeoutMs: 30000
  metadataTimeoutMs: 15000
profiles:
  readonly:
    mode: "readonly"
    apiKeyEnv: "DB2_MCP_API_KEY_READONLY"
    db:
      connectionStringEnv: "DB2_MCP_DB_READONLY"
    tools:
      - "run_query"
`, 'utf8');

    const config = await loadConfig(configPath, {
      requireApiKeys: false
    });

    expect(config.profiles.readonly.apiKey).toBe('unused-api-key-readonly');
    expect(config.profiles.readonly.db.connectionString).toBe('DATABASE=SAMPLE;');
  });

  it('loads implemented full-mode DDL tools for enabled full profiles', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'db2-mcp-config-'));
    const configPath = path.join(tempDirectory, 'config.yaml');

    process.env.DB2_MCP_API_KEY_FULL = 'full-key';
    process.env.DB2_MCP_DB_FULL = 'DATABASE=SAMPLE;';

    await writeFile(configPath, `
server:
  host: "127.0.0.1"
  port: 3000
limits:
  maxRows: 1000
  defaultPreviewRows: 50
  queryTimeoutMs: 30000
  metadataTimeoutMs: 15000
profiles:
  full:
    mode: "full"
    apiKeyEnv: "DB2_MCP_API_KEY_FULL"
    db:
      connectionStringEnv: "DB2_MCP_DB_FULL"
    tools:
      - "run_query"
      - "run_ddl"
      - "deploy_view"
      - "drop_view"
`, 'utf8');

    const config = await loadConfig(configPath);

    expect(config.profiles.full.tools).toEqual(['run_query', 'run_ddl', 'deploy_view', 'drop_view']);
  });
});
