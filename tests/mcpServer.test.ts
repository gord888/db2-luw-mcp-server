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
import type { ResolvedConfig } from '../src/config/types.js';

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
  public constructor(private readonly createClient: (config: ResolvedConfig) => Db2Client) {}

  public create(config: ResolvedConfig): Db2Client {
    return this.createClient(config);
  }
}

interface ConnectedTestServer {
  auditLogger: MemoryAuditLogger;
  client: Client;
  close: () => Promise<void>;
}

function createReadonlyConfig(tools: ResolvedConfig['tools'] = ['run_query']): ResolvedConfig {
  return {
    mode: 'readonly',
    apiKey: 'readonly-key',
    apiKeyHash: 'readonly-hash',
    callerLabel: 'readonly',
    dbLabel: 'readonly-db',
    connectionString: 'DATABASE=SAMPLE;',
    tools,
    procedureAllowlist: [],
    server: {
      host: '127.0.0.1',
      port: 3000
    },
    limits: {
      maxRows: 1000,
      defaultPreviewRows: 50,
      queryTimeoutMs: 30000,
      metadataTimeoutMs: 15000,
      requestBodyBytes: 1048576
    },
    descriptorFiles: []
  };
}

function createFullConfig(tools: ResolvedConfig['tools']): ResolvedConfig {
  return {
    mode: 'full',
    apiKey: 'full-key',
    apiKeyHash: 'full-hash',
    callerLabel: 'full',
    dbLabel: 'full-db',
    connectionString: 'DATABASE=SAMPLE;',
    tools,
    procedureAllowlist: [],
    server: {
      host: '127.0.0.1',
      port: 3000
    },
    limits: {
      maxRows: 1000,
      defaultPreviewRows: 50,
      queryTimeoutMs: 30000,
      metadataTimeoutMs: 15000,
      requestBodyBytes: 1048576
    },
    descriptorFiles: []
  };
}

async function connectTestServer(config: ResolvedConfig, factory: Db2ClientFactory): Promise<ConnectedTestServer> {
  const auditLogger = new MemoryAuditLogger();
  const server = createMcpServer({
    config,
    descriptorCatalog: DescriptorCatalog.empty(),
    db2ClientFactory: factory,
    auditLogger,
    requestContext: createRequestContext(config, 'POST', '/mcp')
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
  it('lists only tools enabled for the current config', async () => {
    const connected = await connectTestServer(
      createReadonlyConfig(['run_query']),
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
      createReadonlyConfig(['run_query']),
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
      createReadonlyConfig(['run_query']),
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
      createReadonlyConfig(['run_query']),
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

  it('lists explicit full-mode DDL tools when enabled for the current config', async () => {
    const connected = await connectTestServer(
      createFullConfig(['run_ddl', 'deploy_procedure', 'drop_procedure', 'deploy_function', 'drop_function', 'deploy_view', 'drop_view']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
        columns: [],
        rows: [],
        rowCount: 0,
        warnings: []
      })))
    );
    openServers.push(connected);

    const tools = await connected.client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'run_ddl',
      'deploy_procedure',
      'drop_procedure',
      'deploy_function',
      'drop_function',
      'deploy_view',
      'drop_view'
    ]);
  });

  it('deploys and drops procedures, functions, and views in full mode', async () => {
    const executedStatements: string[] = [];
    const connected = await connectTestServer(
      createFullConfig(['run_ddl', 'deploy_procedure', 'drop_procedure', 'deploy_function', 'drop_function', 'deploy_view', 'drop_view']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async (sql) => {
        executedStatements.push(sql);

        return {
          columns: [],
          rows: [],
          rowCount: 0,
          warnings: []
        };
      }))
    );
    openServers.push(connected);

    const runDdl = await connected.client.callTool({
      name: 'run_ddl',
      arguments: {
        sql: 'ALTER VIEW APP.ACTIVE_ORDERS REGENERATE'
      }
    });
    const deployProcedure = await connected.client.callTool({
      name: 'deploy_procedure',
      arguments: {
        schema: 'app',
        procedure: 'sync_orders',
        sql: 'CREATE OR REPLACE PROCEDURE APP.SYNC_ORDERS() LANGUAGE SQL BEGIN DECLARE V_SYNC_COUNT INTEGER DEFAULT 1; END;'
      }
    });
    const dropProcedure = await connected.client.callTool({
      name: 'drop_procedure',
      arguments: {
        schema: 'app',
        procedure: 'sync_orders'
      }
    });
    const deployFunction = await connected.client.callTool({
      name: 'deploy_function',
      arguments: {
        schema: 'app',
        function: 'calc_score',
        sql: 'CREATE OR REPLACE FUNCTION APP.CALC_SCORE(P_SCORE INTEGER) RETURNS INTEGER LANGUAGE SQL RETURN P_SCORE'
      }
    });
    const dropFunction = await connected.client.callTool({
      name: 'drop_function',
      arguments: {
        schema: 'app',
        function: 'calc_score',
        parameterTypes: ['INTEGER']
      }
    });
    const deployView = await connected.client.callTool({
      name: 'deploy_view',
      arguments: {
        schema: 'app',
        view: 'active_orders',
        sql: 'CREATE OR REPLACE VIEW APP.ACTIVE_ORDERS AS SELECT 1 AS ORDER_ID FROM SYSIBM.SYSDUMMY1'
      }
    });
    const dropView = await connected.client.callTool({
      name: 'drop_view',
      arguments: {
        schema: 'app',
        view: 'active_orders'
      }
    });

    expect(parseToolText(runDdl).statementType).toBe('ALTER');
    expect(parseToolText(runDdl).sql).toBe('ALTER VIEW APP.ACTIVE_ORDERS REGENERATE');
    expect(parseToolText(deployProcedure).objectName).toBe('APP.SYNC_ORDERS');
    expect(parseToolText(dropProcedure).sql).toBe('DROP PROCEDURE "APP"."SYNC_ORDERS"');
    expect(parseToolText(deployFunction).objectName).toBe('APP.CALC_SCORE');
    expect(parseToolText(dropFunction).sql).toBe('DROP FUNCTION "APP"."CALC_SCORE"(INTEGER)');
    expect(parseToolText(deployView).objectName).toBe('APP.ACTIVE_ORDERS');
    expect(parseToolText(dropView).sql).toBe('DROP VIEW "APP"."ACTIVE_ORDERS"');
    expect(executedStatements).toEqual([
      'ALTER VIEW APP.ACTIVE_ORDERS REGENERATE',
      'CREATE OR REPLACE PROCEDURE APP.SYNC_ORDERS() LANGUAGE SQL BEGIN DECLARE V_SYNC_COUNT INTEGER DEFAULT 1; END',
      'DROP PROCEDURE "APP"."SYNC_ORDERS"',
      'CREATE OR REPLACE FUNCTION APP.CALC_SCORE(P_SCORE INTEGER) RETURNS INTEGER LANGUAGE SQL RETURN P_SCORE',
      'DROP FUNCTION "APP"."CALC_SCORE"(INTEGER)',
      'CREATE OR REPLACE VIEW APP.ACTIVE_ORDERS AS SELECT 1 AS ORDER_ID FROM SYSIBM.SYSDUMMY1',
      'DROP VIEW "APP"."ACTIVE_ORDERS"'
    ]);
  });

  it('rejects deploy SQL that does not match the requested full-mode target', async () => {
    const connected = await connectTestServer(
      createFullConfig(['deploy_procedure']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
        columns: [],
        rows: [],
        rowCount: 0,
        warnings: []
      })))
    );
    openServers.push(connected);

    const result = await connected.client.callTool({
      name: 'deploy_procedure',
      arguments: {
        schema: 'app',
        procedure: 'sync_orders',
        sql: 'CREATE OR REPLACE PROCEDURE APP.SYNC_CUSTOMERS() LANGUAGE SQL BEGIN END'
      }
    });

    expect(result.isError).toBe(true);
    expect(parseToolText(result).code).toBe('VALIDATION_ERROR');
    expect(parseToolText(result).message).toContain('APP.SYNC_CUSTOMERS');
  });

  it('rejects non-DDL statements in run_ddl', async () => {
    const connected = await connectTestServer(
      createFullConfig(['run_ddl']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(async () => ({
        columns: [],
        rows: [],
        rowCount: 0,
        warnings: []
      })))
    );
    openServers.push(connected);

    const result = await connected.client.callTool({
      name: 'run_ddl',
      arguments: {
        sql: 'select * from test_table'
      }
    });

    expect(result.isError).toBe(true);
    expect(parseToolText(result).code).toBe('VALIDATION_ERROR');
    expect(parseToolText(result).message).toContain('run_ddl only allows DDL statements');
  });

  it('allows full mode to call procedures without checking the allowlist', async () => {
    const connected = await connectTestServer(
      createFullConfig(['call_procedure']),
      new FakeDb2ClientFactory(() => new FakeDb2Client(
        async () => ({
          columns: [],
          rows: [],
          rowCount: 0,
          warnings: []
        }),
        undefined,
        async (schema, name, params) => ({
          rows: [{ STATUS: 'ok' }],
          rowCount: 1,
          outputParameters: {
            schema,
            name,
            paramCount: params.length
          },
          warnings: []
        })
      ))
    );
    openServers.push(connected);

    const result = await connected.client.callTool({
      name: 'call_procedure',
      arguments: {
        schema: 'app',
        procedure: 'non_allowlisted_proc',
        params: [123]
      }
    });

    expect(result.isError).not.toBe(true);
    expect(parseToolText(result).outputParameters).toEqual({
      schema: 'APP',
      name: 'NON_ALLOWLISTED_PROC',
      paramCount: 1
    });
  });
});
