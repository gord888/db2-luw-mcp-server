import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
import { createMcpServer } from '../src/server/mcpServer.js';
import { createRequestContext } from '../src/server/requestContext.js';
import type { ResolvedConfig, ResolvedProfileConfig } from '../src/config/types.js';

class FakeDb2Client implements Db2Client {
  public constructor(
    private readonly onQuery: (sql: string, params: Db2Parameter[], options: QueryOptions) => Promise<QueryResult<Record<string, unknown>>>,
    private readonly onExplain?: (sql: string, params: Db2Parameter[], options: QueryOptions) => Promise<ExplainResult>,
    private readonly onCallProcedure?: (schema: string, name: string, params: Db2Parameter[], options: QueryOptions) => Promise<ProcedureResult>
  ) {}

  public query<T = Record<string, unknown>>(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<QueryResult<T>> {
    return this.onQuery(sql, params, options) as Promise<QueryResult<T>>;
  }

  public callProcedure(schema: string, name: string, params: Db2Parameter[], options: QueryOptions): Promise<ProcedureResult> {
    if (!this.onCallProcedure) {
      throw new Error('callProcedure was not configured for this test.');
    }

    return this.onCallProcedure(schema, name, params, options);
  }

  public async getMetadata(_options: MetadataOptions): Promise<DatabaseMetadata> {
    return {
      schemas: [],
      tables: [],
      procedures: []
    };
  }

  public explain(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<ExplainResult> {
    if (!this.onExplain) {
      return Promise.resolve({
        statementText: sql,
        details: []
      });
    }

    return this.onExplain(sql, params, options);
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeDb2ClientFactory implements Db2ClientFactory {
  public constructor(private readonly createClient: () => Db2Client) {}

  public create(_profile: ResolvedProfileConfig): Db2Client {
    return this.createClient();
  }
}

interface ConnectedTestServer {
  auditLogger: MemoryAuditLogger;
  client: Client;
  close: () => Promise<void>;
}

function createConfig(profile: ResolvedProfileConfig): ResolvedConfig {
  return {
    configPath: '/test/config.yaml',
    server: {
      host: '127.0.0.1',
      port: 3000,
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

function createProfile(tools: ResolvedProfileConfig['tools']): ResolvedProfileConfig {
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
    tools,
    procedureAllowlist: []
  };
}

async function connectTestServer(profile: ResolvedProfileConfig, factory: Db2ClientFactory): Promise<ConnectedTestServer> {
  const config = createConfig(profile);
  const auditLogger = new MemoryAuditLogger();
  const server = createMcpServer({
    config,
    profile,
    descriptorCatalog: DescriptorCatalog.empty(),
    db2ClientFactory: factory,
    auditLogger,
    requestContext: createRequestContext(profile, 'POST', '/mcp')
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'test-client',
    version: '1.0.0'
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  return {
    auditLogger,
    client,
    close: async () => {
      await clientTransport.close();
      await serverTransport.close();
      await server.close();
    }
  };
}

function parseToolText(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const textBlock = result.content.find((block) => block.type === 'text');
  return JSON.parse(textBlock?.text ?? '{}') as Record<string, unknown>;
}

let openServers: ConnectedTestServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.map(async (server) => server.close()));
  openServers = [];
});

describe('MCP server integration', () => {
  it('lists only tools enabled for the current profile', async () => {
    const connected = await connectTestServer(
      createProfile(['run_query']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
        columns: [],
        rows: [],
        rowCount: 0,
        warnings: []
      })))
    );
    openServers.push(connected);

    const tools = await connected.client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(['run_query']);
  });

  it('emits success audit events for successful tool calls', async () => {
    const connected = await connectTestServer(
      createProfile(['run_query']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
        columns: ['ID'],
        rows: [{ ID: 1 }, { ID: 2 }],
        rowCount: 2,
        warnings: []
      })))
    );
    openServers.push(connected);

    const result = await connected.client.callTool({
      name: 'run_query',
      arguments: {
        sql: 'select * from test_table'
      }
    });

    expect(parseToolText(result).rowCount).toBe(2);
    expect(connected.auditLogger.events[0]?.outcome).toBe('success');
  });

  it('emits denied audit events for blocked read-only violations', async () => {
    const connected = await connectTestServer(
      createProfile(['run_query']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
        columns: [],
        rows: [],
        rowCount: 0,
        warnings: []
      })))
    );
    openServers.push(connected);

    const result = await connected.client.callTool({
      name: 'run_query',
      arguments: {
        sql: 'update test_table set value = 1'
      }
    });

    expect(result.isError).toBe(true);
    expect(connected.auditLogger.events[0]?.outcome).toBe('denied');
    expect(connected.auditLogger.events[0]?.errorCode).toBe('SQL_NOT_READONLY');
  });

  it('emits error audit events when the DB layer fails', async () => {
    const connected = await connectTestServer(
      createProfile(['run_query']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => {
        throw new Error('DB down');
      }))
    );
    openServers.push(connected);

    const result = await connected.client.callTool({
      name: 'run_query',
      arguments: {
        sql: 'select * from test_table'
      }
    });

    expect(result.isError).toBe(true);
    expect(connected.auditLogger.events[0]?.outcome).toBe('error');
    expect(connected.auditLogger.events[0]?.errorCode).toBe('DB_EXECUTION_FAILED');
  });
});
