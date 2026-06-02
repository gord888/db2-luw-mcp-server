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
import type { ResolvedConfig } from '../src/config/types.js';
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
  public constructor(private readonly createClient: (config: ResolvedConfig) => Db2Client) {}

  public create(config: ResolvedConfig): Db2Client {
    return this.createClient(config);
  }
}

function createConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    mode: 'readonly',
    apiKey: 'readonly-key',
    apiKeyHash: 'readonly-hash',
    callerLabel: 'readonly',
    dbLabel: 'readonly-db',
    connectionString: 'DATABASE=SAMPLE;',
    tools: ['run_query'],
    procedureAllowlist: [],
    server: {
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://db2-mcp.internal:3000'
    },
    limits: {
      maxRows: 1000,
      defaultPreviewRows: 50,
      queryTimeoutMs: 30000,
      metadataTimeoutMs: 15000,
      requestBodyBytes: 1048576
    },
    descriptorFiles: [],
    ...overrides
  };
}

async function startTestServer(
  config: ResolvedConfig = createConfig(),
  factory: Db2ClientFactory = new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
    columns: ['CURRENT_TIMESTAMP'],
    rows: [{ CURRENT_TIMESTAMP: '2026-05-22T10:00:00.000000' }],
    rowCount: 1,
    warnings: []
  })))
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer({
    config,
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
      createConfig(),
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

    expect(response.status).toBe(200);
    expect(payload.status).toBe('ready');
    expect(payload.basicSelect).toBeDefined();
    expect((payload.basicSelect as Record<string, unknown>).status).toBe('ok');
    expect((payload.basicSelect as Record<string, unknown>).currentTimestamp).toBe('2026-05-22-10.11.12.123456');
  });

  it('returns a public status page with file locations and active profile details', async () => {
    const server = await startTestServer(
      createConfig(),
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
    expect(body).toContain('Active Profile');
    expect(body).toContain('readonly');
    expect(body).toContain('run_query');
  });

  it('shows readonly_procedures mode checks on the status page', async () => {
    const config = createConfig({
      mode: 'readonly_procedures',
      apiKey: 'readonly-procedures-key',
      apiKeyHash: 'readonly-procedures-hash',
      callerLabel: 'readonly_procedures',
      dbLabel: 'readonly-procedures-db',
      tools: ['run_query', 'call_procedure'],
      procedureAllowlist: [{ schema: 'SYSPROC', name: 'GET_DBSIZE_INFO' }]
    });
    const server = await startTestServer(
      config,
      new FakeDb2ClientFactory((cfg) => {
        if (cfg.mode === 'readonly_procedures') {
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

        return new FakeDb2Client(async () => ({
          columns: ['CURRENT_TIMESTAMP'],
          rows: [{ CURRENT_TIMESTAMP: '2026-05-22-10.11.12.123456' }],
          rowCount: 1,
          warnings: []
        }));
      })
    );
    openServers.push(server);

    const response = await fetch(`${server.url}/status`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Basic Select Probe');
    expect(body).toContain('Stored procedure probe');
    expect(body).toContain('Stored procedure call succeeded.');
    expect(body).toContain('SYSPROC.GET_DBSIZE_INFO');
    expect(body).toContain('CALL SYSPROC.GET_DBSIZE_INFO(?, ?, ?, -1)');
  });

  it('shows full-mode checks including create procedure probe on the status page', async () => {
    const config = createConfig({
      mode: 'full',
      apiKey: 'full-key',
      apiKeyHash: 'full-hash',
      callerLabel: 'full',
      dbLabel: 'full-db',
      tools: ['run_query', 'call_procedure', 'run_ddl', 'deploy_procedure', 'drop_procedure', 'deploy_function', 'drop_function', 'deploy_view', 'drop_view'],
      procedureAllowlist: []
    });
    const server = await startTestServer(
      config,
      new FakeDb2ClientFactory(() => new FakeDb2Client(async (_sql, _params, options) => {
        if (options.label?.includes('health_create_procedure_probe')) {
          return {
            columns: [],
            rows: [],
            rowCount: 0,
            warnings: []
          };
        }

        return {
          columns: ['CURRENT_TIMESTAMP'],
          rows: [{ CURRENT_TIMESTAMP: '2026-05-22-10.11.12.123456' }],
          rowCount: 1,
          warnings: []
        };
      }))
    );
    openServers.push(server);

    const response = await fetch(`${server.url}/status`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Create or replace procedure probe');
    expect(body).toContain('Create or replace procedure succeeded.');
    expect(body).toContain('CREATE OR REPLACE PROCEDURE DB2MCP_HEALTH_PROBE()');
    expect(body).toContain('run_ddl');
    expect(body).toContain('deploy_procedure');
    expect(body).toContain('drop_view');
  });

  it('marks health as degraded when the DB select check fails', async () => {
    const server = await startTestServer(
      createConfig(),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => {
        throw new Error('Database unavailable');
      }))
    );
    openServers.push(server);

    const response = await fetch(`${server.url}/healthz`);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(payload.status).toBe('degraded');
    expect(payload.basicSelect).toBeDefined();
    expect((payload.basicSelect as Record<string, unknown>).status).toBe('error');
    expect(((payload.basicSelect as Record<string, unknown>).error as Record<string, unknown>).message).toContain('Database unavailable');
  });
});
