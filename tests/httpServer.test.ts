import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryAuditLogger } from '../src/audit/auditLogger.js';
import type {
  DatabaseMetadata,
  Db2Client,
  Db2ClientFactory,
  Db2Parameter,
  ExplainResult,
  MetadataOptions,
  ProcedureResult,
  QueryOptions,
  QueryResult
} from '../src/db2/Db2Client.js';
import { DescriptorCatalog } from '../src/descriptors/descriptorCatalog.js';
import type { ResolvedConfig, ResolvedProfileConfig } from '../src/config/types.js';
import { createHttpServer } from '../src/server/httpServer.js';

class FakeDb2Client implements Db2Client {
  public constructor(
    private readonly onQuery: (sql: string, params: Db2Parameter[], options: QueryOptions) => Promise<QueryResult<Record<string, unknown>>>,
    private readonly onCallProcedure?: (schema: string, name: string, params: Db2Parameter[], options: QueryOptions) => Promise<ProcedureResult>
  ) {}

  public query<T = Record<string, unknown>>(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<QueryResult<T>> {
    return this.onQuery(sql, params, options) as Promise<QueryResult<T>>;
  }

  public callProcedure(schema: string, name: string, params: Db2Parameter[], options: QueryOptions): Promise<ProcedureResult> {
    if (this.onCallProcedure) {
      return this.onCallProcedure(schema, name, params, options);
    }

    return Promise.resolve({
      rows: [],
      rowCount: 0,
      outputParameters: {},
      warnings: []
    });
  }

  public async getMetadata(_options: MetadataOptions): Promise<DatabaseMetadata> {
    return {
      schemas: [],
      tables: [],
      procedures: []
    };
  }

  public explain(sql: string, _params: Db2Parameter[], _options: QueryOptions): Promise<ExplainResult> {
    return Promise.resolve({
      statementText: sql,
      details: []
    });
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeDb2ClientFactory implements Db2ClientFactory {
  public constructor(private readonly createClient: (profile: ResolvedProfileConfig) => Db2Client) {}

  public create(profile: ResolvedProfileConfig): Db2Client {
    return this.createClient(profile);
  }
}

function createProfile(): ResolvedProfileConfig {
  return {
    id: 'readonly',
    enabled: true,
    mode: 'readonly',
    apiKeyEnv: 'READONLY_KEY',
    apiKey: 'readonly-key',
    apiKeyHash: 'readonly-hash',
    callerLabel: 'readonly',
    db: {
      connectionStringEnv: 'READONLY_DB',
      connectionString: 'DATABASE=SAMPLE;',
      targetLabel: 'readonly-db'
    },
    tools: ['run_query'],
    procedureAllowlist: []
  };
}

function createConfig(profiles: ResolvedProfileConfig | ResolvedProfileConfig[]): ResolvedConfig {
  const profileList = Array.isArray(profiles) ? profiles : [profiles];

  return {
    configPath: '/test/config.yaml',
    server: {
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://db2-mcp.internal:3000',
      readinessAuthRequired: true
    },
    limits: {
      maxRows: 1000,
      defaultPreviewRows: 50,
      queryTimeoutMs: 30000,
      metadataTimeoutMs: 15000,
      requestBodyBytes: 1024 * 1024
    },
    descriptorFiles: [],
    profiles: Object.fromEntries(profileList.map((profile) => [profile.id, profile]))
  };
}

async function startTestServer(
  profiles: ResolvedProfileConfig | ResolvedProfileConfig[] = createProfile(),
  factory: Db2ClientFactory = new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
    columns: ['CURRENT_TIMESTAMP'],
    rows: [{ CURRENT_TIMESTAMP: '2026-05-22T10:00:00.000000' }],
    rowCount: 1,
    warnings: []
  })))
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer({
    config: createConfig(profiles),
    descriptorCatalog: DescriptorCatalog.empty(),
    db2ClientFactory: factory,
    auditLogger: new MemoryAuditLogger()
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

const openServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.map(async (server) => server.close()));
  openServers.length = 0;
});

describe('HTTP MCP server compatibility', () => {
  it('accepts initialize POST requests without an explicit Accept header', async () => {
    const server = await startTestServer();
    openServers.push(server);

    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer readonly-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'vitest',
            version: '1.0.0'
          }
        }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('"protocolVersion":"2024-11-05"');
  });

  it('accepts initialize POST requests on the root path as an MCP alias', async () => {
    const server = await startTestServer();
    openServers.push(server);

    const response = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer readonly-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'vitest',
            version: '1.0.0'
          }
        }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('"serverInfo":{"name":"db2-luw-mcp-server"');
  });

  it('returns public readiness details based on a real basic select check', async () => {
    const server = await startTestServer(
      createProfile(),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async (sql) => {
        expect(sql).toContain('SELECT CURRENT TIMESTAMP');
        expect(sql).toContain('SYSIBM.SYSDUMMY1');

        return {
          columns: ['CURRENT_TIMESTAMP'],
          rows: [{ CURRENT_TIMESTAMP: '2026-05-22-10.11.12.123456' }],
          rowCount: 1,
          warnings: []
        };
      }))
    );
    openServers.push(server);

    const response = await fetch(`${server.url}/readyz`);
    const payload = await response.json() as Record<string, unknown>;
    const profiles = payload.enabledProfiles as Array<Record<string, unknown>>;
    const profile = profiles[0];
    const basicSelect = profile?.basicSelect as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.status).toBe('ready');
    expect(profile?.id).toBe('readonly');
    expect(basicSelect.status).toBe('ok');
    expect(basicSelect.currentTimestamp).toBe('2026-05-22-10.11.12.123456');
  });

  it('returns a public status page with file locations and profile details', async () => {
    const server = await startTestServer(
      createProfile(),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
        columns: ['CURRENT_TIMESTAMP'],
        rows: [{ CURRENT_TIMESTAMP: '2026-05-22-10.11.12.123456' }],
        rowCount: 1,
        warnings: []
      })))
    );
    openServers.push(server);

    const response = await fetch(`${server.url}/status`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('DB2 LUW MCP Status');
    expect(body).toContain('/etc/db2-luw-mcp-server.env');
    expect(body).toContain('/etc/systemd/system/db2-luw-mcp-server.service');
    expect(body).toContain('Not enabled');
    expect(body).toContain('Not defined in active YAML');
    expect(body).toContain('readonly');
    expect(body).toContain('readonly_procedures');
    expect(body).toContain('full');
    expect(body).toContain('run_query');
    expect(body).toContain('list_procedures');
    expect(body).toContain('call_procedure');
    expect(body).toContain('CALL SYSPROC.GET_DBSIZE_INFO(?, ?, ?, -1)');
    expect(body).toContain('HEALTHCHECK_VALUE INTEGER DEFAULT 4242');
  });

  it('shows safe readonly_procedures and full-mode verification signals on the status page', async () => {
    const readonlyProceduresProfile: ResolvedProfileConfig = {
      ...createProfile(),
      id: 'readonly_procedures',
      mode: 'readonly_procedures',
      apiKeyEnv: 'READONLY_PROCEDURES_KEY',
      apiKey: 'readonly-procedures-key',
      apiKeyHash: 'readonly-procedures-hash',
      callerLabel: 'readonly_procedures',
      db: {
        connectionStringEnv: 'READONLY_PROCEDURES_DB',
        connectionString: 'DATABASE=SAMPLE;',
        targetLabel: 'readonly-procedures-db'
      },
      tools: ['run_query', 'call_procedure'],
      procedureAllowlist: [{ schema: 'APP', name: 'SAFE_REPORT_PROC' }]
    };
    const fullProfile: ResolvedProfileConfig = {
      ...createProfile(),
      id: 'full',
      mode: 'full',
      apiKeyEnv: 'FULL_KEY',
      apiKey: 'full-key',
      apiKeyHash: 'full-hash',
      callerLabel: 'full',
      db: {
        connectionStringEnv: 'FULL_DB',
        connectionString: 'DATABASE=SAMPLE;',
        targetLabel: 'full-db'
      },
      tools: [],
      procedureAllowlist: []
    };
    const server = await startTestServer(
      [readonlyProceduresProfile, fullProfile],
      new FakeDb2ClientFactory((profile) => {
        if (profile.id === 'readonly_procedures') {
          return new FakeDb2Client(
            async () => ({
              columns: ['CURRENT_TIMESTAMP'],
              rows: [{ CURRENT_TIMESTAMP: '2026-05-22-10.11.12.123456' }],
              rowCount: 1,
              warnings: []
            }),
            async (schema, name) => {
              expect(schema).toBe('SYSPROC');
              expect(name).toBe('GET_DBSIZE_INFO');

              return {
                rows: [],
                rowCount: 0,
                outputParameters: {},
                warnings: []
              };
            }
          );
        }

        return new FakeDb2Client(async (_sql, _params, options) => {
          if (options.label?.includes('routine create privilege check')) {
            return {
              columns: ['AUTH_ID', 'CURRENT_SCHEMA', 'CAN_CREATE_ROUTINE'],
              rows: [{ AUTH_ID: 'DB2USER', CURRENT_SCHEMA: 'APP', CAN_CREATE_ROUTINE: 1 }],
              rowCount: 1,
              warnings: []
            };
          }

          return {
            columns: ['CURRENT_TIMESTAMP'],
            rows: [{ CURRENT_TIMESTAMP: '2026-05-22-10.11.12.123456' }],
            rowCount: 1,
            warnings: []
          };
        });
      })
    );
    openServers.push(server);

    const response = await fetch(`${server.url}/status`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('CALL SYSPROC.GET_DBSIZE_INFO(?, ?, ?, -1) completed successfully');
    expect(body).toContain('Catalog privileges indicate DB2USER can likely create routines in schema APP');
    expect(body).toContain('HEALTHCHECK_VALUE INTEGER DEFAULT 4242');
  });

  it('marks health as degraded when the DB select check fails', async () => {
    const server = await startTestServer(
      createProfile(),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => {
        throw new Error('Database unavailable');
      }))
    );
    openServers.push(server);

    const response = await fetch(`${server.url}/healthz`);
    const payload = await response.json() as Record<string, unknown>;
    const profiles = payload.enabledProfiles as Array<Record<string, unknown>>;
    const basicSelect = profiles[0]?.basicSelect as Record<string, unknown>;
    const error = basicSelect.error as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(payload.status).toBe('degraded');
    expect(basicSelect.status).toBe('error');
    expect(error.message).toContain('Database unavailable');
  });
});
