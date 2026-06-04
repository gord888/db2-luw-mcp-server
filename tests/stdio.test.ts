import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/loadConfig.js';

const trackedEnv = [
  'DB2_MCP_MODE',
  'DB2_MCP_API_KEY',
  'DB2_MCP_CONNECTION_STRING',
  'DB2_MCP_CONNECTION_STRING_DATABASE',
  'DB2_MCP_CONNECTION_STRING_HOSTNAME',
  'DB2_MCP_CONNECTION_STRING_PORT',
  'DB2_MCP_CONNECTION_STRING_PROTOCOL',
  'DB2_MCP_CONNECTION_STRING_UID',
  'DB2_MCP_CONNECTION_STRING_PWD'
] as const;

afterEach(() => {
  for (const key of trackedEnv) {
    delete process.env[key];
  }
});

describe('stdio config resolution', () => {
  it('loads config from env vars without requiring --profile arg', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.mode).toBe('readonly');
    expect(config.apiKey).toBe('readonly-key');
    expect(config.connectionString).toBe('DATABASE=SAMPLE;');
  });

  it('loads full mode when DB2_MCP_MODE is full', () => {
    process.env.DB2_MCP_MODE = 'full';
    process.env.DB2_MCP_API_KEY = 'full-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.mode).toBe('full');
    expect(config.tools).toContain('run_ddl');
  });

  it('loads readonly_procedures mode with procedure tools', () => {
    process.env.DB2_MCP_MODE = 'readonly_procedures';
    process.env.DB2_MCP_API_KEY = 'readonly-procedures-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.mode).toBe('readonly_procedures');
    expect(config.tools).toContain('call_procedure');
    expect(config.tools).not.toContain('run_ddl');
  });

  it('returns config errors when mode env var is not set', () => {
    process.env.DB2_MCP_API_KEY = 'key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.configErrors).not.toHaveLength(0);
    expect(config.configErrors.some((e) => e.variable === 'DB2_MCP_MODE')).toBe(true);
    expect(config.mode).toBe('readonly');
  });
});
