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
  public query<T = Record<string, unknown>>(_sql: string, _params: Db2Parameter[], _options: QueryOptions): Promise<QueryResult<T>> {
    return Promise.resolve({
      columns: [],
      rows: [],
      rowCount: 0,
      warnings: []
    } as QueryResult<T>);
  }

  public callProcedure(_schema: string, _name: string, _params: Db2Parameter[], _options: QueryOptions): Promise<ProcedureResult> {
    return Promise.resolve({
      outParams: {},
      resultSets: [],
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
  public create(_profile: ResolvedProfileConfig): Db2Client {
    return new FakeDb2Client();
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

function createConfig(profile: ResolvedProfileConfig): ResolvedConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
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
    profiles: {
      [profile.id]: profile
    }
  };
}

async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const profile = createProfile();
  const server = createHttpServer({
    config: createConfig(profile),
    descriptorCatalog: DescriptorCatalog.empty(),
    db2ClientFactory: new FakeDb2ClientFactory(),
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
});
