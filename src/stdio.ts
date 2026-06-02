import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createAuditLogger, createStdioLogger } from './audit/auditLogger.js';
import { loadConfig } from './config/loadConfig.js';
import { DefaultDb2ClientFactory } from './db2/IbmDb2Client.js';
import { loadDescriptorCatalog } from './descriptors/descriptorCatalog.js';
import { createRequestContext } from './server/requestContext.js';
import { createMcpServer } from './server/mcpServer.js';

export async function main(): Promise<void> {
  const logger = createStdioLogger();
  const config = loadConfig();
  const descriptorCatalog = await loadDescriptorCatalog(config.descriptorFiles);
  const server = createMcpServer({
    config,
    descriptorCatalog,
    db2ClientFactory: new DefaultDb2ClientFactory(),
    auditLogger: createAuditLogger(logger),
    requestContext: createRequestContext(config, 'STDIO', '/stdio')
  });
  const transport = new StdioServerTransport();

  logger.info({
    eventType: 'startup',
    transport: 'stdio',
    mode: config.mode
  }, 'DB2 LUW MCP stdio server listening');

  await server.connect(transport);
}

function isExecutedDirectly(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isExecutedDirectly()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
