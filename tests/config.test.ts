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
  'DB2_MCP_CONNECTION_STRING_PWD',
  'DB2_MCP_CALLER_LABEL',
  'DB2_MCP_DB_LABEL',
  'DB2_MCP_HOST',
  'DB2_MCP_PORT',
  'DB2_MCP_PUBLIC_BASE_URL',
  'DB2_MCP_MAX_ROWS',
  'DB2_MCP_DEFAULT_PREVIEW_ROWS',
  'DB2_MCP_QUERY_TIMEOUT_MS',
  'DB2_MCP_METADATA_TIMEOUT_MS',
  'DB2_MCP_REQUEST_BODY_BYTES',
  'DB2_MCP_DESCRIPTOR_FILES',
  'DB2_MCP_PROCEDURE_ALLOWLIST'
] as const;

afterEach(() => {
  for (const key of trackedEnv) {
    delete process.env[key];
  }
});

describe('loadConfig', () => {
  it('loads required env vars and resolves defaults for readonly mode', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.mode).toBe('readonly');
    expect(config.apiKey).toBe('readonly-key');
    expect(config.apiKeyHash).toBeTruthy();
    expect(config.connectionString).toBe('DATABASE=SAMPLE;');
    expect(config.callerLabel).toBe('readonly');
    expect(config.dbLabel).toBe('readonly');
    expect(config.tools).toContain('run_query');
    expect(config.procedureAllowlist).toEqual([]);
    expect(config.descriptorFiles).toEqual([]);
  });

  it('uses defaults for optional fields', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.port).toBe(3000);
    expect(config.server.publicBaseUrl).toBeUndefined();
    expect(config.limits.maxRows).toBe(1000);
    expect(config.limits.defaultPreviewRows).toBe(50);
    expect(config.limits.queryTimeoutMs).toBe(30000);
    expect(config.limits.metadataTimeoutMs).toBe(15000);
    expect(config.limits.requestBodyBytes).toBe(1048576);
  });

  it('overrides optional fields from env vars', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';
    process.env.DB2_MCP_CALLER_LABEL = 'custom-caller';
    process.env.DB2_MCP_DB_LABEL = 'custom-db';
    process.env.DB2_MCP_HOST = '192.168.1.1';
    process.env.DB2_MCP_PORT = '8080';
    process.env.DB2_MCP_PUBLIC_BASE_URL = 'https://db2-mcp.example.com';
    process.env.DB2_MCP_MAX_ROWS = '500';
    process.env.DB2_MCP_DEFAULT_PREVIEW_ROWS = '25';
    process.env.DB2_MCP_QUERY_TIMEOUT_MS = '60000';
    process.env.DB2_MCP_METADATA_TIMEOUT_MS = '30000';
    process.env.DB2_MCP_REQUEST_BODY_BYTES = '2097152';

    const config = loadConfig();

    expect(config.callerLabel).toBe('custom-caller');
    expect(config.dbLabel).toBe('custom-db');
    expect(config.server.host).toBe('192.168.1.1');
    expect(config.server.port).toBe(8080);
    expect(config.server.publicBaseUrl).toBe('https://db2-mcp.example.com');
    expect(config.limits.maxRows).toBe(500);
    expect(config.limits.defaultPreviewRows).toBe(25);
    expect(config.limits.queryTimeoutMs).toBe(60000);
    expect(config.limits.metadataTimeoutMs).toBe(30000);
    expect(config.limits.requestBodyBytes).toBe(2097152);
  });

  it('loads full mode with DDL tools', () => {
    process.env.DB2_MCP_MODE = 'full';
    process.env.DB2_MCP_API_KEY = 'full-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.mode).toBe('full');
    expect(config.tools).toEqual(expect.arrayContaining(['run_ddl', 'deploy_view', 'drop_view', 'deploy_procedure']));
  });

  it('loads readonly_procedures mode with procedure tools', () => {
    process.env.DB2_MCP_MODE = 'readonly_procedures';
    process.env.DB2_MCP_API_KEY = 'procedures-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.mode).toBe('readonly_procedures');
    expect(config.tools).toEqual(expect.arrayContaining(['run_query', 'call_procedure', 'list_procedures']));
    expect(config.tools).not.toContain('run_ddl');
  });

  it('parses procedure allowlist from env var', () => {
    process.env.DB2_MCP_MODE = 'readonly_procedures';
    process.env.DB2_MCP_API_KEY = 'procedures-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';
    process.env.DB2_MCP_PROCEDURE_ALLOWLIST = 'SYSPROC.GET_DBSIZE_INFO,APP.SAFE_PROC';

    const config = loadConfig();

    expect(config.procedureAllowlist).toEqual([
      { schema: 'SYSPROC', name: 'GET_DBSIZE_INFO' },
      { schema: 'APP', name: 'SAFE_PROC' }
    ]);
  });

  it('parses descriptor files from env var', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';
    process.env.DB2_MCP_DESCRIPTOR_FILES = '/etc/descriptors.yaml,/opt/extra.yaml';

    const config = loadConfig();

    expect(config.descriptorFiles).toHaveLength(2);
    expect(config.descriptorFiles[0]).toContain('descriptors.yaml');
    expect(config.descriptorFiles[1]).toContain('extra.yaml');
  });

  it('returns config errors when required env vars are missing', () => {
    const config = loadConfig();

    expect(config.configErrors).not.toHaveLength(0);
    const errorVars = config.configErrors.map((e) => e.variable);
    expect(errorVars).toContain('DB2_MCP_MODE');
    expect(errorVars).toContain('DB2_MCP_API_KEY');
    expect(errorVars).toContain('DB2_MCP_CONNECTION_STRING');
    expect(config.mode).toBe('readonly');
    expect(config.apiKey).toBe('');
    expect(config.connectionString).toBe('');
  });

  it('builds connection string from individual env vars with defaults', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING_DATABASE = 'SAMPLE';
    process.env.DB2_MCP_CONNECTION_STRING_HOSTNAME = 'db2.internal';
    process.env.DB2_MCP_CONNECTION_STRING_UID = 'db2_mcp';
    process.env.DB2_MCP_CONNECTION_STRING_PWD = 'secret';

    const config = loadConfig();

    expect(config.connectionString).toBe(
      'DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp;PWD=secret;'
    );
  });

  it('uses individual vars with custom port and protocol', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING_DATABASE = 'PRODDB';
    process.env.DB2_MCP_CONNECTION_STRING_HOSTNAME = 'db2.prod.internal';
    process.env.DB2_MCP_CONNECTION_STRING_PORT = '50001';
    process.env.DB2_MCP_CONNECTION_STRING_PROTOCOL = 'TCP';
    process.env.DB2_MCP_CONNECTION_STRING_UID = 'admin';
    process.env.DB2_MCP_CONNECTION_STRING_PWD = 'admin-secret';

    const config = loadConfig();

    expect(config.connectionString).toBe(
      'DATABASE=PRODDB;HOSTNAME=db2.prod.internal;PORT=50001;PROTOCOL=TCP;UID=admin;PWD=admin-secret;'
    );
  });

  it('falls back to DB2_MCP_CONNECTION_STRING when individual vars not set', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=LEGACY;HOSTNAME=old.internal;PORT=12345;PROTOCOL=TCPIP;UID=old;PWD=old;';

    const config = loadConfig();

    expect(config.connectionString).toBe(
      'DATABASE=LEGACY;HOSTNAME=old.internal;PORT=12345;PROTOCOL=TCPIP;UID=old;PWD=old;'
    );
  });

  it('individual vars take precedence over DB2_MCP_CONNECTION_STRING', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=legacy;';
    process.env.DB2_MCP_CONNECTION_STRING_DATABASE = 'NEWDB';
    process.env.DB2_MCP_CONNECTION_STRING_HOSTNAME = 'new.internal';
    process.env.DB2_MCP_CONNECTION_STRING_UID = 'newuser';
    process.env.DB2_MCP_CONNECTION_STRING_PWD = 'newpass';

    const config = loadConfig();

    expect(config.connectionString).toBe(
      'DATABASE=NEWDB;HOSTNAME=new.internal;PORT=50000;PROTOCOL=TCPIP;UID=newuser;PWD=newpass;'
    );
  });

  it('returns config errors when individual vars are partially set', () => {
    process.env.DB2_MCP_MODE = 'readonly';
    process.env.DB2_MCP_API_KEY = 'readonly-key';
    process.env.DB2_MCP_CONNECTION_STRING_DATABASE = 'SAMPLE';
    // missing HOSTNAME, UID, PWD

    const config = loadConfig();

    expect(config.configErrors).not.toHaveLength(0);
    const errorVars = config.configErrors.map((e) => e.variable);
    expect(errorVars).toContain('DB2_MCP_CONNECTION_STRING_HOSTNAME');
    expect(errorVars).toContain('DB2_MCP_CONNECTION_STRING_UID');
    expect(errorVars).toContain('DB2_MCP_CONNECTION_STRING_PWD');
    expect(config.connectionString).toBe('');
  });

  it('returns config error for invalid mode and falls back to readonly', () => {
    process.env.DB2_MCP_MODE = 'superadmin';
    process.env.DB2_MCP_API_KEY = 'key';
    process.env.DB2_MCP_CONNECTION_STRING = 'DATABASE=SAMPLE;';

    const config = loadConfig();

    expect(config.configErrors).toHaveLength(1);
    expect(config.configErrors[0]?.variable).toBe('DB2_MCP_MODE');
    expect(config.mode).toBe('readonly');
    expect(config.tools).toContain('run_query');
    expect(config.tools).not.toContain('run_ddl');
  });
});
